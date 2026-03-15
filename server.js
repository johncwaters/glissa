'use strict';

const http = require('http');
const { createBackend } = require('./backend');

const server = http.createServer();
const { shutdown, port, app } = createBackend(server, { staticDir: 'auto' });
server.on('request', app);

server.listen(port, () => {
  console.log(`Glissa server listening on http://localhost:${port}`);
});

let shuttingDown = false;
process.on('SIGINT', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nSIGINT received — shutting down...');
  shutdown();
  server.close(() => process.exit(0));
});
