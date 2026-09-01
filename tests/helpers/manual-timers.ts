// A timer seam a suite fires by hand, so "the deadline expired" is a decision the test makes rather
// than a wall-clock race. The handle handed back is a REAL unref'd timer that never runs its own
// callback: the seams these fakes replace are typed against NodeJS.Timeout, and a handle minted here
// holds nothing open even if a suite forgets to clear it.

interface ManualTimer {
  fn: () => void;
  ms: number;
  handle: NodeJS.Timeout;
  cleared: boolean;
}

interface ManualTimers {
  setTimeoutFn: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn: (handle: NodeJS.Timeout) => void;
  fireAll: () => void;
  pending: ManualTimer[];
}

const NEVER_MS = 2 ** 30;

function manualTimers(): ManualTimers {
  const pending: ManualTimer[] = [];
  return {
    pending,
    setTimeoutFn: (fn, ms) => {
      const handle = setTimeout(() => {}, NEVER_MS);
      handle.unref();
      pending.push({ fn, ms, handle, cleared: false });
      return handle;
    },
    clearTimeoutFn: (handle) => {
      clearTimeout(handle);
      for (const timer of pending) {
        if (timer.handle === handle) timer.cleared = true;
      }
    },
    fireAll: () => {
      for (const timer of pending) {
        if (!timer.cleared) timer.fn();
      }
    },
  };
}

export { manualTimers };
export type { ManualTimer, ManualTimers };
