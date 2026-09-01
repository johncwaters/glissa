import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

import { createConfigStore } from '../../server/config-store.ts';
import type { ConfigStore, GlissaConfig } from '../../server/config-store.ts';
import { registerControlHandlers } from '../../server/control-handlers.ts';
import type { ControlHandlerDeps } from '../../server/control-handlers.ts';
import type { RequestTrust } from '../../server/core/request-trust.ts';

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

type ControlMessageListener = (raw: string) => unknown;

interface ControlConnection<TFrame> {
  sent: TFrame[];

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
