'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream');
const express = require('express');
const { mountBrowserModuleRoutes } = require('./browser-modules');
const { decideHostAllowed } = require('./core/host-policy');
const { decideOriginAllowed } = require('./core/origin-policy');
const { configSiblingPath } = require('./pairings-store');
const {
  buildUploadFilename,
  decideUploadType,
  exceedsUploadCap,
  framePathPaste,
  isSafePathSegment,
  planUploadRetention,
} = require('./core/upload-core');

/**
 * @typedef {object} BackendHttpDependencies
 * @property {string|null} staticDir
 * @property {{ configPath: string }} configStore
 * @property {{ allowedOrigins: string[] }} remote
 * @property {{ httpMiddleware: import('express').RequestHandler, mountPairRoutes: (app: import('express').Express) => void }|null} remoteAuth
 * @property {string[]} allowedHosts
 * @property {(socket: { localPort?: number }|null) => number[]} listenerPortsFor
 * @property {string} pageToken
 * @property {{ handle: (input: object) => { status: number, reason: string } }} hookRouter
 * @property {(id: string) => any|null} getSession
 * @property {() => { ingestStatusline: (payload: object) => void }} getUsage
 */

function isPackNoticeHookEvent(event, session) {
  const declaredEvent = session?.packNoticeHookEvent;
  if (!declaredEvent) return false;
  return String(event || '').toLowerCase() === declaredEvent.toLowerCase();
}

function isStatuslineEvent(event) {
  return String(event || '').toLowerCase() === 'statusline';
}

async function sweepSessionUploads(dir, justWritten) {
  let entries = null;
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

function receiveUpload({ req, res, sess, dir, filename, savedPath }) {
  const writeStream = fs.createWriteStream(savedPath);
  let bytesReceived = 0;
  let settled = false;

  const answer = (status, body) => {
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
  req.on('data', (chunk) => {
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
    sweepSessionUploads(dir, filename);
  });
}

function mountDevRoutes(app) {
  app.get('/xterm/xterm.css', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'node_modules/@xterm/xterm/css/xterm.css'));
  });
  app.get('/xterm/xterm.mjs', (_req, res) => {
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, '..', 'node_modules/@xterm/xterm/lib/xterm.mjs'));
  });
  app.get('/xterm/addon-fit.mjs', (_req, res) => {
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, '..', 'node_modules/@xterm/addon-fit/lib/addon-fit.mjs'));
  });
  app.get('/xterm/addon-webgl.mjs', (_req, res) => {
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, '..', 'node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs'));
  });
  app.use('/zod', express.static(path.join(__dirname, '..', 'node_modules/zod')));

  mountBrowserModuleRoutes(app);
}

/** @param {BackendHttpDependencies} dependencies */
function createBackendHttpApp(dependencies) {
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
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length <= 65536) return;
      aborted = true;
      req.destroy();
    });
    req.on('end', () => {
      if (aborted) return;
      let payload = {};
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
      const reply = { ok: output.status === 200, reason: output.reason };
      const hookSession = getSession(req.params.glissaId);
      const packNotice = output.status === 200 && isPackNoticeHookEvent(req.params.event, hookSession)
        ? hookSession.takePackNoticeContext() || null
        : null;
      if (packNotice) {
        reply.hookSpecificOutput = {
          hookEventName: hookSession.packNoticeHookEvent,
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
    const distPath = path.join(__dirname, '..', 'dist');
    const useDistDir = fs.existsSync(distPath) && fs.statSync(distPath).isDirectory();
    const resolvedDir = useDistDir ? 'dist' : 'public';
    app.use(express.static(path.join(__dirname, '..', resolvedDir)));
    if (!useDistDir) mountDevRoutes(app);
  }
  if (staticDir !== 'auto' && typeof staticDir === 'string') {
    app.use(express.static(staticDir));
  }

  return app;
}

module.exports = { createBackendHttpApp, mountDevRoutes };
