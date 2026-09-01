interface SerialQueue {
  run<T>(fn: () => T | Promise<T>): Promise<T>;
}

function createSerialQueue(): SerialQueue {
  let tail: Promise<void> = Promise.resolve();

  function run<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = tail.then(() => fn());
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return { run };
}

const createSpawnGate = createSerialQueue;

export { createSerialQueue, createSpawnGate };
export type { SerialQueue };
