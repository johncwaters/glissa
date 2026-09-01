import test from 'node:test';
import assert from 'node:assert/strict';

import { createToastChannel } from '../notifications/channels/toast.ts';

function withCapturedWarnings(fn: (warnings: string[]) => void): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    fn(warnings);
  } finally {
    console.warn = original;
  }
  return warnings;
}

test('on a non-Windows platform the channel is a no-op that warns exactly once', () => {
  const warnings = withCapturedWarnings(() => {
    const toast = createToastChannel({ platform: 'linux' });
    toast('sess', 'complete', 'finished working', {});
    toast('sess', 'waiting', 'needs input', {});
    toast('other', 'failed', 'died', {});
  });

  assert.equal(warnings.length, 1, 'one warning for the whole process, not one per notification');
  assert.match(warnings[0], /Windows-only/);
  assert.match(warnings[0], /linux/, 'the warning names the platform it is skipping on');
});

test('each channel instance warns on its own (a restart re-arms the notice)', () => {
  const warnings = withCapturedWarnings(() => {
    createToastChannel({ platform: 'darwin' })('a', 'complete', 'one', {});
    createToastChannel({ platform: 'darwin' })('b', 'complete', 'two', {});
  });

  assert.equal(warnings.length, 2);
});

test('the platform defaults to the host, so backend.js keeps calling it with no arguments', () => {
  const toast = createToastChannel();
  assert.equal(typeof toast, 'function');
  assert.equal(toast.length, 4, 'the NotificationManager channel signature is unchanged');
});
