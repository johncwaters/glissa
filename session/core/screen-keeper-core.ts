const SCREEN_RESET = '\x1bc\x1b[2J\x1b[3J\x1b[H';

const SCREEN_KEEPER_SCROLLBACK = 500;

interface ResizeMarker {
  cols: number;
  rows: number;
  atOffset: number;
}

interface PendingResizeSplit {
  due: ResizeMarker[];
  rest: ResizeMarker[];
}

function pendingResizes(queue: readonly ResizeMarker[], parsedOffset: number): PendingResizeSplit {
  let cut = 0;
  while (cut < queue.length) {
    const marker = queue[cut];
    if (marker === undefined || marker.atOffset > parsedOffset) break;
    cut += 1;
  }
  return { due: queue.slice(0, cut), rest: queue.slice(cut) };
}

export { SCREEN_RESET, SCREEN_KEEPER_SCROLLBACK, pendingResizes };
export type { PendingResizeSplit, ResizeMarker };
