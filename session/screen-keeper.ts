import { createRequire } from "node:module";
import headless from "@xterm/headless";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import { SCREEN_KEEPER_SCROLLBACK, pendingResizes } from "./core/screen-keeper-core.ts";
import type { ResizeMarker } from "./core/screen-keeper-core.ts";

const { Terminal } = headless;

interface SerializerPort {
  activate(terminal: unknown): void;
  serialize(options?: { scrollback?: number }): string;
  dispose(): void;
}

interface SerializeAddonModule {
  SerializeAddon: new () => SerializerPort;
}

const { SerializeAddon } = createRequire(import.meta.url)("@xterm/addon-serialize") as SerializeAddonModule;

interface ScreenKeeper {
  push(chunk: string): void;
  resize(cols: number, rows: number): void;
  parsedOffset(): number;
  serialize(): string;
  dispose(): void;
}

type ScreenKeeperFactory = (size: { cols: number; rows: number }) => ScreenKeeper;

function createScreenKeeper({ cols, rows }: { cols: number; rows: number }): ScreenKeeper {
  const terminal: HeadlessTerminal = new Terminal({
    cols,
    rows,
    scrollback: SCREEN_KEEPER_SCROLLBACK,
    allowProposedApi: true,
  });
  const serializer = new SerializeAddon();
  serializer.activate(terminal);

  let pushedOffset = 0;
  let parsedOffset = 0;
  let queue: ResizeMarker[] = [];
  let disposed = false;

  function drainResizes(): void {
    if (disposed) return;
    const split = pendingResizes(queue, parsedOffset);
    queue = split.rest;
    for (const marker of split.due) terminal.resize(marker.cols, marker.rows);
  }

  return {
    push(chunk) {
      if (disposed || chunk.length === 0) return;
      pushedOffset += chunk.length;
      const reachedOffset = pushedOffset;
      terminal.write(chunk, () => {
        if (disposed) return;
        parsedOffset = reachedOffset;
        drainResizes();
      });
    },
    resize(nextCols, nextRows) {
      if (disposed) return;
      queue.push({ cols: nextCols, rows: nextRows, atOffset: pushedOffset });
      drainResizes();
    },
    parsedOffset: () => parsedOffset,
    serialize: () => serializer.serialize({ scrollback: SCREEN_KEEPER_SCROLLBACK }),
    dispose() {
      if (disposed) return;
      disposed = true;
      queue = [];
      serializer.dispose();
      terminal.dispose();
    },
  };
}

export { createScreenKeeper };
export type { ScreenKeeper, ScreenKeeperFactory };
