import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BURST_CAP, paintFull, repaintInPlace } from './frame-core.ts';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const WORKING_GLYPH = String.fromCharCode(0x280b);
const IDLE_GLYPH = String.fromCharCode(0x2733);
const SESSION_ID = '00000000-0000-4000-8000-0000000fa4e0';
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_BURST_LINES = 100;
const WRITE_CHUNK_CAP_CHARS = 64 * 1024;
const PLAN_BODY = '# Fake agent plan\n\nOne step, so the reviewer has something to decide on.\n';

interface HookEndpoint {
  base: string;
  query: string;
}

const screen = { cols: DEFAULT_COLS, rows: DEFAULT_ROWS, tick: 0 };

function settingsPathFromArgv(argv: string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg.startsWith('--settings=')) return arg.slice('--settings='.length);
    if (arg === '--settings') return argv[index + 1] ?? null;
  }
  return null;
}

function firstHttpHookUrl(settings: unknown): string | null {
  if (!settings || typeof settings !== 'object') return null;
  const hooks = (settings as { hooks?: unknown }).hooks;
  if (!hooks || typeof hooks !== 'object') return null;
  for (const entries of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const inner = (entry as { hooks?: unknown })?.hooks;
      if (!Array.isArray(inner)) continue;
      for (const hook of inner) {
        const candidate = hook as { type?: unknown; url?: unknown };
        if (candidate?.type !== 'http') continue;
        if (typeof candidate.url !== 'string' || candidate.url.length === 0) continue;
        return candidate.url;
      }
    }
  }
  return null;
}

function endpointFromUrl(rawUrl: string): HookEndpoint | null {
  let parsed: URL | null = null;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  const hookIndex = segments.indexOf('hook');
  if (hookIndex < 0) return null;
  const glissaId = segments[hookIndex + 1];
  if (!glissaId) return null;
  return { base: `${parsed.origin}/hook/${glissaId}`, query: parsed.search };
}

function readEndpoint(settingsPath: string | null): HookEndpoint | null {
  if (!settingsPath) return null;
  try {
    const url = firstHttpHookUrl(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
    if (!url) return null;
    return endpointFromUrl(url);
  } catch {
    return null;
  }
}

const endpoint = readEndpoint(settingsPathFromArgv(process.argv.slice(2)));

function postHook(event: string, payload: Record<string, unknown>): void {
  if (!endpoint) return;
  fetch(`${endpoint.base}/${event}${endpoint.query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: SESSION_ID, cwd: process.cwd(), ...payload }),
  }).catch(() => {});
}

function setTitle(glyph: string, label: string): void {
  process.stdout.write(`${ESC}]0;${glyph} ${label}${BEL}`);
}

function readSize(): void {
  screen.cols = process.stdout.columns || DEFAULT_COLS;
  screen.rows = process.stdout.rows || DEFAULT_ROWS;
}

function paint(): void {
  process.stdout.write(paintFull(screen.cols, screen.rows, screen.tick));
}

function burstCount(argument: string): number {
  const requested = Number.parseInt(argument, 10);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_BURST_LINES;
  return Math.min(requested, BURST_CAP);
}

function writeBurst(count: number): void {
  let chunk = '';
  for (let line = 0; line < count; line += 1) {
    chunk += `burst ${line}\r\n`;
    if (chunk.length < WRITE_CHUNK_CAP_CHARS) continue;
    process.stdout.write(chunk);
    chunk = '';
  }
  if (chunk.length > 0) process.stdout.write(chunk);
}

function writePlanFile(): string {
  const planFilePath = path.join(os.tmpdir(), `fake-agent-plan-${process.pid}.md`);
  try {
    fs.writeFileSync(planFilePath, PLAN_BODY, 'utf8');
  } catch {}
  return planFilePath;
}

function requestPlanReview(): void {
  postHook('permissionrequest-plan', {
    hook_event_name: 'PermissionRequest',
    tool_name: 'ExitPlanMode',
    tool_input: { plan: PLAN_BODY, planFilePath: writePlanFile() },
  });
}

function dispatch(command: string): void {
  if (command === 'frame') {
    screen.tick += 1;
    process.stdout.write(repaintInPlace(screen.cols, screen.rows, screen.tick));
    return;
  }
  if (command === 'burst' || command.startsWith('burst ')) {
    writeBurst(burstCount(command.slice('burst'.length).trim()));
    screen.tick += 1;
    paint();
    return;
  }
  if (command === 'plan') {
    requestPlanReview();
    return;
  }
  if (command === 'stop') {
    postHook('stop', { hook_event_name: 'Stop', stop_hook_active: false });
    setTitle(IDLE_GLYPH, 'idle');
    return;
  }
  if (command === 'exit') process.exit(0);
}

let pending = '';

function onInput(chunk: string): void {
  pending += chunk;
  const lines = pending.split(/[\r\n]/);
  pending = lines.pop() ?? '';
  for (const line of lines) {
    const command = line.trim();
    if (command.length === 0) continue;
    dispatch(command);
  }
}

postHook('sessionstart', { hook_event_name: 'SessionStart', source: 'startup' });
setTitle(WORKING_GLYPH, 'working');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();
process.stdin.on('data', (chunk: string | Buffer) => { onInput(String(chunk)); });
process.stdin.on('end', () => { process.exit(0); });
process.stdout.on('resize', () => {
  readSize();
  paint();
});
readSize();
paint();
