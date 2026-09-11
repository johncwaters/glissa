import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Browser } from 'playwright-core';

import { resolveWorktreeGitDir } from '../../detection/worktree-watch.ts';
import { isolateTranscriptHomes } from '../../tests/helpers/transcript-homes.ts';
import { findFreeHighPort, removeHarnessTempDirectory, safeTextTail } from '../support/backend-harness.ts';
import { casesFor } from './cases-core.ts';
import type { HarnessCase } from './cases-core.ts';
import {
  EXIT_HARNESS_ERROR,
  PROVE_FAILURE_SCENARIO,
  decideExitCode,
  renderMarkdown,
  renderProveFailureCheck,
  summarize,
} from './report-core.ts';
import type { BrowserRunReport, CaseRecord, SurvivorCheck } from './report-core.ts';
import { COLD_START_PAGE_READY_MS, DEFAULT_DEADLINES, errorText, runCase } from './runner.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DEFAULT_ARTIFACTS_DIR = path.join(REPO_ROOT, 'test', 'browser', 'artifacts');
const FAKE_AGENT_PATH = path.join(import.meta.dirname, 'fake-agent.ts');
const REFUSED_LIFECYCLE_EVENTS = new Set(['build', 'start', 'prepare', 'postinstall']);
const LEFTOVER_SCAN_ATTEMPTS = 25;
const LEFTOVER_SCAN_INTERVAL_MS = 200;
const PROCESS_LISTING_MAX_BYTES = 8 * 1024 * 1024;

interface HarnessOptions {
  only: string[];
  viewportNames: string[];
  artifactsDir: string;
  proveFailure: boolean;
  headed: boolean;
  executablePath: string | null;
  unknownArguments: string[];
  flagsMissingValues: string[];
}

const APPLY_VALUE_BY_FLAG = new Map<string, (options: HarnessOptions, value: string) => void>([
  ['--only', (options, value) => { options.only.push(value); }],
  ['--viewport', (options, value) => { options.viewportNames.push(value); }],
  ['--artifacts', (options, value) => { options.artifactsDir = path.resolve(value); }],
  ['--executable', (options, value) => { options.executablePath = path.resolve(value); }],
]);

function valueFollowing(argv: readonly string[], flagIndex: number): string | null {
  const value = argv[flagIndex + 1];
  if (value === undefined) return null;
  if (value.startsWith('--')) return null;
  return value;
}

function parseArguments(argv: readonly string[]): HarnessOptions {
  const options: HarnessOptions = {
    only: [],
    viewportNames: [],
    artifactsDir: DEFAULT_ARTIFACTS_DIR,
    proveFailure: false,
    headed: false,
    executablePath: null,
    unknownArguments: [],
    flagsMissingValues: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === '--prove-failure') {
      options.proveFailure = true;
      continue;
    }
    if (argument === '--headed') {
      options.headed = true;
      continue;
    }
    const applyValue = APPLY_VALUE_BY_FLAG.get(argument);
    if (!applyValue) {
      options.unknownArguments.push(argument);
      continue;
    }
    const value = valueFollowing(argv, index);
    if (value === null) {
      options.flagsMissingValues.push(argument);
      continue;
    }
    applyValue(options, value);
    index += 1;
  }
  return options;
}

function readRepoHead(): string {
  try {
    const gitDir = resolveWorktreeGitDir(REPO_ROOT) ?? path.join(REPO_ROOT, '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head;
    const refPath = head.slice('ref: '.length).trim();
    const commonDir = path.join(gitDir, 'commondir');
    const resolvedCommon = fs.existsSync(commonDir)
      ? path.resolve(gitDir, fs.readFileSync(commonDir, 'utf8').trim())
      : gitDir;
    const looseRef = path.join(resolvedCommon, refPath);
    if (fs.existsSync(looseRef)) return fs.readFileSync(looseRef, 'utf8').trim();
    return refPath;
  } catch {
    return 'unknown';
  }
}

function readPlaywrightVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(REPO_ROOT, 'node_modules', 'playwright-core', 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function writeConfigDocument(configPath: string, port: number, cases: HarnessCase[], sessionIds: string[], projectDirs: string[]): void {
  const projects = cases.map((harnessCase, index) => ({
    id: sessionIds[index],
    name: `${harnessCase.viewport.name}-${harnessCase.scenario.name}`,
    path: projectDirs[index],
    agent: 'claude-code',
    dangerouslySkipPermissions: false,
  }));
  const configDocument = {
    port,
    projects,
    teams: [],
    repoRoots: [],
    millEnabled: false,
    autoResume: false,
    worktreeAutoRebase: false,
    worktreeSyncOnStart: false,
    branchGc: { enabled: false },
    usage: { enabled: false },
    capture: { enabled: false },
    recordSignals: false,
    postTurnChecks: { enabled: false },
    packDistiller: { enabled: false },
    checkForUpdates: false,
    planReview: { enabled: true },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(configDocument, null, 2)}\n`, 'utf8');
}

function writeAgentShim(shimDirectory: string): string {
  fs.mkdirSync(shimDirectory, { recursive: true });
  const shimPath = path.join(shimDirectory, 'claude');
  const body = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_AGENT_PATH)} "$@"\n`;
  fs.writeFileSync(shimPath, body, 'utf8');
  fs.chmodSync(shimPath, 0o755);
  return shimPath;
}

interface FakeAgentScan extends SurvivorCheck {
  leftoverPids: number[];
  unavailableReason: string | null;
}

function scanProcForFakeAgents(procRoot: string): FakeAgentScan {
  const leftoverPids: number[] = [];
  for (const entry of fs.readdirSync(procRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const commandLine = fs.readFileSync(path.join(procRoot, entry, 'cmdline'), 'utf8');
      if (!commandLine.includes(FAKE_AGENT_PATH)) continue;
      leftoverPids.push(Number(entry));
    } catch {}
  }
  return { available: true, leftoverPids, unavailableReason: null };
}

function scanProcessListingForFakeAgents(): FakeAgentScan {
  try {
    const listing = execFileSync('ps', ['-Ao', 'pid,args'], {
      encoding: 'utf8',
      maxBuffer: PROCESS_LISTING_MAX_BYTES,
    });
    const leftoverPids: number[] = [];
    for (const line of listing.split('\n')) {
      if (!line.includes(FAKE_AGENT_PATH)) continue;
      const pid = /^\s*(\d+)\s/.exec(line)?.[1];
      if (pid === undefined) continue;
      leftoverPids.push(Number(pid));
    }
    return { available: true, leftoverPids, unavailableReason: null };
  } catch (error) {
    return { available: false, leftoverPids: [], unavailableReason: `ps -Ao pid,args failed: ${safeTextTail(error, 300)}` };
  }
}

function scanForFakeAgents(): FakeAgentScan {
  if (fs.existsSync('/proc')) return scanProcForFakeAgents('/proc');
  if (process.platform === 'darwin') return scanProcessListingForFakeAgents();
  return {
    available: false,
    leftoverPids: [],
    unavailableReason: `no process listing is available on ${process.platform}`,
  };
}

async function waitForFakeAgentsToExit(): Promise<FakeAgentScan> {
  let scan = scanForFakeAgents();
  for (let attempt = 0; attempt < LEFTOVER_SCAN_ATTEMPTS && scan.available && scan.leftoverPids.length > 0; attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, LEFTOVER_SCAN_INTERVAL_MS); });
    scan = scanForFakeAgents();
  }
  return scan;
}

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function main(): Promise<number> {
  if (process.platform === 'win32') {
    console.error('the browser harness runs on Linux and macOS only: the agent shim it spawns is a POSIX sh script');
    return EXIT_HARNESS_ERROR;
  }
  const lifecycleEvent = process.env.npm_lifecycle_event ?? '';
  if (REFUSED_LIFECYCLE_EVENTS.has(lifecycleEvent)) {
    console.error(`the browser harness refuses to run inside the ${lifecycleEvent} lifecycle script`);
    return EXIT_HARNESS_ERROR;
  }

  const options = parseArguments(process.argv.slice(2));
  if (options.unknownArguments.length > 0) {
    console.error(`unrecognised harness argument: ${options.unknownArguments.join(' ')}`);
    return EXIT_HARNESS_ERROR;
  }
  if (options.flagsMissingValues.length > 0) {
    console.error(`harness flag needs a value: ${options.flagsMissingValues.join(' ')}`);
    return EXIT_HARNESS_ERROR;
  }
  const cases = casesFor({
    only: options.only.length > 0 ? options.only : undefined,
    viewportNames: options.viewportNames.length > 0 ? options.viewportNames : undefined,
    proveFailure: options.proveFailure,
  });
  if (cases.length === 0) {
    console.error('no case matched the requested scenarios and viewports');
    return EXIT_HARNESS_ERROR;
  }

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDirectory = path.join(options.artifactsDir, runId);
  const artifacts = {
    shotsDir: path.join(runDirectory, 'shots'),
    diffsDir: path.join(runDirectory, 'diffs'),
    logsDir: path.join(runDirectory, 'logs'),
  };
  for (const directory of [runDirectory, artifacts.shotsDir, artifacts.diffsDir, artifacts.logsDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-browser-'));
  const previousEnvironment = {
    GLISSA_HOME: process.env.GLISSA_HOME,
    GLISSA_CONFIG: process.env.GLISSA_CONFIG,
    GLISSA_PORT: process.env.GLISSA_PORT,
    PATH: process.env.PATH,
  };
  const restoreTranscriptHomes = isolateTranscriptHomes(tempDirectory);

  let browser: Browser | null = null;
  let vite: { close: () => Promise<void> } | null = null;
  let cleanUpRun: Promise<void> | null = null;
  let fakeAgentScan: FakeAgentScan = {
    available: false,
    leftoverPids: [],
    unavailableReason: 'the harness never reached its cleanup',
  };

  const cleanUp = (): Promise<void> => {
    if (cleanUpRun) return cleanUpRun;
    cleanUpRun = (async () => {
      try {
        if (browser) await browser.close();
      } catch (error) {
        console.error(`browser cleanup failed: ${safeTextTail(error, 400)}`);
      }
      try {
        if (vite) await vite.close();
      } catch (error) {
        console.error(`vite cleanup failed: ${safeTextTail(error, 400)}`);
      }
      fakeAgentScan = await waitForFakeAgentsToExit();
      removeHarnessTempDirectory(tempDirectory);
      restoreTranscriptHomes();
      for (const [name, value] of Object.entries(previousEnvironment)) {
        restoreEnvironmentVariable(name, value);
      }
    })();
    return cleanUpRun;
  };

  const onSignal = (signalName: string) => {
    void (async () => {
      console.error(`received ${signalName}, tearing the harness down`);
      await cleanUp();
      process.exit(130);
    })();
  };
  const onSigint = () => { onSignal('SIGINT'); };
  const onSigterm = () => { onSignal('SIGTERM'); };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  const startedAt = Date.now();
  const records: CaseRecord[] = [];

  try {
    const projectDirs = cases.map((_, index) => path.join(tempDirectory, 'projects', `case-${index}`));
    for (const projectDirectory of projectDirs) fs.mkdirSync(projectDirectory, { recursive: true });
    const sessionIds = cases.map(() => crypto.randomUUID());
    const port = await findFreeHighPort();
    const configPath = path.join(tempDirectory, 'config.json');
    writeConfigDocument(configPath, port, cases, sessionIds, projectDirs);

    const glissaHome = path.join(tempDirectory, 'home');
    fs.mkdirSync(glissaHome, { recursive: true });
    process.env.GLISSA_HOME = glissaHome;
    process.env.GLISSA_CONFIG = configPath;
    process.env.GLISSA_PORT = String(port);
    const shimDirectory = path.join(tempDirectory, 'shim');
    writeAgentShim(shimDirectory);
    process.env.PATH = `${shimDirectory}${path.delimiter}${previousEnvironment.PATH ?? ''}`;

    const { createServer } = await import('vite');
    const devServer = await createServer({
      configFile: path.join(REPO_ROOT, 'vite.config.ts'),
      server: { port, strictPort: true, host: '127.0.0.1' },
      logLevel: 'warn',
      clearScreen: false,
    });
    await devServer.listen();
    vite = devServer;
    const baseUrl = `http://127.0.0.1:${port}/`;

    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({
      headless: !options.headed,
      ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    });

    for (const [index, harnessCase] of cases.entries()) {
      const sessionId = sessionIds[index] ?? '';
      const deadlines = index === 0
        ? { ...DEFAULT_DEADLINES, pageReadyMs: COLD_START_PAGE_READY_MS }
        : DEFAULT_DEADLINES;
      const record = await runCase({ browser, harnessCase, sessionId, baseUrl, artifacts, deadlines });
      records.push(record);
      console.log(`${record.outcome.padEnd(7)} ${record.viewport} / ${record.scenario} (${record.durationMs}ms)`);
    }
  } catch (error) {
    console.error(`harness crashed: ${errorText(error)}`);
    await cleanUp();
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    return EXIT_HARNESS_ERROR;
  }

  const report: BrowserRunReport = {
    version: 1,
    runId,
    startedAt,
    finishedAt: Date.now(),
    repoHead: readRepoHead(),
    node: process.version,
    playwrightCore: readPlaywrightVersion(),
    totals: summarize(records),
    cases: records,
  };
  const reportJsonPath = path.join(runDirectory, 'report.json');
  const reportMarkdownPath = path.join(runDirectory, 'report.md');
  fs.writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(reportMarkdownPath, renderMarkdown(report), 'utf8');

  await cleanUp();
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);

  console.log(`wall time ${((report.finishedAt - report.startedAt) / 1000).toFixed(1)}s over ${records.length} cases`);

  const selfCheck = renderProveFailureCheck(report);
  if (options.proveFailure) {
    console.log(`${PROVE_FAILURE_SCENARIO}: ${selfCheck.ok ? 'ok' : 'NOT ok'} ${selfCheck.detail}`);
  }
  if (!fakeAgentScan.available) {
    console.error(`the surviving fake agent check could not run: ${fakeAgentScan.unavailableReason ?? 'no reason recorded'}`);
  }
  if (fakeAgentScan.leftoverPids.length > 0) {
    console.error(`fake agents survived the run: ${fakeAgentScan.leftoverPids.join(', ')}`);
  }
  console.log(`report: ${reportMarkdownPath}`);
  return decideExitCode({
    report,
    proveFailure: options.proveFailure,
    selfCheck,
    survivors: fakeAgentScan,
  });
}

process.exitCode = await main();
