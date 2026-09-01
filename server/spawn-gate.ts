// Process-wide async serialization for pty.spawn initiation.
//
// The detection postmortem reports ConPTY can wedge a new pty.spawn while other ConPTY sessions are
// still initializing (docs/postmortem-terminal-detection.md). The Phase-0 probe also showed
// node-pty's conpty console-list agent throwing on teardown. To avoid overlapping a fresh spawn
// with another's settle/teardown window, every spawn-initiation runs through this single gate.
// See .omc/plans/marketing-team-pipeline.md section 3.9.

interface SerialQueue {
  run<T>(fn: () => T | Promise<T>): Promise<T>;
}

// The chain-onto-tail serializer itself, named for what it does rather than for the one caller above:
// the worktree engine and the distiller lane serialize their own work with the same queue.
function createSerialQueue(): SerialQueue {
  // `tail` is the promise chain; each run() links after the previous, so only one runs at a time.
  let tail: Promise<void> = Promise.resolve();

  // Queue `fn` to run after all previously-queued work. Returns fn's result (or rejection) to the
  // caller; the internal chain swallows the outcome so one failure never deadlocks the queue.
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
