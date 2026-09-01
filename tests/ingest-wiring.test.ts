/*
 * The ingest lane IO shell (docs/plan-ingestion.md, M6), driven on injected timers with no sockets and
 * no real sessions: publish never broadcasting on its own, the 1s batch with its 50-event frame and
 * overflow count, the connect-time snapshot, the digest accessor, the session tap over a fake Session's
 * public EventEmitter surface, and a stop() that cancels every timer and detaches every tap.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  BATCH_INTERVAL_MS, MAX_EVENTS_PER_FRAME, SNAPSHOT_EVENT_LIMIT, createIngestLane,
} from '../server/ingest-wiring.ts';
import type { IngestLaneOptions } from '../server/ingest-wiring.ts';
import { resolveIngestConfig } from '../server/core/ingest-core.ts';
import { TRUNCATION_NOTE } from '../server/core/ingest-terminal-core.ts';

const NOW = 1700000000000;

// The frames this suite reads off the broadcast seam, which answers the stringly control-message shape.
interface IngestFrame {
  type: string;
  overflow: number;
  events: { summary: string; source: string }[];
  sources: string[];
  ts: number;
}

function frameOf(message: Record<string, unknown> | undefined): IngestFrame {
  if (!message) throw new Error('no frame reached the wire');
  const { type, overflow, events, sources, ts } = message;
  if (typeof type !== 'string' || !Array.isArray(events)) throw new Error('not an ingest frame');
  return {
    type,
    overflow: typeof overflow === 'number' ? overflow : 0,
    events: events.map((event: unknown) => {
      if (typeof event !== 'object' || event === null) throw new Error('an ingest frame carries events');
      const { summary, source } = event as { summary?: unknown; source?: unknown };
      return { summary: String(summary), source: String(source) };
    }),
    sources: Array.isArray(sources) ? sources.map(String) : [],
    ts: typeof ts === 'number' ? ts : 0,
  };
}

// A Session as the tap sees it: an EventEmitter with an id and a cwd, nothing else. The tap must never
// need more than the public surface, because session/sessions.ts is not modified by this milestone.
class FakeSession extends EventEmitter {
  id: string;

  private readonly cwd: string;

  constructor(id = 'session-1', cwd = '/repo') {
    super();
    this.id = id;
    this.cwd = cwd;
  }

  effectiveCwd(): string {
    return this.cwd;
  }
}

interface FakeTimers {
  setIntervalFn: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn: (handle: NodeJS.Timeout) => void;
  setTimeoutFn: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn: (handle: NodeJS.Timeout) => void;
  runIntervals: () => void;
  runTimeouts: () => void;
  readonly intervalCount: number;
  readonly timeoutCount: number;
}

// Timers the suite fires by hand. Each handle is a REAL unref'd timer that never runs a callback of its
// own, because the lane's seams are typed against NodeJS.Timeout; the callback rides a side map.
function fakeTimers(): FakeTimers {
  const intervals = new Map<NodeJS.Timeout, () => void>();
  const timeouts = new Map<NodeJS.Timeout, () => void>();
  const park = (): NodeJS.Timeout => {
    const handle = setTimeout(() => {}, 2 ** 30);
    handle.unref();
    return handle;
  };
  return {
    setIntervalFn: (fn) => {
      const handle = park();
      intervals.set(handle, fn);
      return handle;
    },
    clearIntervalFn: (handle) => { clearTimeout(handle); intervals.delete(handle); },
    setTimeoutFn: (fn) => {
      const handle = park();
      timeouts.set(handle, fn);
      return handle;
    },
    clearTimeoutFn: (handle) => { clearTimeout(handle); timeouts.delete(handle); },
    runIntervals: () => { for (const fn of [...intervals.values()]) fn(); },
    runTimeouts: () => {
      const jobs = [...timeouts.values()];
      timeouts.clear();
      for (const fn of jobs) fn();
    },
    get intervalCount() { return intervals.size; },
    get timeoutCount() { return timeouts.size; },
  };
}

interface DrivenLane {
  lane: ReturnType<typeof createIngestLane>;
  timers: FakeTimers;
  broadcasts: Record<string, unknown>[];
  warnings: string[];
  notes: string[];
  clock: { now: number };
}

function drivenLane(
  rawConfig: unknown = { enabled: true, sources: { terminal: { enabled: true } } },
  overrides: Partial<IngestLaneOptions> = {},
): DrivenLane {
  const timers = fakeTimers();
  const broadcasts: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  const clock = { now: NOW };
  const lane = createIngestLane({
    config: resolveIngestConfig(rawConfig),
    broadcast: (message) => broadcasts.push(message),
    logger: { warn: (message: string) => { warnings.push(message); }, log: (message: string) => { notes.push(message); } },
    nowFn: () => clock.now,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    ...overrides,
  });
  return { lane, timers, broadcasts, warnings, notes, clock };
}

// attachSessionTap answers null when the terminal source is off; every case here has it on.
function tapOf(tap: ReturnType<ReturnType<typeof createIngestLane>['attachSessionTap']>) {
  if (!tap) throw new Error('the terminal source is off, so nothing was tapped');
  return tap;
}

function commit(summary: string) {
  return { source: 'git', kind: 'commit', summary, scope: { root: '/repo' } };
}

// --- Lane logging ---------------------------------------------------------

test('the lane names its enabled sources at start and says starting, not started', () => {
  const { notes } = drivenLane({ enabled: true, sources: { git: { enabled: true }, terminal: { enabled: true } } });
  assert.ok(notes.some((line) => line === '[ingest] lane started: terminal, git'), `saw ${JSON.stringify(notes)}`);
  // start() is async, so a line claiming "started" would outrun any failure it could report.
  assert.ok(notes.some((line) => line === '[ingest] starting the git source'));
  assert.equal(notes.some((line) => line.includes('source started')), false);
});

// Counts and seqs, never an event summary: a summary is captured terminal output or command text.
test('the batch-flush line is debug-gated and carries counts rather than summaries', () => {
  const quiet = drivenLane({ enabled: true, sources: { git: { enabled: true } } });
  quiet.lane.publish(commit('a secret command nobody should read in a log'));
  quiet.timers.runIntervals();
  assert.equal(quiet.notes.some((line) => line.includes('batch flushed')), false);

  const loud = drivenLane({ enabled: true, sources: { git: { enabled: true } } }, { debug: () => true });
  loud.lane.publish(commit('a secret command nobody should read in a log'));
  loud.timers.runIntervals();
  const flushLine = loud.notes.find((line) => line.includes('batch flushed'));
  assert.match(String(flushLine), /1 events \(seq \d+-\d+\), 0 overflowed/);
  assert.equal(loud.notes.some((line) => line.includes('nobody should read')), false);
});

test('a debug getter that throws reads as debug off rather than failing the batch', () => {
  const { lane, timers, broadcasts, warnings } = drivenLane(
    { enabled: true, sources: { git: { enabled: true } } },
    { debug: () => { throw new Error('settings unavailable'); } },
  );
  lane.publish(commit('one'));
  timers.runIntervals();
  assert.equal(broadcasts.length, 1, 'the frame still went out');
  assert.deepEqual(warnings, []);
});

// --- Publish and batching -------------------------------------------------

test('publish stores the event and broadcasts nothing on its own', () => {
  const { lane, broadcasts } = drivenLane({ enabled: true, sources: { git: { enabled: true } } });
  for (let index = 0; index < 5; index += 1) lane.publish(commit(`commit ${index}`));
  assert.equal(broadcasts.length, 0, 'publish must never reach the wire directly');
  assert.equal(lane.recentEvents().length, 5);
  assert.equal(lane.pendingEventCount, 5);
});

test('the batch interval emits one frame carrying the events since the last one', () => {
  const { lane, timers, broadcasts } = drivenLane({ enabled: true, sources: { git: { enabled: true } } });
  lane.publish(commit('one'));
  lane.publish(commit('two'));
  timers.runIntervals();
  assert.equal(broadcasts.length, 1);
  const frame = frameOf(broadcasts[0]);
  assert.equal(frame.type, 'ingest-activity');
  assert.equal(frame.overflow, 0);
  assert.deepEqual(frame.events.map((event) => event.summary), ['two', 'one']);
  assert.equal(lane.pendingEventCount, 0);
});

test('an interval with nothing pending puts no frame on the wire at all', () => {
  const { timers, broadcasts } = drivenLane({ enabled: true, sources: { git: { enabled: true } } });
  timers.runIntervals();
  timers.runIntervals();
  assert.equal(broadcasts.length, 0);
});

test('a frame carries at most 50 events, newest first, and the rest collapse to a count', () => {
  const { lane, timers, broadcasts } = drivenLane({
    enabled: true, sources: { git: { enabled: true, maxEntries: 500 } },
  });
  for (let index = 0; index < 130; index += 1) lane.publish(commit(`commit ${index}`));
  timers.runIntervals();
  assert.equal(broadcasts.length, 1);
  const frame = frameOf(broadcasts[0]);
  assert.equal(frame.events.length, MAX_EVENTS_PER_FRAME);
  assert.equal(frame.overflow, 130 - MAX_EVENTS_PER_FRAME);
  assert.equal(frame.events[0].summary, 'commit 129');
  assert.equal(frame.events[MAX_EVENTS_PER_FRAME - 1].summary, `commit ${130 - MAX_EVENTS_PER_FRAME}`);
});

test('a broadcast that throws costs a warning, not the lane', () => {
  const { lane, timers, warnings } = drivenLane(
    { enabled: true, sources: { git: { enabled: true } } },
    { broadcast: () => { throw new Error('socket gone'); } },
  );
  lane.publish(commit('one'));
  timers.runIntervals();
  assert.ok(warnings.some((message) => message.includes('socket gone')));
  lane.publish(commit('two'));
  assert.equal(lane.recentEvents().length, 2);
});

// --- The activity poke (docs/plan-ingestion.md, M7.5) ---------------------

test('a batch that carried events tells the consumer once, and an empty interval tells it nothing', () => {
  const pokes: unknown[] = [];
  const { lane, timers } = drivenLane(
    { enabled: true, sources: { git: { enabled: true } } },
    { onActivity: () => pokes.push(1) },
  );

  timers.runIntervals();
  assert.equal(pokes.length, 0, 'no events, no poke');

  lane.publish(commit('one'));
  lane.publish(commit('two'));
  timers.runIntervals();
  assert.equal(pokes.length, 1, 'one poke for the batch, not one per event');

  timers.runIntervals();
  assert.equal(pokes.length, 1, 'the interval after it carried nothing');
});

test('a poke that throws costs a warning, not the batch loop or the frame it rode', () => {
  const { lane, timers, broadcasts, warnings } = drivenLane(
    { enabled: true, sources: { git: { enabled: true } } },
    { onActivity: () => { throw new Error('consumer fell over'); } },
  );

  lane.publish(commit('one'));
  timers.runIntervals();
  assert.equal(broadcasts.length, 1, 'the frame went out before the poke and is unaffected');
  assert.ok(warnings.some((message) => message.includes('consumer fell over')));

  lane.publish(commit('two'));
  timers.runIntervals();
  assert.equal(broadcasts.length, 2, 'the next interval batches exactly as before');
});

test('a push that never became an event pokes nobody and moves no seq', () => {
  const pokes: unknown[] = [];
  const { lane, timers, broadcasts } = drivenLane(
    { enabled: true, sources: { git: { enabled: true } } },
    { onActivity: () => pokes.push(1) },
  );

  lane.publish({ source: 'git', kind: 'commit', summary: '' });
  lane.publish({ source: 'nowhere', kind: 'commit', summary: 'wrong source' });
  timers.runIntervals();
  assert.equal(lane.latestSeq(), 0, 'nothing was stored, so nothing moved');
  assert.equal(pokes.length, 0);
  assert.equal(broadcasts.length, 0);
});

test('a lane with no consumer wired pokes nothing and still batches', () => {
  const { lane, timers, broadcasts } = drivenLane({ enabled: true, sources: { git: { enabled: true } } });
  lane.publish(commit('one'));
  timers.runIntervals();
  assert.equal(broadcasts.length, 1);
});

test('latestSeq advances only on a stored event, which is what movement means', () => {
  const { lane } = drivenLane({ enabled: true, sources: { git: { enabled: true } } });
  assert.equal(lane.latestSeq(), 0, 'nothing has happened yet');

  lane.publish(commit('one'));
  const afterFirst = lane.latestSeq();
  assert.ok(afterFirst > 0);

  lane.publish({ source: 'nowhere', kind: 'commit', summary: 'dropped' });
  assert.equal(lane.latestSeq(), afterFirst, 'an unknown source is not an event');

  // Rejected AFTER the source check, inside normalization: an undeclared kind, and an empty summary.
  lane.publish({ source: 'git', kind: 'not-a-kind', summary: 'dropped' });
  lane.publish({ source: 'git', kind: 'commit', summary: '   ' });
  assert.equal(lane.latestSeq(), afterFirst, 'a seq burnt on a rejected push would read as movement');
  assert.equal(lane.recentEvents().length, 1);

  lane.publish(commit('two'));
  assert.ok(lane.latestSeq() > afterFirst);

  // Reading the digest ages its relative times; the movement signal must not move with them.
  const readAgain = lane.latestSeq();
  lane.buildDigest({ now: NOW + 600000 });
  assert.equal(lane.latestSeq(), readAgain);
});

test('a full ring keeps its seq, so eviction is not mistaken for the machine going quiet', () => {
  const { lane } = drivenLane({ enabled: true, sources: { git: { enabled: true, maxEntries: 3 } } });
  for (let index = 0; index < 20; index += 1) lane.publish(commit(`commit ${index}`));
  assert.equal(lane.recentEvents().length, 3);
  assert.equal(lane.latestSeq(), 20);
});

// --- Snapshot -------------------------------------------------------------

test('the snapshot is the current rings, newest first, and names the enabled sources', () => {
  const { lane, clock } = drivenLane({
    enabled: true, sources: { git: { enabled: true }, terminal: { enabled: true } },
  });
  lane.publish(commit('older'));
  lane.publish(commit('newer'));
  clock.now = NOW + 1000;
  const snapshot = frameOf(lane.snapshotMessage());
  assert.equal(snapshot.type, 'ingest-snapshot');
  assert.equal(snapshot.ts, NOW + 1000);
  assert.deepEqual(snapshot.sources, ['terminal', 'git']);
  assert.deepEqual(snapshot.events.map((event) => event.summary), ['newer', 'older']);
});

test('the snapshot is bounded, so a full ring cannot become one enormous connect frame', () => {
  const { lane } = drivenLane(
    { enabled: true, sources: { git: { enabled: true, maxEntries: 100 } } },
    { snapshotEventLimit: 10 },
  );
  for (let index = 0; index < 60; index += 1) lane.publish(commit(`commit ${index}`));
  assert.equal(frameOf(lane.snapshotMessage()).events.length, 10);
});

// --- Digest ---------------------------------------------------------------

test('buildDigest reads the rings synchronously and reports nothing when they are empty', () => {
  const { lane } = drivenLane({ enabled: true, sources: { git: { enabled: true } } });
  assert.equal(lane.buildDigest({ now: NOW }), '');
  lane.publish(commit('fix the gate'));
  const digest = lane.buildDigest({ now: NOW });
  assert.ok(digest.includes('- git 0s ago: fix the gate'));
});

// --- Session tap ----------------------------------------------------------

test('a tapped session flushes its coalesced output into the rings on the flush timer', () => {
  const { lane, timers } = drivenLane();
  const sess = new FakeSession();
  lane.attachSessionTap(sess);
  assert.equal(sess.listenerCount('data'), 1);
  sess.emit('data', 'npm test\n');
  sess.emit('data', '42 passing\n');
  assert.equal(lane.recentEvents().length, 0, 'nothing publishes before the flush window elapses');
  timers.runTimeouts();
  const [event] = lane.recentEvents();
  assert.equal(event.source, 'terminal');
  assert.equal(event.summary, 'npm test 42 passing');
  assert.deepEqual(event.scope, { root: '/repo', sessionId: 'session-1' });
});

test('a secret in tapped terminal output reaches neither the summary nor the detail of a ring entry', () => {
  const { lane, timers } = drivenLane();
  const sess = new FakeSession();
  lane.attachSessionTap(sess);
  sess.emit('data', 'deploy --token ghp_aaaabbbbccccdddd\n');
  timers.runTimeouts();
  const [event] = lane.recentEvents();
  assert.ok(!event.summary.includes('ghp_aaaabbbbccccdddd'));
  assert.ok(!String(event.detail?.text).includes('ghp_aaaabbbbccccdddd'));
  assert.ok(event.summary.includes('[scrubbed]'));
});

test('a secret straddling the summary cut is scrubbed end to end, through the tap and into the digest', () => {
  const { lane, timers } = drivenLane();
  const sess = new FakeSession();
  lane.attachSessionTap(sess);
  // The offset that put the 400-char summary tail INSIDE the assignment, past the name the scrub needs.
  sess.emit('data', `${'x'.repeat(200)} api_key=sk-live-DEADBEEFCAFEBABE${'z'.repeat(376)}\n`);
  timers.runTimeouts();
  const [event] = lane.recentEvents();
  assert.ok(!event.summary.includes('sk-live-DEADBEEFCAFEBABE'), `leaked: ${event.summary.slice(0, 60)}`);
  assert.ok(!String(event.detail?.text).includes('sk-live-DEADBEEFCAFEBABE'));
  assert.ok(!lane.buildDigest({ now: NOW }).includes('sk-live-DEADBEEFCAFEBABE'));
  assert.ok(!JSON.stringify(lane.snapshotMessage()).includes('sk-live-DEADBEEFCAFEBABE'));
});

test('a rebaseline drops the pending bytes rather than publishing a redrawn screen', () => {
  const { lane, timers } = drivenLane();
  const sess = new FakeSession();
  lane.attachSessionTap(sess);
  sess.emit('data', 'about to be redrawn away');
  sess.emit('rebaseline');
  timers.runTimeouts();
  assert.equal(lane.recentEvents().length, 0);
  sess.emit('data', 'after the redraw\n');
  timers.runTimeouts();
  assert.equal(lane.recentEvents()[0].summary, 'after the redraw');
});

test('a burst past the window budget publishes one truncated event, not a queue of them', () => {
  const { lane, timers } = drivenLane();
  const sess = new FakeSession();
  lane.attachSessionTap(sess);
  for (let index = 0; index < 200; index += 1) sess.emit('data', `${'q'.repeat(4000)}\n`);
  timers.runTimeouts();
  const events = lane.recentEvents();
  assert.equal(events.length, 1);
  assert.ok(events[0].summary.endsWith(`[${TRUNCATION_NOTE}]`));
});

test('attaching twice returns the one tap, so a re-wire cannot double-count a session', () => {
  const { lane } = drivenLane();
  const sess = new FakeSession();
  const first = lane.attachSessionTap(sess);
  const second = lane.attachSessionTap(sess);
  assert.equal(first, second);
  assert.equal(lane.tapCount, 1);
  assert.equal(sess.listenerCount('data'), 1);
});

test('a PTY exit flushes what the dead process left but KEEPS the tap, because the Session is reused', () => {
  const { lane, timers } = drivenLane();
  const sess = new FakeSession();
  lane.attachSessionTap(sess);
  sess.emit('data', 'output before the exit\n');
  sess.emit('exit', { exitCode: 0 });

  // The exit IS the flush boundary: the dead PTY's last bytes go out without waiting the window.
  assert.deepEqual(lane.recentEvents().map((event) => event.summary), ['output before the exit']);
  assert.equal(lane.tapCount, 1, 'restart, force-restart and start-on-dormant all reuse this object');
  assert.equal(sess.listenerCount('data'), 1);

  // A restart on the same object: wireSessionEvents does NOT run again, so this is the only tap it gets.
  sess.emit('data', 'output after the restart\n');
  timers.runTimeouts();
  assert.deepEqual(
    lane.recentEvents().map((event) => event.summary),
    ['output after the restart', 'output before the exit'],
  );
});

test('the accumulator does not carry bytes across a PTY exit into the restarted process output', () => {
  const { lane, timers } = drivenLane();
  const sess = new FakeSession();
  lane.attachSessionTap(sess);
  sess.emit('data', 'half a line with no newline');
  sess.emit('exit', { exitCode: 0 });
  sess.emit('data', 'fresh output\n');
  timers.runTimeouts();
  assert.equal(lane.recentEvents()[0].summary, 'fresh output', 'no pre-exit remnant rides the next flush');
});

test('a recreated session under the same project id gets a fresh tap, and the stale one goes', () => {
  const { lane, timers } = drivenLane();
  const oldSess = new FakeSession('p1');
  lane.attachSessionTap(oldSess);

  // Exactly backend.js _modifyChangedSessions: destroy() removes every listener synchronously and emits
  // no 'exit', then a NEW Session is built under the same stable project id and wired.
  oldSess.removeAllListeners();
  const newSess = new FakeSession('p1');
  const tap = tapOf(lane.attachSessionTap(newSess));

  assert.notEqual(tap.session, oldSess, 'the stale tap must not be handed back');
  assert.equal(newSess.listenerCount('data'), 1, 'the recreated session must actually be tapped');
  assert.equal(lane.tapCount, 1, 'and the stale entry must not leak beside it');

  newSess.emit('data', 'from the recreated session\n');
  timers.runTimeouts();
  assert.deepEqual(lane.recentEvents().map((event) => event.summary), ['from the recreated session']);
});

test('detachSessionTap unwires a session leaving for good, and ignores one already replaced', () => {
  const { lane } = drivenLane();
  const sess = new FakeSession('p1');
  lane.attachSessionTap(sess);
  assert.equal(lane.detachSessionTap(sess), true);
  assert.equal(lane.tapCount, 0);
  assert.equal(sess.listenerCount('data'), 0);
  assert.equal(lane.detachSessionTap(sess), false, 'detaching twice is a no-op');

  const replaced = new FakeSession('p1');
  lane.attachSessionTap(replaced);
  assert.equal(lane.detachSessionTap(sess), false, 'a stale handle must not unwire the live session');
  assert.equal(replaced.listenerCount('data'), 1);
});

test('detach tolerates the listeners already being gone, because destroy() removes them all', () => {
  const { lane } = drivenLane();
  const sess = new FakeSession();
  const tap = tapOf(lane.attachSessionTap(sess));
  // What Session.destroy() does before anything gets a chance to detach politely.
  sess.removeAllListeners();
  tap.detach();
  tap.detach();
  assert.equal(tap.isDetached, true);
  assert.equal(lane.tapCount, 0);
});

test('the terminal source off means no tap is ever attached and no data listener is added', () => {
  const { lane } = drivenLane({ enabled: true, sources: { git: { enabled: true } } });
  const sess = new FakeSession();
  assert.equal(lane.terminalEnabled, false);
  assert.equal(lane.attachSessionTap(sess), null);
  assert.equal(sess.listenerCount('data'), 0);
  assert.equal(lane.tapCount, 0);
});

// --- Stop -----------------------------------------------------------------

test('stop cancels the batch timer, detaches every tap, and refuses later publishes', () => {
  const { lane, timers, broadcasts } = drivenLane();
  const first = new FakeSession('a');
  const second = new FakeSession('b');
  lane.attachSessionTap(first);
  lane.attachSessionTap(second);
  first.emit('data', 'pending output\n');
  assert.ok(timers.timeoutCount > 0);
  assert.equal(timers.intervalCount, 1);

  lane.stop();

  assert.equal(timers.intervalCount, 0, 'the batch interval must be cancelled');
  assert.equal(timers.timeoutCount, 0, 'a pending flush timer must be cancelled');
  assert.equal(lane.tapCount, 0);
  assert.equal(first.listenerCount('data'), 0);
  assert.equal(second.listenerCount('data'), 0);
  assert.equal(lane.publish(commit('after stop')), null);
  assert.equal(broadcasts.length, 0);
});

test('stop is idempotent', () => {
  const { lane } = drivenLane();
  lane.stop();
  lane.stop();
  assert.equal(lane.isStopped, true);
});

test('a stopped lane attaches no new tap', () => {
  const { lane } = drivenLane();
  lane.stop();
  const sess = new FakeSession();
  assert.equal(lane.attachSessionTap(sess), null);
  assert.equal(sess.listenerCount('data'), 0);
});

test('the wire bounds are the plan values, and a caller can read them rather than guess', () => {
  assert.equal(BATCH_INTERVAL_MS, 1000, 'one activity frame per second at most');
  assert.equal(MAX_EVENTS_PER_FRAME, 50);
  assert.equal(SNAPSHOT_EVENT_LIMIT, 100);
  // The defaults are what a lane built with no timer overrides actually uses.
  const { lane, timers, broadcasts } = drivenLane(
    { enabled: true, sources: { git: { enabled: true, maxEntries: 500 } } },
    { batchIntervalMs: BATCH_INTERVAL_MS, maxEventsPerFrame: MAX_EVENTS_PER_FRAME },
  );
  for (let index = 0; index < SNAPSHOT_EVENT_LIMIT + 40; index += 1) lane.publish(commit(`commit ${index}`));
  timers.runIntervals();
  assert.equal(frameOf(broadcasts[0]).events.length, MAX_EVENTS_PER_FRAME);
  assert.equal(frameOf(lane.snapshotMessage()).events.length, SNAPSHOT_EVENT_LIMIT);
  lane.stop();
});
