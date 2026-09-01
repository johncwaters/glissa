import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyChecks, normalizePr } from '../server/pr-gh.ts';

test('classifyChecks: empty rollup is none (never green)', () => {
  assert.equal(classifyChecks([]), 'none');
  assert.equal(classifyChecks(null), 'none');
  assert.equal(classifyChecks(undefined), 'none');
});

test('classifyChecks: CheckRuns all completed+success -> green', () => {
  assert.equal(classifyChecks([
    { status: 'COMPLETED', conclusion: 'SUCCESS' },
    { status: 'COMPLETED', conclusion: 'SKIPPED' },
  ]), 'green');
});

test('classifyChecks: a not-yet-completed CheckRun -> pending', () => {
  assert.equal(classifyChecks([
    { status: 'COMPLETED', conclusion: 'SUCCESS' },
    { status: 'IN_PROGRESS', conclusion: '' },
  ]), 'pending');
});

test('classifyChecks: a completed failure -> failing', () => {
  assert.equal(classifyChecks([
    { status: 'COMPLETED', conclusion: 'SUCCESS' },
    { status: 'COMPLETED', conclusion: 'FAILURE' },
  ]), 'failing');
});

test('classifyChecks: StatusContext all SUCCESS -> green', () => {
  assert.equal(classifyChecks([
    { __typename: 'StatusContext', state: 'SUCCESS' },
    { __typename: 'StatusContext', state: 'SUCCESS' },
  ]), 'green');
});

test('classifyChecks: StatusContext PENDING -> pending', () => {
  assert.equal(classifyChecks([
    { __typename: 'StatusContext', state: 'SUCCESS' },
    { __typename: 'StatusContext', state: 'PENDING' },
  ]), 'pending');
});

test('classifyChecks: StatusContext FAILURE/ERROR -> failing', () => {
  assert.equal(classifyChecks([{ __typename: 'StatusContext', state: 'FAILURE' }]), 'failing');
  assert.equal(classifyChecks([{ __typename: 'StatusContext', state: 'ERROR' }]), 'failing');
});

test('classifyChecks: mixed CheckRun + StatusContext, all good -> green', () => {
  assert.equal(classifyChecks([
    { status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'StatusContext', state: 'SUCCESS' },
  ]), 'green');
});

test('normalizePr maps gh fields and coerces bot/fork flags', () => {
  const pr = normalizePr({
    number: 3,
    headRefOid: 'abc',
    headRefName: 'feat',
    baseRefName: 'main',
    mergeable: 'MERGEABLE',
    isDraft: false,
    isCrossRepository: false,
    headRepositoryOwner: { login: 'me' },
    author: { login: 'dependabot[bot]', is_bot: true },
    title: 'x',
  });
  assert.equal(pr.headOwner, 'me');
  assert.equal(pr.author.isBot, true);
  assert.equal(pr.author.login, 'dependabot[bot]');
  assert.equal(pr.mergeable, 'MERGEABLE');
});
