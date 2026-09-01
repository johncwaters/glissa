import test from 'node:test';
import assert from 'node:assert/strict';

import type { UiActionName, UiState, UiStateSubscriber } from '../public/ui-state-core.ts';

const importCore = () => import('../public/ui-state-core.ts');

test('a fresh store starts on the declared initial state', async () => {
  const { createUiStateStore, INITIAL_UI_STATE } = await importCore();
  const store = createUiStateStore();
  assert.deepEqual(store.snapshot(), INITIAL_UI_STATE);
  assert.equal(store.snapshot().layout, 'desktop');
  assert.equal(store.snapshot().activeView, 'focus');
  assert.equal(store.snapshot().focusedSessionId, null);
});

test('an initial-state override seeds only the keys it names', async () => {
  const { createUiStateStore } = await importCore();
  const store = createUiStateStore({ layout: 'phone' });
  assert.equal(store.snapshot().layout, 'phone');
  assert.equal(store.snapshot().activeView, 'focus');
});

test('two stores from the factory share no state', async () => {
  const { createUiStateStore } = await importCore();
  const first = createUiStateStore();
  const second = createUiStateStore();
  first.dispatch('setLayout', 'phone');
  assert.equal(first.snapshot().layout, 'phone');
  assert.equal(second.snapshot().layout, 'desktop');
});

test('dispatch moves the value and hands subscribers the new state, the changed keys and the old state', async () => {
  const { createUiStateStore } = await importCore();
  const store = createUiStateStore();
  const calls: { state: Readonly<UiState>; changedKeys: (keyof UiState)[]; previousState: Readonly<UiState> }[] = [];
  const record: UiStateSubscriber = (state, changedKeys, previousState) => { calls.push({ state, changedKeys, previousState }); };
  store.subscribe(record);

  store.dispatch('focusSession', 'session-a');

  assert.equal(store.snapshot().focusedSessionId, 'session-a');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].state.focusedSessionId, 'session-a');
  assert.deepEqual(calls[0].changedKeys, ['focusedSessionId']);
  assert.equal(calls[0].previousState.focusedSessionId, null);
});

test('the state is committed before subscribers run, so a subscriber reads the new snapshot', async () => {
  const { createUiStateStore } = await importCore();
  const store = createUiStateStore();
  let seenDuringNotify = 'unset';
  store.subscribe(() => { seenDuringNotify = store.snapshot().activeView; });

  store.dispatch('setActiveView', 'usage');

  assert.equal(seenDuringNotify, 'usage');
});

test('a no-op update notifies nobody and keeps the same snapshot reference', async () => {
  const { createUiStateStore } = await importCore();
  const store = createUiStateStore();
  let notifyCount = 0;
  store.subscribe(() => { notifyCount += 1; });

  const before = store.snapshot();
  store.dispatch('setLayout', 'desktop');
  assert.equal(notifyCount, 0);
  assert.equal(store.snapshot(), before);

  store.dispatch('setLayout', 'phone');
  assert.equal(notifyCount, 1);
  const afterRealChange = store.snapshot();

  store.dispatch('setLayout', 'phone');
  assert.equal(notifyCount, 1);
  assert.equal(store.snapshot(), afterRealChange);
});

test('a falsy id normalizes to null, so clearing twice is a no-op rather than a second notification', async () => {
  const { createUiStateStore } = await importCore();
  const store = createUiStateStore();
  let notifyCount = 0;
  store.subscribe(() => { notifyCount += 1; });

  store.dispatch('selectSession', undefined);
  assert.equal(store.snapshot().selectedSessionId, null);
  assert.equal(notifyCount, 0);

  store.dispatch('selectSession', 'session-a');
  store.dispatch('selectSession', '');
  assert.equal(store.snapshot().selectedSessionId, null);
  assert.equal(notifyCount, 2);
});

test('subscribers are notified in subscription order', async () => {
  const { createUiStateStore } = await importCore();
  const store = createUiStateStore();
  const order: string[] = [];
  store.subscribe(() => { order.push('first'); });
  store.subscribe(() => { order.push('second'); });
  store.subscribe(() => { order.push('third'); });

  store.dispatch('borrowCard', 'session-a');

  assert.deepEqual(order, ['first', 'second', 'third']);
});

test('unsubscribe stops that subscriber and leaves the others running', async () => {
  const { createUiStateStore } = await importCore();
  const store = createUiStateStore();
  const seen: string[] = [];
  const unsubscribe = store.subscribe(() => { seen.push('leaving'); });
  store.subscribe(() => { seen.push('staying'); });

  store.dispatch('setActiveView', 'radar');
  assert.deepEqual(seen, ['leaving', 'staying']);

  unsubscribe();
  store.dispatch('setActiveView', 'prs');
  assert.deepEqual(seen, ['leaving', 'staying', 'staying']);
});

test('unsubscribing twice is harmless and never drops a different subscriber', async () => {
  const { createUiStateStore } = await importCore();
  const store = createUiStateStore();
  let notifyCount = 0;
  const unsubscribe = store.subscribe(() => { notifyCount += 1; });
  unsubscribe();
  unsubscribe();
  store.subscribe(() => { notifyCount += 1; });

  store.dispatch('setActiveView', 'mill');
  assert.equal(notifyCount, 1);
});

test('a throwing subscriber never strands the ones queued behind it', async () => {
  const { createUiStateStore } = await importCore();
  const store = createUiStateStore();
  const seen: string[] = [];
  store.subscribe(() => { throw new Error('subscriber blew up'); });
  store.subscribe(() => { seen.push('still ran'); });

  store.dispatch('setLayout', 'phone');

  assert.deepEqual(seen, ['still ran']);
  assert.equal(store.snapshot().layout, 'phone');
});

test('every declared action writes only keys the initial state declares', async () => {
  const { createUiStateStore, INITIAL_UI_STATE, UI_ACTIONS } = await importCore();
  const store = createUiStateStore();
  const probes: [UiActionName, string][] = [
    ['setLayout', 'phone'], ['setActiveView', 'radar'], ['setPhoneScreen', 'board'],
    ['focusSession', 'probe'], ['selectSession', 'probe'], ['borrowCard', 'probe'],
  ];
  assert.equal(probes.length, Object.keys(UI_ACTIONS).length, 'a new action needs a probe here');
  for (const [action, value] of probes) {
    for (const key of Object.keys(UI_ACTIONS[action](value))) {
      assert.ok(key in INITIAL_UI_STATE, `action ${action} writes undeclared key ${key}`);
    }
    assert.doesNotThrow(() => store.dispatch(action, value));
  }
});

test('the snapshot is frozen, so a consumer cannot write around the actions', async () => {
  const { createUiStateStore } = await importCore();
  const store = createUiStateStore();
  assert.ok(Object.isFrozen(store.snapshot()));
  assert.throws(() => { const mutable: UiState = store.snapshot(); mutable.layout = 'phone'; }, TypeError);
});

test('an unrelated field moving leaves the others untouched and out of changedKeys', async () => {
  const { createUiStateStore } = await importCore();
  const store = createUiStateStore();
  store.dispatch('focusSession', 'session-a');
  store.dispatch('selectSession', 'session-a');

  const changes: (keyof UiState)[][] = [];
  store.subscribe((_state, changedKeys) => { changes.push(changedKeys); });
  store.dispatch('setActiveView', 'settings');

  assert.deepEqual(changes, [['activeView']]);
  assert.equal(store.snapshot().focusedSessionId, 'session-a');
  assert.equal(store.snapshot().selectedSessionId, 'session-a');
});
