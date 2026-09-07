import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlanHash, resolvePlanTarget } from '../public/plan/plan-link.ts';

test('plan deep links compose and resolve a session id', () => {
  const hash = createPlanHash('session/id with spaces');
  assert.equal(hash, '#plan/session%2Fid%20with%20spaces');
  assert.equal(resolvePlanTarget(hash), 'session/id with spaces');
  assert.equal(resolvePlanTarget('#plan/'), null);
  assert.equal(resolvePlanTarget('#settings/general'), null);
});
