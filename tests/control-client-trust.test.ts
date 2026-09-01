import test from 'node:test';
import assert from 'node:assert/strict';

import type { RequestTrust } from '../server/core/request-trust.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';

interface TrustFrame {
  type: string;
  trust?: string;
}

function connectWith(trust: RequestTrust | undefined): TrustFrame[] {
  const server = createControlServer(controlDeps({ projects: [] }));
  return connectControl<TrustFrame>(server, { trust }).sent;
}

test('a remote-stamped connection is told it is remote', () => {
  const sent = connectWith('remote');
  assert.deepEqual(sent.find((m) => m.type === 'client-trust'), { type: 'client-trust', trust: 'remote' });
});

test('an unstamped connection (remote mode off) is told it is local', () => {
  const sent = connectWith(undefined);
  assert.deepEqual(sent.find((m) => m.type === 'client-trust'), { type: 'client-trust', trust: 'local' });
});

test('the snapshot stays the first frame of a connection', () => {
  const sent = connectWith('local');
  assert.equal(sent[0].type, 'snapshot', 'control-ws.ts resets its replay cursor on the first seq-less snapshot');
  assert.equal(sent[1].type, 'client-trust');
});
