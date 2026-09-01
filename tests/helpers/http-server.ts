import net from 'node:net';
import type { Server } from 'node:net';

function boundPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server is not listening on a TCP port');
  }
  return address.port;
}

function listenOnLoopback(server: Server, port = 0): Promise<number> {
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(boundPort(server)));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = boundPort(probe);
      probe.close(() => resolve(port));
    });
  });
}

export { boundPort, closeServer, listenOnLoopback, reserveFreePort };
