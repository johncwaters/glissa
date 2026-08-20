'use strict';

// Tests for the pure upgrade-target classifier (server/core/upgrade-route.js). The bug it exists to
// prevent: '/control?since=<seq>' (what the dashboard sends on EVERY in-page reconnect) classified as
// an unknown path, so only a full page reload could reconnect.

const test = require('node:test');
const assert = require('node:assert/strict');

const { upgradePathname, classifyUpgradePath, dataSessionIdFromUrl } = require('../server/core/upgrade-route');

test('upgradePathname strips a query string and a fragment', () => {
  assert.equal(upgradePathname('/control'), '/control');
  assert.equal(upgradePathname('/control?since=7'), '/control');
  assert.equal(upgradePathname('/control?since=7&x=1'), '/control');
  assert.equal(upgradePathname('/control#frag'), '/control');
  assert.equal(upgradePathname('/control?'), '/control');
});

test('upgradePathname answers for input that is not a usable request target', () => {
  assert.equal(upgradePathname(undefined), '');
  assert.equal(upgradePathname(null), '');
  assert.equal(upgradePathname(42), '');
  assert.equal(upgradePathname('%%%not-a-url'), '%%%not-a-url', 'no parsing, so nothing to throw on');
});

test('a control upgrade routes with or without a replay cursor', () => {
  assert.equal(classifyUpgradePath('/control'), 'control');
  assert.equal(classifyUpgradePath('/control?since=7'), 'control');
  assert.equal(classifyUpgradePath('/control?since=0'), 'control');
});

test('a path that merely starts with /control is not the control route', () => {
  assert.equal(classifyUpgradePath('/controls'), 'unknown');
  assert.equal(classifyUpgradePath('/control/extra'), 'unknown');
  assert.equal(classifyUpgradePath('//host/control'), 'unknown', 'an authority is not reinterpreted');
  assert.equal(classifyUpgradePath('/other/../control'), 'unknown', 'dot segments are not collapsed');
});

test('a navigator upgrade routes on its exact pathname only', () => {
  assert.equal(classifyUpgradePath('/navigator'), 'navigator');
  assert.equal(classifyUpgradePath('/navigator?v=1'), 'navigator', 'a query string is not part of the path');
  assert.equal(classifyUpgradePath('/navigator#frag'), 'navigator');
  assert.equal(classifyUpgradePath('/navigators'), 'unknown');
  assert.equal(classifyUpgradePath('/navigator/extra'), 'unknown');
  assert.equal(classifyUpgradePath('//host/navigator'), 'unknown', 'an authority is not reinterpreted');
  assert.equal(classifyUpgradePath('/other/../navigator'), 'unknown', 'dot segments are not collapsed');
});

test('the navigator route never reads as a session id', () => {
  assert.equal(dataSessionIdFromUrl('/navigator'), null);
});

test('a data upgrade routes with or without a query string', () => {
  assert.equal(classifyUpgradePath('/terminals/abc'), 'data');
  assert.equal(classifyUpgradePath('/terminals/abc?anything=1'), 'data');
});

test('an unowned path stays unknown so another upgrade listener (Vite HMR) can claim it', () => {
  assert.equal(classifyUpgradePath('/some-other-app'), 'unknown');
  assert.equal(classifyUpgradePath('/'), 'unknown');
  assert.equal(classifyUpgradePath(undefined), 'unknown');
});

test('the data session id ignores the query string and decodes the segment', () => {
  assert.equal(dataSessionIdFromUrl('/terminals/abc'), 'abc');
  assert.equal(dataSessionIdFromUrl('/terminals/abc?since=7'), 'abc', 'a cursor never leaks into the id');
  assert.equal(dataSessionIdFromUrl('/terminals/a%20b'), 'a b');
});

test('the data session id is null when there is none to read', () => {
  assert.equal(dataSessionIdFromUrl('/terminals/'), null);
  assert.equal(dataSessionIdFromUrl('/terminals/?since=7'), null);
  assert.equal(dataSessionIdFromUrl('/control'), null);
  assert.equal(dataSessionIdFromUrl('/terminals/%'), null, 'an undecodable id is refused, never thrown');
});
