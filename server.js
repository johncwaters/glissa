'use strict';

const http = require('node:http');
const { createBackend } = require('./server/backend');
const { createLifecycle } = require('./server/server-lifecycle');

const server = http.createServer();
const { shutdown, port, app } = createBackend(server, { staticDir: 'auto' });
server.on('request', app);

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

server.listen(port, '127.0.0.1', () => {
  console.log(`Glissa server listening on http://127.0.0.1:${port}`);
});

// Route every termination signal through the same lifecycle path as the dashboard-triggered shutdown
// (server/backend.js wires an identical createLifecycle instance to the control WS "shutdown" message):
// requestShutdown awaits the in-flight PTY reaps shutdown() started, then closes the listener with a
// bounded fallback exit timer. The fallback matters because an open dashboard tab holds a live WS
// connection, so httpServer.close()'s callback alone would never fire and the process would hang
// forever on SIGINT/SIGTERM/SIGBREAK/SIGHUP. createLifecycle owns the single re-entry guard, so no
// local shuttingDown flag is needed here.
const { requestShutdown } = createLifecycle({ shutdown, httpServer: server });

function handleShutdownSignal(signal) {
  console.log(`\n${signal} received - shutting down...`);
  requestShutdown();
}

process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
process.on('SIGBREAK', () => handleShutdownSignal('SIGBREAK'));
process.on('SIGHUP', () => handleShutdownSignal('SIGHUP'));
