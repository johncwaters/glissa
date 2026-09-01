'use strict';

const http = require('node:http');
const { createBackend } = require('./server/backend.ts');
const { createLifecycle } = require('./server/server-lifecycle');
const { decideBindHost } = require('./server/core/remote-config.ts');
const { buildTitleSequence, buildTitleClearSequence } = require('./server/core/terminal-title.ts');

// Which address the listeners bind. Loopback unless GLISSA_HOST says otherwise, and a non-loopback
// GLISSA_HOST is REFUSED unless GLISSA_INSECURE_BIND=1 states the intent: Glissa's control WebSocket
// is unauthenticated and accepts an arbitrary project path plus dangerouslySkipPermissions, so a
// listener reachable off-box is remote code execution as this account. Remote access is meant to go
// through remote mode (a second, cookie-gated listener behind a reverse proxy), not a wider bind.
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

let backend;
try {
  backend = createBackend(server, { staticDir: 'auto' });
} catch (err) {
  // A boot-gate refusal (e.g. an invalid remote block) is an operator message, not a stack trace.
  if (!err || !err.glissaBoot) throw err;
  console.error(err.message);
  process.exit(1);
}

const { shutdown, port, app } = backend;
server.on('request', app);

function writeTerminalTitle(sequence) {
  if (!process.stdout.isTTY) return;
  process.stdout.write(sequence);
}

// Single-instance guard. If another Glissa already holds the port, exit cleanly instead of crashing
// with an unhandled listen error. This is the backstop against two backends running against the same
// config.json + port (the per-process config self-write guard cannot dedup across processes, so two
// instances would ping-pong reloads and respawn each other's sessions). A clean exit (no respawn)
// means a stray menu restart can never bootstrap a second, invisible, looping instance.
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Another Glissa is already running on port ${port} - exiting.`);
    process.exit(1);
  }
  throw err;
});

server.listen(port, bind.host, () => {
  const boundPort = server.address().port;
  console.log(`Glissa server listening on http://${bind.host}:${boundPort}`);
  writeTerminalTitle(buildTitleSequence(`glissa :${boundPort}`));
  if (bind.reason === 'insecure-bind') {
    console.warn(`WARNING: bound ${bind.host} with GLISSA_INSECURE_BIND=1 - this listener has NO authentication.`);
  }
});

// Remote mode: a SECOND listener serving the same app, where every request needs a paired device
// cookie. It binds loopback too - a reverse proxy (tailscale serve) is the thing that faces the
// network, so the cookie gate is the only trust boundary crossed, not the bind address.
const remoteServers = [];
if (backend.remote.enabled) {
  const remoteServer = http.createServer();
  backend.remote.attach(remoteServer);
  remoteServer.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`Remote listener port ${backend.remote.port} is already in use - exiting.`);
      process.exit(1);
    }
    throw err;
  });
  remoteServer.listen(backend.remote.port, bind.host, () => {
    console.log(`Glissa remote listener on http://${bind.host}:${backend.remote.port} (paired devices only)`);
    const publicHost = backend.remote.publicHost || '(remote.publicHost not set)';
    console.log(`  proxy target for ${publicHost}; pair a device with: glissa pair`);
  });
  remoteServers.push(remoteServer);
}
if (!backend.remote.enabled) {
  // The enabled case announces itself with its own listener line above; the disabled case has no
  // listener to announce, so without this the log is silent about remote mode and an operator
  // debugging "my phone cannot reach it" has nothing to read.
  console.log('Glissa remote mode is disabled (set remote.enabled in config.json to turn it on)');
}

// Route every termination signal through the same lifecycle path as the dashboard-triggered shutdown
// (server/backend.js wires an identical createLifecycle instance to the control WS "shutdown" message):
// requestShutdown awaits the in-flight PTY reaps shutdown() started, then closes the listener with a
// bounded fallback exit timer. The fallback matters because an open dashboard tab holds a live WS
// connection, so httpServer.close()'s callback alone would never fire and the process would hang
// forever on SIGINT/SIGTERM/SIGBREAK/SIGHUP. createLifecycle owns the single re-entry guard, so no
// local shuttingDown flag is needed here.
function exitWithClearedTerminalTitle(code) {
  writeTerminalTitle(buildTitleClearSequence());
  process.exit(code);
}

const { requestShutdown } = createLifecycle({
  shutdown,
  httpServer: server,
  extraServers: remoteServers,
  exit: exitWithClearedTerminalTitle,
});

function handleShutdownSignal(signal) {
  console.log(`\n${signal} received - shutting down...`);
  requestShutdown();
}

process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
process.on('SIGBREAK', () => handleShutdownSignal('SIGBREAK'));
process.on('SIGHUP', () => handleShutdownSignal('SIGHUP'));
