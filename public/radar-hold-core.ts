
export const OUTCOME_READ_MS = 4000;

export interface RenderHoldOptions {
  render: () => void;
  holdMs?: number;
  setTimer?: (handler: () => void, timeout: number) => number;
  clearTimer?: (handle: number) => void;
}

export function createRenderHold({
  render,
  holdMs = OUTCOME_READ_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: RenderHoldOptions) {
  const pending = new Set<string>();
  let held = false;
  let timer: number | null = null;

  function arm(restart: boolean) {
    if (timer !== null && !restart) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(fire, holdMs);
  }

  function fire() {
    timer = null;
    if (pending.size > 0) {
      arm(false);
      return;
    }
    if (!held) return;
    held = false;
    render();
  }

  return {
    begin(token: string) {
      pending.add(token);
    },
    settle(token: string) {
      pending.delete(token);
      arm(true);
    },
    request() {
      if (pending.size === 0 && timer === null) {
        render();
        return;
      }
      held = true;
      arm(false);
    },
    _state() {
      return { pending: pending.size, held, armed: timer !== null };
    },
  };
}
