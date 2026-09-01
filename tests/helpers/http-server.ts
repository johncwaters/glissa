import net from 'node:net';
import type { Server } from 'node:net';

// listen/address/close are callback APIs whose results are wider than a test ever wants: address()
// answers AddressInfo | string | null, and listen's callback takes no arguments a Promise executor can
// hand it. Every backend suite needs the same three lines, so they live here once.

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

// A port the OS just handed out and immediately released. Remote mode decides trust by comparing
// req.socket.localPort against the CONFIGURED remote port, so that port has to be known before boot.
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
