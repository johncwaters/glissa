// Structural rather than node:stream's Readable, so a relay test can hand main() a plain emitter.
interface StdinLike {
  on(event: string, listener: (chunk: Buffer | string) => void): unknown;
}

function readStdin(stream: StdinLike): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    };
    stream.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
    });
    stream.on("end", finish);
    stream.on("error", finish);
    stream.on("close", finish);
  });
}

export { readStdin };
export type { StdinLike };
