'use strict';

// Smoke test: verifies dormant-by-default boot and start-session control flow.
// Runs the server in-process so it shuts down cleanly when the test exits.

const http = require('node:http');
const WebSocket = require('ws');
const { createBackend } = require('../server/backend');
const { CLAUDE_CMD } = require('../session/sessions');

const PORT = 3098;
process.env.GLISSA_PORT = String(PORT);

// Tee console.log so we can assert on the per-session spawn line emitted by sessions.js.
const logLines = [];
const origConsoleLog = console.log.bind(console);
console.log = (...a) => { logLines.push(a.map(String).join(' ')); origConsoleLog(...a); };

let passed = 0;
let failed = 0;
function assert(label, cond) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else      { console.error(`  FAIL  ${label}`); failed++; }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Best-effort: when claude resolves to a real .exe, the spawn must go direct
// (no cmd.exe /c shim layer). Skips on hosts where claude is a .cmd/.ps1 shim.
function assertSpawnStrategy(target) {
  console.log('\nSpawn strategy:');
  const isDirectExeSpawn = process.platform === 'win32' && CLAUDE_CMD && CLAUDE_CMD.kind === 'exe';
  if (!isDirectExeSpawn) {
    origConsoleLog('  SKIP  direct-exe spawn assertion (claude is not a .exe on this host)');
    return;
  }
  const spawnLine = logLines.find(
    (l) => l.includes(`[session ${target.id}]`) && l.includes('spawn:'),
  );
  assert('spawn log line captured for target session', !!spawnLine);
  assert('direct exe spawn (resolved .exe present, no cmd.exe /c)',
    !!spawnLine && spawnLine.includes(CLAUDE_CMD.path) && !spawnLine.includes('cmd.exe /c'));
}

async function main() {
  const httpServer = http.createServer();
  const backend = createBackend(httpServer, { staticDir: null });
  await new Promise(r => httpServer.listen(PORT, '127.0.0.1', r));

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/control`);
  const events = [];
  ws.on('message', (raw) => {
    try { events.push(JSON.parse(raw)); } catch {}
  });
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });

  // Wait briefly for initial snapshot
  await delay(200);

  console.log('\nSnapshot:');
  const snapshot = events.find(e => e.type === 'snapshot');
  assert('snapshot received', !!snapshot);
  assert('snapshot has sessions', snapshot && Array.isArray(snapshot.sessions));
  const allDormant = snapshot?.sessions.every(s => s.state === 'DORMANT');
  assert(`all ${snapshot?.sessions.length || 0} sessions are DORMANT`, allDormant);

  // Pick one session and start it
  if (snapshot && snapshot.sessions.length > 0) {
    const target = snapshot.sessions[0];
    console.log(`\nStart-session for "${target.name}" (${target.id}):`);
    ws.send(JSON.stringify({ type: 'start-session', id: target.id }));

    await delay(500);

    const stateChanges = events.filter(e =>
      e.type === 'state-change' && e.id === target.id,
    );
    const firstChange = stateChanges[0];
    assert('state-change broadcast received', !!firstChange);
    assert('first transition is DORMANT -> INITIALIZING',
      firstChange && firstChange.from === 'DORMANT' && firstChange.to === 'INITIALIZING');

    // Verify other sessions remained dormant (no spurious spawns)
    const otherChanges = events.filter(e =>
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

main().catch(err => {
  console.error('Test crashed:', err);
  process.exit(2);
});
