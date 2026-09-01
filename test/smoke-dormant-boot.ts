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

  await delay(200);

  console.log('\nSnapshot:');
  const snapshot = events.find((e) => e.type === 'snapshot');
  assert('snapshot received', !!snapshot);
  assert('snapshot has sessions', !!snapshot && Array.isArray(snapshot.sessions));
  const sessions = snapshot?.sessions || [];
  assert(`all ${sessions.length} sessions are DORMANT`, !!snapshot && sessions.every((s) => s.state === 'DORMANT'));

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

    const otherChanges = events.filter((e) =>
      e.type === 'state-change' && e.id !== target.id,
    );
    assert('other sessions remain dormant (no spurious state-changes)', otherChanges.length === 0);

    assertSpawnStrategy(target);
  }

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
