'use strict';

const http = require('node:http');
const { createBackend } = require('./server/backend');

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

let shuttingDown = false;
process.on('SIGINT', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nSIGINT received - shutting down...');
  shutdown();
  server.close(() => process.exit(0));
});
