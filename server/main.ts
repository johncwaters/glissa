import http from 'node:http';
import type { Server } from 'node:http';

import { createBackend } from './backend.ts';
import { spawn } from './child-process-safe.ts';
import { decideBindHost } from './core/remote-config.ts';
import { buildTitleClearSequence, buildTitleSequence } from './core/terminal-title.ts';
import { createLifecycle } from './server-lifecycle.ts';

const bind = decideBindHost({
  envHost: process.env.GLISSA_HOST,
  insecureBind: process.env.GLISSA_INSECURE_BIND === '1',
});
if (!bind.allowed) {
  console.error(`Refusing to bind ${bind.host}: Glissa has no authentication on the local listener.`);
  console.error('Use remote mode (config.remote) behind a reverse proxy, or set GLISSA_INSECURE_BIND=1 if you truly mean it.');
  process.exit(1);
}

const server = http.createServer();

function isBootRefusal(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  if (!('glissaBoot' in error)) return false;
  return error.glissaBoot === true;
}

function createBackendOrExit(): ReturnType<typeof createBackend> {
  try {
    return createBackend(server, { staticDir: 'auto' });
  } catch (err) {
    if (!isBootRefusal(err)) throw err;
    console.error(err.message);
    process.exit(1);
  }
}

const backend = createBackendOrExit();

const { shutdown, port, app } = backend;
server.on('request', app);

function writeTerminalTitle(sequence: string): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(sequence);
}

function listeningPort(target: Server, fallback: number): number {
  const address = target.address();
  if (address === null || typeof address === 'string') return fallback;
  return address.port;
}

function isPortInUse(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
}

server.on('error', (err) => {
  if (isPortInUse(err)) {
    console.error(`Another Glissa is already running on port ${port} - exiting.`);
    process.exit(1);
  }
  throw err;
});

server.listen(port, bind.host, () => {
  const boundPort = listeningPort(server, port);
  console.log(`Glissa server listening on http://${bind.host}:${boundPort}`);
  writeTerminalTitle(buildTitleSequence(`glissa :${boundPort}`));
  if (bind.reason === 'insecure-bind') {
    console.warn(`WARNING: bound ${bind.host} with GLISSA_INSECURE_BIND=1 - this listener has NO authentication.`);
  }
});

const remoteServers: Server[] = [];
if (backend.remote.enabled) {
  const remoteServer = http.createServer();
  backend.remote.attach(remoteServer);
  remoteServer.on('error', (err) => {
    if (isPortInUse(err)) {
      console.error(`Remote listener port ${backend.remote.port} is already in use - exiting.`);
      process.exit(1);
    }
    throw err;
  });
  remoteServer.listen(backend.remote.port ?? 0, bind.host, () => {
    console.log(`Glissa remote listener on http://${bind.host}:${backend.remote.port} (paired devices only)`);
    const publicHost = backend.remote.publicHost || '(remote.publicHost not set)';
    console.log(`  proxy target for ${publicHost}; pair a device with: glissa pair`);
  });
  remoteServers.push(remoteServer);
}
if (!backend.remote.enabled) {
  console.log('Glissa remote mode is disabled (set remote.enabled in config.json to turn it on)');
}

function exitWithClearedTerminalTitle(code?: number): never {
  writeTerminalTitle(buildTitleClearSequence());
  process.exit(code);
}

const { requestShutdown } = createLifecycle({
  shutdown,
  httpServer: server,
  extraServers: remoteServers,
  spawn,
  exit: exitWithClearedTerminalTitle,
});

function handleShutdownSignal(signal: string): void {
  console.log(`\n${signal} received - shutting down...`);
  void requestShutdown();
}

process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
process.on('SIGBREAK', () => handleShutdownSignal('SIGBREAK'));
process.on('SIGHUP', () => handleShutdownSignal('SIGHUP'));
