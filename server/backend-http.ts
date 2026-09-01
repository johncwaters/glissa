import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream';
import express from 'express';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { Session } from '../session/sessions.ts';
import { decideHostAllowed } from './core/host-policy.ts';
import { decideOriginAllowed } from './core/origin-policy.ts';
import { configSiblingPath } from './pairings-store.ts';
import {
  buildUploadFilename,
  decideUploadType,
  exceedsUploadCap,
  framePathPaste,
  isSafePathSegment,
  planUploadRetention,
} from './core/upload-core.ts';

interface HookRouterOutput {
  status: number;
  reason: string;
}

interface BackendHttpDependencies {
  staticDir: string | null;
  configStore: { configPath: string };
  remote: { allowedOrigins: string[] };
  remoteAuth: { httpMiddleware: RequestHandler; mountPairRoutes: (app: Express) => void } | null;
  allowedHosts: string[];
  listenerPortsFor: (socket: { localPort?: number | null } | null) => number[];
  pageToken: string;
  hookRouter: { handle: (input: Record<string, unknown>) => HookRouterOutput };
  getSession: (id: string) => Session | null;
  getUsage: () => { ingestStatusline: (payload: object) => void };
}

function isPackNoticeHookEvent(event: unknown, session: Session | null): boolean {
  const declaredEvent = session?.packNoticeHookEvent;
  if (!declaredEvent) return false;
  return String(event || '').toLowerCase() === declaredEvent.toLowerCase();
}

function isStatuslineEvent(event: unknown): boolean {
  return String(event || '').toLowerCase() === 'statusline';
}

async function sweepSessionUploads(dir: string, justWritten: string): Promise<void> {
  let entries: string[] | null = null;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }
  for (const name of planUploadRetention(entries, { justWritten })) {
    try {
      await fsp.unlink(path.join(dir, name));
    } catch {}
  }
}

function receiveUpload({ req, res, sess, dir, filename, savedPath }: {
  req: Request;
  res: Response;
  sess: Session;
  dir: string;
  filename: string;
  savedPath: string;
}): void {
  const writeStream = fs.createWriteStream(savedPath);
  let bytesReceived = 0;
  let settled = false;

  const answer = (status: number, body: Record<string, unknown>) => {
    if (settled) return;
    settled = true;
    if (!res.headersSent) res.status(status).json(body);
  };
  let discardWanted = false;
  let streamClosed = false;
  const unlinkPartial = () => {
    fsp.unlink(savedPath).catch(() => {});
  };
  const discardPartial = () => {
    discardWanted = true;
    if (streamClosed) unlinkPartial();
  };
  writeStream.on('close', () => {
    streamClosed = true;
    if (discardWanted) unlinkPartial();
  });
  writeStream.on('error', () => {
    answer(500, { error: 'could not store the upload' });
    discardPartial();
  });
  req.on('data', (chunk: Buffer) => {
    bytesReceived += chunk.length;
    if (!exceedsUploadCap(bytesReceived)) return;
    answer(413, { error: 'image is too large' });
    req.destroy();
    writeStream.destroy();
    discardPartial();
  });
  pipeline(req, writeStream, (error) => {
    if (error) {
      answer(400, { error: 'upload failed' });
      discardPartial();
      return;
    }
    if (settled) {
      discardPartial();
      return;
    }
    if (!sess.hasLivePty) {
      answer(409, { error: 'session has no live terminal' });
      discardPartial();
      return;
    }
    sess.write(framePathPaste(savedPath));
    answer(200, { ok: true, path: savedPath });
    void sweepSessionUploads(dir, filename);
  });
}

function createBackendHttpApp(dependencies: BackendHttpDependencies): Express {
  const {
    staticDir,
    configStore,
    remote,
    remoteAuth,
    allowedHosts,
    listenerPortsFor,
    pageToken,
    hookRouter,
    getSession,
    getUsage,
  } = dependencies;
  const app = express();

  app.use((req, res, next) => {
    if (decideHostAllowed(req.headers.host, allowedHosts)) {
      next();
      return;
    }
    res.status(403).type('text/plain').send('Host not allowed');
  });

  if (remoteAuth) {
    app.use(remoteAuth.httpMiddleware);
    remoteAuth.mountPairRoutes(app);
  }

  app.get('/control-token', (req, res) => {
    const origin = req.headers.origin;
    if (origin && !decideOriginAllowed(origin, remote.allowedOrigins, { listenerPorts: listenerPortsFor(req.socket) })) {
      res.status(403).json({ error: 'origin not allowed' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ token: pageToken });
  });

  app.post('/hook/:glissaId/:event', (req, res) => {
    const ip = req.socket.remoteAddress || '';
    if (!(ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')) {
      res.status(403).end();
      return;
    }
    let body = '';
    let aborted = false;
    req.on('error', () => { aborted = true; });
    req.on('data', (chunk: Buffer) => {
      body += chunk;
      if (body.length <= 65536) return;
      aborted = true;
      req.destroy();
    });
    req.on('end', () => {
      if (aborted) return;
      let payload: Record<string, unknown> = {};
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {}
      const token = req.query?.t || (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;
      const output = hookRouter.handle({
        glissaId: req.params.glissaId,
        event: req.params.event,
        token,
        payload,
      });
      if (output.status === 200 && isStatuslineEvent(req.params.event)) {
        getUsage().ingestStatusline(payload);
      }
      const reply: Record<string, unknown> = { ok: output.status === 200, reason: output.reason };
      const hookSession = getSession(req.params.glissaId);
      const packNotice = output.status === 200 && isPackNoticeHookEvent(req.params.event, hookSession)
        ? hookSession?.takePackNoticeContext() || null
        : null;
      if (packNotice) {
        reply.hookSpecificOutput = {
          hookEventName: hookSession?.packNoticeHookEvent,
          additionalContext: packNotice,
        };
      }
      res.status(output.status).json(reply);
    });
  });

  const uploadsRoot = configSiblingPath(configStore.configPath, 'uploads');
  app.post('/upload/:sessionId', (req, res) => {
    const sess = getSession(req.params.sessionId);
    if (!sess || !isSafePathSegment(sess.id)) {
      res.status(404).json({ error: 'unknown session' });
      return;
    }
    const typeVerdict = decideUploadType(req.headers['content-type']);
    if (!typeVerdict.ok) {
      res.status(typeVerdict.status).json({ error: typeVerdict.error });
      return;
    }
    if (!sess.hasLivePty) {
      res.status(409).json({ error: 'session has no live terminal' });
      return;
    }

    const dir = path.join(uploadsRoot, sess.id);
    const filename = buildUploadFilename({
      now: Date.now(),
      randomSuffix: crypto.randomBytes(4).toString('hex'),
      extension: typeVerdict.extension,
    });
    const savedPath = path.join(dir, filename);
    let abortedBeforeReceive = false;
    const markAbortedBeforeReceive = () => { abortedBeforeReceive = true; };
    req.on('error', markAbortedBeforeReceive);
    fsp.mkdir(dir, { recursive: true, mode: 0o700 })
      .then(() => {
        if (abortedBeforeReceive || req.destroyed) return;
        req.off('error', markAbortedBeforeReceive);
        receiveUpload({ req, res, sess, dir, filename, savedPath });
      })
      .catch(() => {
        if (!res.headersSent) res.status(500).json({ error: 'could not store the upload' });
      });
  });

  if (staticDir === 'auto') {
    const clientDir = path.join(import.meta.dirname, '..', 'dist', 'client');
    if (!fs.existsSync(path.join(clientDir, 'index.html'))) {
      throw Object.assign(
        new Error('Dashboard build not found (dist/client). Run `npm run build` first, or use `npm run dev`.'),
        { glissaBoot: true },
      );
    }
    app.use(express.static(clientDir));
  }
  if (staticDir !== 'auto' && typeof staticDir === 'string') {
    app.use(express.static(staticDir));
  }

  return app;
}

export { createBackendHttpApp };
export type { BackendHttpDependencies };
