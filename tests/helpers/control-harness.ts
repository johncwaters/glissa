import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

import { createConfigStore } from '../../server/config-store.ts';
import type { ConfigStore, GlissaConfig } from '../../server/config-store.ts';
import { registerControlHandlers } from '../../server/control-handlers.ts';
import type { ControlHandlerDeps } from '../../server/control-handlers.ts';
import type { RequestTrust } from '../../server/core/request-trust.ts';

/*
 * A control suite drives registerControlHandlers directly instead of booting a backend, so the two real
 * dependencies that registration insists on live here once: the WebSocketServer it registers against,
 * and the ConfigStore its deps carry. Both are genuine instances. The store is the shipping one over a
 * throwaway config.json, with only `save` swapped for an in-memory mutation, so a suite can keep
 * asserting on the config object it handed in while getSettings stays the real projection.
 */

const HARNESS_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-control-harness-'));
process.on('exit', () => {
  fs.rmSync(HARNESS_CONFIG_DIR, { recursive: true, force: true });
});

let storesCreated = 0;

function realConfigStore(): ConfigStore {
  storesCreated += 1;
  const configPath = path.join(HARNESS_CONFIG_DIR, `config-${storesCreated}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ projects: [] }), 'utf8');
  const previous = process.env.GLISSA_CONFIG;
  process.env.GLISSA_CONFIG = configPath;
  try {
    return createConfigStore();
  } finally {
    if (previous == null) delete process.env.GLISSA_CONFIG;
    if (previous != null) process.env.GLISSA_CONFIG = previous;
  }
}

interface TestConfigStoreOptions {
  saveFails?: boolean;
  onSave?: () => void;
}

// The store the control deps take, with save rewritten to mutate `config` in place. The real save is a
// disk round-trip that hands back a fresh object; a suite asserting on what a handler persisted wants
// the object it holds to be the one that changed.
function testConfigStore(config: GlissaConfig, options: TestConfigStoreOptions = {}): ConfigStore {
  const real = realConfigStore();
  real.applySettings(config);
  return {
    ...real,
    save(mutate: (draft: GlissaConfig) => void): GlissaConfig | null {
      if (options.onSave) options.onSave();
      if (options.saveFails === true) return null;
      mutate(config);
      real.applySettings(config);
      return config;
    },
  };
}

// The deps every control suite has to supply before it can state the one or two it actually cares
// about. generateProjectId and the two reload hooks are required by the registration and inert here.
function controlDeps(config: GlissaConfig, overrides: Partial<ControlHandlerDeps> = {}): ControlHandlerDeps {
  return {
    sessions: new Map(),
    config,
    configStore: testConfigStore(config),
    generateProjectId: () => 'p-test',
    applyConfigReload: () => {},
    applySettingsReload: () => {},
    broadcastControl: () => {},
    ...overrides,
  };
}

function createControlServer(deps: ControlHandlerDeps): WebSocketServer {
  const controlWss = new WebSocketServer({ noServer: true });
  registerControlHandlers(controlWss, deps);
  return controlWss;
}

// What the control handlers call on a connected socket. The real one is a ws WebSocket the upgrade
// path built; a suite that never opens a port supplies this much and nothing else is touched.
type ControlMessageListener = (raw: string) => unknown;

interface ControlConnection<TFrame> {
  sent: TFrame[];
  /** Feeds one frame into the connection's message listener, returning what an async handler returns. */
  send(message: unknown): unknown;
}

interface ConnectControlOptions {
  url?: string;
  trust?: RequestTrust;
}

function connectControl<TFrame>(
  server: WebSocketServer,
  { url = '/control', trust }: ConnectControlOptions = {},
): ControlConnection<TFrame> {
  const sent: TFrame[] = [];
  let messageListener: ControlMessageListener | null = null;
  const socket = {
    glissaTrust: trust,
    send(raw: string): void {
      sent.push(JSON.parse(raw));
    },
    on(event: string, listener: ControlMessageListener): void {
      if (event === 'message') messageListener = listener;
    },
  };
  server.emit('connection', socket, { url });
  return {
    sent,
    send(message: unknown): unknown {
      if (messageListener === null) throw new Error('the control handlers registered no message listener');
      return messageListener(JSON.stringify(message));
    },
  };
}

export { connectControl, controlDeps, createControlServer, testConfigStore };
export type { ControlConnection };
