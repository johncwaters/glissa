import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { Express, NextFunction, Request, Response } from 'express';

import {
  COOKIE_NAME, decideCookieFlags, readDeviceCookie, serializeSetCookie,
} from './core/cookie.ts';
import {
  DEFAULT_DEVICE_MAX_AGE_MS, decideDeviceAuth, deviceNameFromUserAgent, hashSecret,
} from './core/pairing-token.ts';
import { classifyRequestOrigin, decideRequestAccess, normalizePathname } from './core/request-trust.ts';
import type { RequestTrust } from './core/request-trust.ts';
import type { PairedDevice, PairingsStore, SeenStore } from './pairings-store.ts';

const DEVICE_COOKIE_MAX_AGE_SECONDS = Math.floor(DEFAULT_DEVICE_MAX_AGE_MS / 1000);

interface RemoteConfig {
  enabled: boolean;
  port: number | null;
  publicHost: string;
  allowedOrigins: string[];
}

interface AuthOutcome {
  ok: boolean;
  reason: string | null;
  device: PairedDevice | null;
}

interface RemoteAuthOptions {
  remote: RemoteConfig | null | undefined;
  pairingsStore: PairingsStore;
  seenStore?: SeenStore | null;
  now?: () => number;
  deviceMaxAgeMs?: number;
  log?: (message: string) => void;
}

interface RemoteAuth {
  httpMiddleware(req: Request, res: Response, next: NextFunction): void;
  isUpgradeAuthorized(req: IncomingMessage): boolean;
  mountPairRoutes(app: Express): void;
  authenticate(req: IncomingMessage): AuthOutcome;
  trustOf(req: IncomingMessage): RequestTrust;
  stop(): void;
}

function escapeHtml(str: unknown): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body { background:#12131a; color:#e6e6ee; font:16px/1.5 system-ui, sans-serif; margin:0;
  display:flex; align-items:center; justify-content:center; min-height:100vh; padding:24px; }
main { max-width:32rem; }
h1 { font-size:1.25rem; margin:0 0 .5rem; }
p { margin:0; color:#a0a0b2; }
</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

function hashesMatch(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

function createRemoteAuth({
  remote,
  pairingsStore,
  seenStore = null,
  now = Date.now,
  deviceMaxAgeMs = DEFAULT_DEVICE_MAX_AGE_MS,
  log = console.log,
}: RemoteAuthOptions): RemoteAuth {
  const remoteListenerPort = remote?.enabled ? remote.port : null;
  const stopWatch = pairingsStore.watch(() => {
    log('[remote] pairings.json changed - device list reloaded');
  });

  function authenticate(req: IncomingMessage): AuthOutcome {
    const parsed = readDeviceCookie(req.headers?.cookie, COOKIE_NAME);
    if (!parsed) return { ok: false, reason: 'no-cookie', device: null };
    const device = pairingsStore.findDevice(parsed.id);
    if (!device) return { ok: false, reason: 'no-device', device: null };
    const secretMatches = hashesMatch(hashSecret(parsed.secret), device.secretHash);
    const verdict = decideDeviceAuth({ record: device, now: now(), maxAgeMs: deviceMaxAgeMs, secretMatches });
    if (!verdict.ok) return { ok: false, reason: verdict.reason, device: null };
    if (seenStore) seenStore.touch(device.id);
    return { ok: true, reason: null, device };
  }

  function trustOf(req: IncomingMessage): RequestTrust {
    return classifyRequestOrigin({
      localPort: req.socket ? req.socket.localPort : null,
      remoteListenerPort,
    });
  }

  function httpMiddleware(req: Request, res: Response, next: NextFunction): void {
    const trust = trustOf(req);

    const authenticated = trust === 'remote' ? authenticate(req).ok : false;

    const decision = decideRequestAccess({
      remoteEnabled: Boolean(remote?.enabled),
      trust,
      pathname: normalizePathname(req.url).pathname,
      authenticated,
    });
    if (decision.allow) {
      next();
      return;
    }
    res.status(401)
      .type('html')
      .send(htmlPage('Pairing required', 'This device is not paired with Glissa. Run "glissa pair" on the host machine and open the link it prints.'));
  }

  function isUpgradeAuthorized(req: IncomingMessage): boolean {
    return authenticate(req).ok;
  }

  function mountPairRoutes(app: Express): void {
    app.get('/pair/:token', (req: Request, res: Response) => {
      const outcome = pairingsStore.redeem(req.params.token, {
        fallbackName: deviceNameFromUserAgent(req.headers['user-agent']),
      });
      if (!outcome.ok) {
        log(`[remote] pairing rejected (${outcome.reason})`);
        res.status(403)
          .type('html')
          .send(htmlPage('Pairing link not valid', 'This link was already used, has expired, or is not recognized. Run "glissa pair" on the host machine for a fresh one.'));
        return;
      }
      if (!outcome.device) {
        res.status(403).type('html').send(htmlPage('Pairing link not valid', 'This link was already used, has expired, or is not recognized. Run "glissa pair" on the host machine for a fresh one.'));
        return;
      }
      const flags = decideCookieFlags({ forwardedProto: req.headers['x-forwarded-proto'] });
      log(`[remote] paired device ${outcome.device.id} (${outcome.device.name})`);
      res.setHeader('Set-Cookie', serializeSetCookie(COOKIE_NAME, outcome.cookieValue, {
        maxAgeSeconds: DEVICE_COOKIE_MAX_AGE_SECONDS,
        secure: flags.secure,
        sameSite: flags.sameSite,
        httpOnly: true,
        path: '/',
      }));
      res.redirect(303, '/');
    });
  }

  function stop(): void {
    stopWatch();
  }

  return { httpMiddleware, isUpgradeAuthorized, mountPairRoutes, authenticate, trustOf, stop };
}

export { DEVICE_COOKIE_MAX_AGE_SECONDS, createRemoteAuth };
export type { AuthOutcome, RemoteAuth, RemoteAuthOptions, RemoteConfig };
