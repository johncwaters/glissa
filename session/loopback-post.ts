import http from 'node:http';

const POST_TIMEOUT_MS = 1500;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

function postPayload(url: string, body: Buffer): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      done();
      return;
    }
    if (target.protocol !== 'http:' || !LOOPBACK_HOSTS.has(target.hostname)) {
      done();
      return;
    }
    try {
      const request = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (response) => {
          response.resume();
          response.on('end', done);
          response.on('error', done);
        },
      );
      request.on('error', done);
      request.setTimeout(POST_TIMEOUT_MS, () => {
        request.destroy();
        done();
      });
      request.end(body);
    } catch {
      done();
    }
  });
}

export { postPayload, POST_TIMEOUT_MS };
