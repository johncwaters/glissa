// Smoke test: verifies dormant-by-default boot and start-session control flow.
// Runs the server in-process so it shuts down cleanly when the test exits.

import http from 'node:http';
import WebSocket from 'ws';

import { createBackend } from '../server/backend.ts';
import { claudeCommand } from '../session/sessions.ts';

interface SnapshotSession {
  id: string;
  name: string;
  state: string;
}

interface ControlEvent {
  type?: string;
  sessions?: SnapshotSession[];
  id?: string;
  from?: string;
  to?: string;
}

const PORT = 3098;
process.env.GLISSA_PORT = String(PORT);

// Tee console.log so we can assert on the per-session spawn line emitted by sessions.ts.
const logLines: string[] = [];
const origConsoleLog = console.log.bind(console);
console.log = (...a: unknown[]) => { logLines.push(a.map(String).join(' ')); origConsoleLog(...a); };

let passed = 0;
let failed = 0;
function assert(label: string, cond: boolean): void {
  if (cond) { console.log(`  PASS  ${label}`); passed++; return; }
  console.error(`  FAIL  ${label}`); failed++;
}

function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

// Best-effort: when claude resolves to a real .exe, the spawn must go direct
// (no cmd.exe /c shim layer). Skips on hosts where claude is a .cmd/.ps1 shim.
function assertSpawnStrategy(target: SnapshotSession): void {
  console.log('\nSpawn strategy:');
  const claudeCmd = claudeCommand();
  const isDirectExeSpawn = process.platform === 'win32' && claudeCmd && claudeCmd.kind === 'exe';
  if (!isDirectExeSpawn) {
    origConsoleLog('  SKIP  direct-exe spawn assertion (claude is not a .exe on this host)');
    return;
  }
  const spawnLine = logLines.find(
    (l) => l.includes(`[session ${target.id}]`) && l.includes('spawn:'),
  );
  assert('spawn log line captured for target session', !!spawnLine);
  assert('direct exe spawn (resolved .exe present, no cmd.exe /c)',
    !!spawnLine && !!claudeCmd.path && spawnLine.includes(claudeCmd.path) && !spawnLine.includes('cmd.exe /c'));
}

async function main(): Promise<void> {
  const httpServer = http.createServer();
  const backend = createBackend(httpServer, { staticDir: null });
  // The app has to be mounted to reach /control-token: the dashboard channels need the page token.
  httpServer.on('request', backend.app);
  await new Promise<void>((r) => { httpServer.listen(PORT, '127.0.0.1', () => r()); });

  const { token } = await (await fetch(`http://127.0.0.1:${PORT}/control-token`)).json() as { token: string };
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/control?token=${token}`, { origin: `http://127.0.0.1:${PORT}` });
  const events: ControlEvent[] = [];
  ws.on('message', (raw) => {
    try { events.push(JSON.parse(raw.toString())); } catch {}
  });
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });

  // Wait briefly for initial snapshot
  await delay(200);

  console.log('\nSnapshot:');
  const snapshot = events.find((e) => e.type === 'snapshot');
  assert('snapshot received', !!snapshot);
  assert('snapshot has sessions', !!snapshot && Array.isArray(snapshot.sessions));
  const sessions = snapshot?.sessions || [];
  assert(`all ${sessions.length} sessions are DORMANT`, !!snapshot && sessions.every((s) => s.state === 'DORMANT'));

  // Pick one session and start it
  const target = sessions[0];
  if (target) {
    console.log(`\nStart-session for "${target.name}" (${target.id}):`);
    ws.send(JSON.stringify({ type: 'start-session', id: target.id }));

    await delay(500);

    const stateChanges = events.filter((e) =>
      e.type === 'state-change' && e.id === target.id,
    );
    const firstChange = stateChanges[0];
    assert('state-change broadcast received', !!firstChange);
    assert('first transition is DORMANT -> INITIALIZING',
      !!firstChange && firstChange.from === 'DORMANT' && firstChange.to === 'INITIALIZING');

    // Verify other sessions remained dormant (no spurious spawns)
    const otherChanges = events.filter((e) =>
      e.type === 'state-change' && e.id !== target.id,
    );
    assert('other sessions remain dormant (no spurious state-changes)', otherChanges.length === 0);

    assertSpawnStrategy(target);
  }

  // Cleanup
  ws.close();
  backend.shutdown();
  httpServer.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error('Test crashed:', err);
  process.exit(2);
});
