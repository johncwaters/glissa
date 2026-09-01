
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import realFsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createBackend } from '../server/backend.ts';
import { createUsageWiring } from '../server/usage-wiring.ts';
import { createUsageScanner } from '../server/usage-scanner.ts';
import { loadPricing } from '../server/usage-pricing.ts';
import { closeSocket, dashboardClient, openRecordingSocket, waitForMessage } from './helpers/dashboard-ws.ts';
import type { DashboardClient } from './helpers/dashboard-ws.ts';
import { boundPort, closeServer, listenOnLoopback } from './helpers/http-server.ts';

const SESSION_ID = 'b0000000-0000-4000-8000-000000000001';
const CLAUDE_SESSION_ID = 'c1c1c1c1-2222-4333-8444-555555555555';
const MODEL = 'claude-opus-4-5';
const MESSAGE_WAIT_MS = 5000;

interface UsageSessionRow {
  id: string;
  tokens: number;
  costUSD: number;
  lastTs: number;
}

type ControlFrame =
  | { type: 'usage-sessions'; pricingSource: string; ts: number; sessions: UsageSessionRow[] }
  | {
    type: 'usage-report';
    requestId: string | null;
    error: string | null;
    warning?: string | null;
    blockHours?: number;
    totals?: { tokens: number; input: number; output: number };
    daily?: unknown[];
    models?: { model: string }[];
    sessions?: unknown[];
    blocks?: unknown[];
    activeBlock?: unknown;
    pricing?: { source: string; missing: string[] };
    scan?: { files: number; entries: number; partial: boolean; dirs: string[] };
  }
  | { type: 'settings-updated'; requestId: string | null; settings: { usage?: unknown } }
  | { type: 'snapshot' };

type UsageSessions = Extract<ControlFrame, { type: 'usage-sessions' }>;
type UsageReport = Extract<ControlFrame, { type: 'usage-report' }>;
type SettingsUpdated = Extract<ControlFrame, { type: 'settings-updated' }>;

const isUsageSessions = (m: ControlFrame): m is UsageSessions => m.type === 'usage-sessions';
const isUsageReport = (m: ControlFrame): m is UsageReport => m.type === 'usage-report';
const isSnapshot = (m: ControlFrame) => m.type === 'snapshot';
const settingsUpdatedFor = (requestId: string) => (m: ControlFrame): m is SettingsUpdated =>
  m.type === 'settings-updated' && m.requestId === requestId;

function transcriptLine({ sessionId, requestId, messageId, input, output, timestampMs }: {
  sessionId: string;
  requestId: string;
  messageId: string;
  input: number;
  output: number;
  timestampMs: number;
}): string {
  return `${JSON.stringify({
    sessionId,
    requestId,
    timestamp: new Date(timestampMs).toISOString(),
    cwd: 'C:/fixture/repo',
    version: '2.1.200',
    isSidechain: false,
    message: {
      id: messageId,
      model: MODEL,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  })}\n`;
}

function writeTranscriptFixture(claudeHome: string): void {
  const projectDir = path.join(claudeHome, 'projects', 'C--fixture-repo');
  fs.mkdirSync(projectDir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(
    path.join(projectDir, `${CLAUDE_SESSION_ID}.jsonl`),
    transcriptLine({ sessionId: CLAUDE_SESSION_ID, requestId: 'req-1', messageId: 'msg-1', input: 100, output: 50, timestampMs: now - 60000 })
      + transcriptLine({ sessionId: CLAUDE_SESSION_ID, requestId: 'req-2', messageId: 'msg-2', input: 200, output: 25, timestampMs: now - 30000 }),
    'utf8',
  );
}

interface ScanCounts {
  scanners: number;
  stat: number;
  readdir: number;
  open: number;
}

function makeUsageProbe(claudeHome: string) {
  const counts: ScanCounts = { scanners: 0, stat: 0, readdir: 0, open: 0 };
  const fsPromises = {
    stat: (...args: Parameters<typeof realFsp.stat>) => { counts.stat += 1; return realFsp.stat(...args); },
    readdir: (...args: Parameters<typeof realFsp.readdir>) => { counts.readdir += 1; return realFsp.readdir(...args); },
    open: (...args: Parameters<typeof realFsp.open>) => { counts.open += 1; return realFsp.open(...args); },
  };
  const options = {
    loadPricingFn: (args: Parameters<typeof loadPricing>[0]) => loadPricing({ ...args, fetchEnabled: false }),
    createScanner: (deps: Parameters<typeof createUsageScanner>[0]) => {
      counts.scanners += 1;
      return createUsageScanner(deps);
    },
    scannerDeps: { env: { CLAUDE_CONFIG_DIR: claudeHome, HOME: path.dirname(claudeHome), USERPROFILE: path.dirname(claudeHome) }, fsPromises },
    logger: { warn: () => {}, log: () => {} },
  };
  return { counts, options };
}

interface UsageHarness {
  dash: DashboardClient;
  counts: ScanCounts;
  cfgPath: string;
}

function withBackend({ usage }: { usage?: Record<string, unknown> }, fn: (harness: UsageHarness) => Promise<void>) {
  return async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-usage-'));
    const projectDir = path.join(tmpDir, 'project');
    const claudeHome = path.join(tmpDir, 'claude');
    fs.mkdirSync(projectDir);
    writeTranscriptFixture(claudeHome);

    const cfgPath = path.join(tmpDir, 'config.json');
    const cfg: Record<string, unknown> = {
      projects: [{ id: SESSION_ID, name: 'usage probe', path: projectDir, resumeSessionId: CLAUDE_SESSION_ID }],
      teams: [],
      repoRoots: [],
      checkForUpdates: false,
    };
    if (usage) cfg.usage = usage;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    const prevEnv = process.env.GLISSA_CONFIG;
    process.env.GLISSA_CONFIG = cfgPath;

    const probe = makeUsageProbe(claudeHome);
    const server = http.createServer();
    const backend = createBackend(server, { staticDir: null, usageWiringOptions: probe.options });
    server.on('request', backend.app);
    await listenOnLoopback(server);
    const dash = await dashboardClient(boundPort(server));

    try {
      await fn({ dash, counts: probe.counts, cfgPath });
    } finally {
      backend.shutdown();
      server.closeAllConnections();
      await closeServer(server);
      if (prevEnv == null) delete process.env.GLISSA_CONFIG;
      if (prevEnv != null) process.env.GLISSA_CONFIG = prevEnv;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

function openControl(dash: DashboardClient, pathAndSearch = '/control') {
  return openRecordingSocket<ControlFrame>(dash, pathAndSearch);
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + MESSAGE_WAIT_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function settle(ms = 250): Promise<void> {
  return new Promise((resolve) => { setTimeout(() => resolve(), ms); });
}

test('no transcript is read until the first control connection, then the boot pass runs once', withBackend({}, async ({ dash, counts }) => {
  await settle();
  assert.equal(counts.scanners, 0, 'cold boot constructs no scanner');
  assert.equal(counts.readdir, 0, 'cold boot walks no directory');
  assert.equal(counts.open, 0, 'cold boot reads no transcript');

  const first = await openControl(dash);
  await waitForMessage(first.received, isUsageSessions, 'the first usage-sessions push');
  assert.equal(counts.scanners, 1);
  assert.ok(counts.readdir > 0, 'the deferred boot pass walked the transcript tree');
  assert.ok(counts.open > 0, 'the deferred boot pass read the transcript');

  const second = await openControl(dash);
  await waitForMessage(second.received, isUsageSessions, 'usage-sessions replayed to a later client');
  assert.equal(counts.scanners, 1, 'a second connection reuses the warm scanner');

  await closeSocket(first.ws);
  await closeSocket(second.ws);
}));

test('usage-sessions attributes the fixture transcript to the card through its live Claude session id', withBackend({}, async ({ dash }) => {
  const client = await openControl(dash);
  const message = await waitForMessage(client.received, isUsageSessions, 'usage-sessions');

  assert.equal(message.pricingSource, 'snapshot');
  assert.equal(typeof message.ts, 'number');
  assert.deepEqual(message.sessions.map((row) => row.id), [SESSION_ID]);
  const row = message.sessions[0];
  assert.equal(row.tokens, 375, 'both transcript lines counted (100+50 and 200+25)');
  assert.ok(row.costUSD > 0, 'priced from the committed snapshot');
  assert.equal(typeof row.lastTs, 'number');

  await closeSocket(client.ws);
}));

test('request-usage-report replies to the requesting socket only, with the full report shape', withBackend({}, async ({ dash }) => {
  const asker = await openControl(dash);
  await waitForMessage(asker.received, isUsageSessions, 'the boot push');
  const bystander = await openControl(dash);
  await waitForMessage(bystander.received, isUsageSessions, 'the bystander connect replay');
  bystander.received.length = 0;

  asker.ws.send(JSON.stringify({ type: 'request-usage-report', requestId: 'r1', days: 30 }));
  const report = await waitForMessage(asker.received, isUsageReport, 'usage-report');

  assert.equal(report.requestId, 'r1');
  assert.equal(report.error, null);
  assert.equal(report.warning, null);
  assert.equal(report.blockHours, 5);
  assert.equal(report.totals?.tokens, 375);
  assert.equal(report.totals?.input, 300);
  assert.equal(report.totals?.output, 75);
  assert.equal(report.daily?.length, 1, 'both entries land in one local-tz day');
  assert.deepEqual(report.models?.map((m) => m.model), [MODEL]);
  assert.equal(report.sessions?.length, 1);
  assert.ok((report.blocks?.length ?? 0) >= 1);
  assert.ok(report.activeBlock, 'the fixture entries are minutes old, so the block is still active');
  assert.equal(report.pricing?.source, 'snapshot');
  assert.deepEqual(report.pricing?.missing, []);
  assert.equal(report.scan?.files, 1);
  assert.equal(report.scan?.entries, 2);
  assert.equal(report.scan?.partial, false);
  assert.equal(report.scan?.dirs.length, 1);

  await settle();
  assert.equal(bystander.received.filter(isUsageReport).length, 0, 'the report is replied, never broadcast');

  const latecomer = await openControl(dash);
  const replayed = await waitForMessage(latecomer.received, isUsageReport, 'the replayed report');
  assert.equal(replayed.requestId, null);
  assert.equal(replayed.totals?.tokens, 375);

  await closeSocket(asker.ws);
  await closeSocket(bystander.ws);
  await closeSocket(latecomer.ws);
}));

test('usage.enabled false: no scanner, no messages, and a refused report request', withBackend({ usage: { enabled: false } }, async ({ dash, counts }) => {
  const client = await openControl(dash);
  await waitForMessage(client.received, isSnapshot, 'the snapshot');
  await settle();

  assert.equal(counts.scanners, 0, 'a disabled lane constructs no scanner');
  assert.equal(counts.readdir, 0, 'a disabled lane walks no directory');
  assert.equal(client.received.filter(isUsageSessions).length, 0, 'no usage message on the wire');

  client.ws.send(JSON.stringify({ type: 'request-usage-report', requestId: 'r9' }));
  const report = await waitForMessage(client.received, isUsageReport, 'the refusal');
  assert.equal(report.requestId, 'r9');
  assert.ok(report.error, 'the refusal names a reason');
  assert.match(report.error, /disabled/);
  assert.equal(report.totals, undefined, 'a refusal carries no report body');
  assert.equal(counts.scanners, 0, 'the refused request still constructed nothing');

  await closeSocket(client.ws);
}));

test('a settings save restarts the lane only when the usage block actually changed', withBackend({}, async ({ dash, counts }) => {
  const client = await openControl(dash);
  await waitForMessage(client.received, isUsageSessions, 'the boot push');
  assert.equal(counts.scanners, 1);

  client.ws.send(JSON.stringify({ type: 'update-settings', requestId: 's1', settings: { cursorBlink: true } }));
  await waitForMessage(client.received, settingsUpdatedFor('s1'), 'the unrelated save');
  await settle();
  assert.equal(counts.scanners, 1, 'a save that touches no usage key leaves the warm scanner alone');

  client.ws.send(JSON.stringify({
    type: 'update-settings',
    requestId: 's2',
    settings: { usage: { enabled: true, fetchPricing: false, scanIntervalMinutes: 7, costMode: 'calculate' } },
  }));
  const updated = await waitForMessage(client.received, settingsUpdatedFor('s2'), 'the usage save');
  await waitUntil(() => counts.scanners === 2, 'the lane to restart with a fresh scanner');

  assert.deepEqual(updated.settings.usage, { enabled: true, fetchPricing: false, scanIntervalMinutes: 7, costMode: 'calculate' });

  await closeSocket(client.ws);
}));


type PassResult = Awaited<ReturnType<ReturnType<typeof createUsageScanner>['runPass']>>;
type PassArgs = Parameters<ReturnType<typeof createUsageScanner>['runPass']>[0];

function scriptedScanner(passes: PassArgs[], passResults: PassResult[]) {
  const scanner = createUsageScanner({ env: {}, homeDir: path.join(os.tmpdir(), 'glissa-usage-nowhere') });
  scanner.runPass = async (args?: PassArgs) => {
    passes.push(args);
    return passResults[Math.min(passes.length - 1, passResults.length - 1)];
  };
  return scanner;
}

function stubScannerWiring({ passResults, clients = 1 }: { passResults: PassResult[]; clients?: number }) {
  const passes: PassArgs[] = [];
  const scanner = scriptedScanner(passes, passResults);
  const wiring = createUsageWiring({
    config: {},
    sessions: new Map(),
    controlClientCount: () => clients,
    createScanner: () => scanner,
    loadPricingFn: async () => ({ table: new Map(), source: 'snapshot', fetchedAt: null }),
    partialContinueMs: 10,
    logger: { warn: () => {}, log: () => {} },
  });
  return { wiring, passes };
}

const PARTIAL_PASS: PassResult = { files: 1, entries: 1, newEntries: 1, partial: true, durationMs: 1 };
const COMPLETE_PASS: PassResult = { files: 1, entries: 1, newEntries: 0, partial: false, durationMs: 1 };

test('a partial pass is continued on the short timer until the scan completes', async () => {
  const { wiring, passes } = stubScannerWiring({ passResults: [PARTIAL_PASS, PARTIAL_PASS, COMPLETE_PASS] });
  await wiring.start();
  assert.equal(passes.length, 1, 'the boot pass');

  await waitUntil(() => passes.length === 3, 'the truncated scan to be continued to completion');
  await settle(60);
  assert.equal(passes.length, 3, 'a complete pass schedules no further continuation');
  await wiring.stop();
});

test('a partial pass is not continued while no dashboard is connected', async () => {
  const { wiring, passes } = stubScannerWiring({ passResults: [PARTIAL_PASS], clients: 0 });
  await wiring.start();
  assert.equal(passes.length, 1);

  await settle(80);
  assert.equal(passes.length, 1, 'nobody is looking, so the tree is left for the next interval tick');
  await wiring.stop();
});

test('stop() cancels a pending continuation', async () => {
  const { wiring, passes } = stubScannerWiring({ passResults: [PARTIAL_PASS] });
  await wiring.start();
  await wiring.stop();

  await settle(80);
  assert.equal(passes.length, 1, 'no pass runs after stop');
});

test('a config with no usage block never materializes one on an unrelated save', withBackend({}, async ({ dash, cfgPath }) => {
  const client = await openControl(dash);
  await waitForMessage(client.received, isSnapshot, 'the snapshot');

  client.ws.send(JSON.stringify({ type: 'update-settings', requestId: 'u1', settings: { cursorBlink: false } }));
  const updated = await waitForMessage(client.received, settingsUpdatedFor('u1'), 'the save');
  assert.equal(updated.settings.usage, null, 'getSettings echoes null while the block is unconfigured');
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).usage, undefined, 'config.json still has no usage key');

  await closeSocket(client.ws);
}));

test('a settings restart during an in-flight start arms the NEW interval cadence', async () => {
  const gate: { release: (() => void) | null } = { release: null };
  const firstPassGate = new Promise<void>((resolve) => { gate.release = resolve; });
  const armed: { ms: number; handle: NodeJS.Timeout }[] = [];
  const cleared: NodeJS.Timeout[] = [];
  const counted = { passes: 0 };
  const scanner = createUsageScanner({ env: {}, homeDir: path.join(os.tmpdir(), 'glissa-usage-nowhere') });
  scanner.runPass = async () => {
    counted.passes += 1;
    if (counted.passes === 1) await firstPassGate;
    return { files: 0, entries: 0, newEntries: 0, partial: false, durationMs: 1 };
  };
  const config: { usage: Record<string, unknown> } = { usage: { scanIntervalMinutes: 1 } };
  const wiring = createUsageWiring({
    config,
    sessions: new Map(),
    controlClientCount: () => 1,
    createScanner: () => scanner,
    loadPricingFn: async () => ({ table: new Map(), source: 'snapshot', fetchedAt: null }),
    setIntervalFn: (fn: () => void, ms: number) => {
      const handle = setInterval(fn, ms);
      handle.unref();
      armed.push({ ms, handle });
      return handle;
    },
    clearIntervalFn: (handle: NodeJS.Timeout) => { cleared.push(handle); clearInterval(handle); },
    logger: { warn: () => {}, log: () => {} },
  });

  const startPending = wiring.start();
  config.usage = { scanIntervalMinutes: 7 };
  wiring.restartIfConfigChanged();
  assert.ok(gate.release, 'the first pass gate is armed');
  gate.release();
  await startPending;

  const wantedMs = 7 * 60 * 1000;
  for (let i = 0; i < 200 && !armed.some((entry) => entry.ms === wantedMs); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(armed.some((entry) => entry.ms === wantedMs), 'the restarted lane armed the new cadence');
  for (const entry of armed.filter((candidate) => candidate.ms !== wantedMs)) {
    assert.ok(cleared.includes(entry.handle), 'every stale interval from the aborted start was cleared');
  }
  await wiring.stop();
});
