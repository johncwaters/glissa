import type { SpawnOptions } from 'node:child_process';
import { SUPERVISED_RESTART_EXIT_CODE, decideRestartStrategy } from './core/restart-strategy.ts';
import {
  awaitBounded, normalizeShutdownResult, stopFailureText, summarizeStopOutcomes,
} from './core/shutdown-core.ts';
import type { StopperEntry } from './core/shutdown-core.ts';

interface BoundedWaitOptions {
  capMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: never) => void;
}

interface StopperWaitOptions extends BoundedWaitOptions {
  warn?: (message: string) => void;
}

interface ClosableServer {
  close: () => void;
  closeAllConnections?: () => void;
}

type RespawnFn = (file: string, args: string[], options: SpawnOptions) => { unref(): unknown };

interface LifecycleOptions {
  shutdown: () => unknown;
  httpServer: { close: (callback: () => void) => void };
  extraServers?: ClosableServer[];
  onRestart?: (() => void) | null;
  spawn: RespawnFn;
  exit?: (code?: number) => unknown;
  getArgv?: () => string[];
  cwd?: () => string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  capMs?: number;
  closeTimeoutMs?: number;
}

interface Lifecycle {
  requestShutdown(): Promise<void>;
  requestRestart(): Promise<void>;
}

function awaitReaps(pendingReaps: unknown, options: BoundedWaitOptions = {}): Promise<void> {
  return awaitBounded(pendingReaps as Array<Promise<unknown> | null | undefined>, options).then(() => {});
}

function awaitStoppers(
  stoppers: unknown,
  { capMs = 3000, warn = console.warn, ...timerOptions }: StopperWaitOptions = {},
): Promise<void> {
  const entries = (Array.isArray(stoppers) ? stoppers : []) as StopperEntry[];
  if (entries.length === 0) return Promise.resolve();
  return awaitBounded(entries.map((entry) => entry.promise), { capMs, ...timerOptions })
    .then((outcome) => {
      const summary = summarizeStopOutcomes(entries, outcome);
      if (summary.timedOut) warn(`[lifecycle] lane shutdown exceeded ${capMs}ms - exiting anyway`);
      for (const { name, reason } of summary.failed) {
        warn(`[lifecycle] ${name} failed to stop cleanly: ${stopFailureText(reason)}`);
      }
    });
}

function awaitTeardown(result: unknown, options?: StopperWaitOptions): Promise<void> {
  const { reaps, stoppers } = normalizeShutdownResult(result);
  return Promise.all([awaitReaps(reaps, options), awaitStoppers(stoppers, options)]).then(() => {});
}

function closeExtraServers(extraServers: ClosableServer[]): void {
  for (const server of extraServers) {
    try { server.close(); } catch {  }
    try { if (server.closeAllConnections) server.closeAllConnections(); } catch {  }
  }
}

function createLifecycle({
  shutdown,
  httpServer,
  extraServers = [],
  onRestart = null,
  spawn,
  exit = process.exit,
  getArgv = () => process.argv,
  cwd = () => process.cwd(),
  env = process.env,
  log = console.log,
  capMs = 3000,
  closeTimeoutMs = 2000,
}: LifecycleOptions): Lifecycle {
  let requested = false;

  function fallbackTimer(fn: () => void): NodeJS.Timeout {
    const t = setTimeout(fn, closeTimeoutMs);
    if (t?.unref) t.unref();
    return t;
  }

  async function requestShutdown(): Promise<void> {
    if (requested) return;
    requested = true;
    await awaitTeardown(shutdown(), { capMs, warn: log });
    closeExtraServers(extraServers);
    let exited = false;
    const doExit = () => {
      if (exited) return;
      exited = true;
      exit(0);
    };
    httpServer.close(() => {
      console.log('Server closed - exiting.');
      doExit();
    });
    fallbackTimer(doExit);
  }

  async function requestRestart(): Promise<void> {
    if (requested) return;
    requested = true;
    await awaitTeardown(shutdown(), { capMs, warn: log });
    closeExtraServers(extraServers);

    const restartInPlace = onRestart;
    if (restartInPlace) {
      try {
        restartInPlace();
      } catch (err) {
        requested = false;
        throw err;
      }
      return;
    }

    const strategy = decideRestartStrategy(env);
    let handedOff = false;

    const handOffAndExit = () => {
      if (handedOff) return;
      handedOff = true;
      if (strategy === 'exit-for-supervisor') {
        log(`[lifecycle] Supervised by systemd - exiting ${SUPERVISED_RESTART_EXIT_CODE} so the supervisor restarts the unit`);
        exit(SUPERVISED_RESTART_EXIT_CODE);
        return;
      }
      const argv = getArgv();
      spawn(argv[0], argv.slice(1), {
        cwd: cwd(),
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      }).unref();
      exit(0);
    };
    httpServer.close(handOffAndExit);
    fallbackTimer(handOffAndExit);
  }

  return { requestShutdown, requestRestart };
}

export { awaitReaps, awaitStoppers, awaitTeardown, createLifecycle };
export type { Lifecycle, LifecycleOptions, RespawnFn };
