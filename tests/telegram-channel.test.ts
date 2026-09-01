// The opt-in off-dashboard notification channel (notifications/channels/telegram.ts): its gating
// rule, its message shape, and the fire-and-forget discipline it inherits from the shared transport.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTelegramChannel, decideTelegramNotification, formatTelegramText,
} from '../notifications/channels/telegram.ts';
import { createTelegramCompletionDefer } from '../notifications/telegram-completion-defer.ts';
import { sendTelegramMessage } from '../server/telegram-transport.js';
import { sendPrPing } from '../server/pr-telegram.js';
import type { TelegramChannelDeps } from '../notifications/channels/telegram.ts';

const CONFIGURED = { enabled: true, botToken: 'TOK', chatId: '123', connectionCount: 0 };

test('the gate is closed unless the operator opted in', () => {
  assert.equal(decideTelegramNotification({ ...CONFIGURED, enabled: false }).send, false);
  assert.equal(decideTelegramNotification({ ...CONFIGURED, enabled: undefined }).send, false);
  assert.equal(decideTelegramNotification({ ...CONFIGURED, enabled: 'yes' }).send, false, 'strictly true only');
  assert.equal(decideTelegramNotification({ ...CONFIGURED, enabled: false }).reason, 'disabled');
});

test('the gate is closed without both credentials', () => {
  assert.equal(decideTelegramNotification({ ...CONFIGURED, botToken: '' }).send, false);
  assert.equal(decideTelegramNotification({ ...CONFIGURED, chatId: '' }).send, false);
  assert.equal(decideTelegramNotification({ ...CONFIGURED, botToken: undefined }).reason, 'not-configured');
});

test('the gate is closed while any dashboard connection is open', () => {
  assert.equal(decideTelegramNotification({ ...CONFIGURED, connectionCount: 1 }).send, false);
  assert.equal(decideTelegramNotification({ ...CONFIGURED, connectionCount: 3 }).reason, 'dashboard-open');
});

test('opted in, configured, and nobody connected is the one sending case', () => {
  const decision = decideTelegramNotification(CONFIGURED);
  assert.equal(decision.send, true);
  assert.equal(decision.reason, 'no-dashboard-audience');
});

test('a complete decision defers while the session still reports active agents', () => {
  assert.deepEqual(
    decideTelegramNotification({ ...CONFIGURED, category: 'complete', activeAgents: 1 }),
    { send: false, reason: 'active-agents' },
  );
  assert.equal(
    decideTelegramNotification({ ...CONFIGURED, category: 'waiting', activeAgents: 1 }).send,
    true,
    'the belt and braces gate is Telegram complete only',
  );
});

test('the text mirrors the web notification: category plus the manager message', () => {
  assert.equal(formatTelegramText('id-1', 'complete', 'api finished working'), 'complete: api finished working');
  assert.equal(formatTelegramText('id-1', 'waiting', 'api needs your input'), 'waiting: api needs your input');
  assert.equal(formatTelegramText('id-1', null, 'something'), 'something');
  assert.equal(formatTelegramText('id-1', 'complete', ''), 'complete: id-1 needs attention');
});

function makeChannel(config: ReturnType<TelegramChannelDeps['getConfig']>, connectionCount: number) {
  const sent: { botToken: string; chatId: string; text: string; tag?: string }[] = [];
  const channel = createTelegramChannel({
    getConfig: () => config,
    getConnectionCount: () => connectionCount,
    send: (payload) => { sent.push(payload); },
  });
  return { channel, sent };
}

test('the channel sends with the shared credentials when the gate opens', () => {
  const config = { telegramNotifications: true, telegram: { botToken: 'TOK', chatId: '123' } };
  const { channel, sent } = makeChannel(config, 0);
  channel('sess-id', 'complete', 'api finished working', { escalationCount: 0 });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    botToken: 'TOK',
    chatId: '123',
    text: 'complete: api finished working',
    tag: 'channel:telegram',
  });
});

test('the channel is silent with a dashboard open, and speaks again once it closes', () => {
  const config = { telegramNotifications: true, telegram: { botToken: 'TOK', chatId: '123' } };
  let connections = 1;
  const sent: { botToken: string; chatId: string; text: string; tag?: string }[] = [];
  const channel = createTelegramChannel({
    getConfig: () => config,
    getConnectionCount: () => connections,
    send: (payload) => { sent.push(payload); },
  });
  channel('sess-id', 'complete', 'api finished working', {});
  assert.equal(sent.length, 0);
  connections = 0;
  channel('sess-id', 'complete', 'api finished working', {});
  assert.equal(sent.length, 1);
});

test('an unconfigured install never sends, which is the absent-key default', () => {
  const { channel, sent } = makeChannel({}, 0);
  channel('sess-id', 'complete', 'api finished working', {});
  assert.equal(sent.length, 0);
});

test('config is read per delivery, so the toggle needs no re-registration', () => {
  const config = { telegramNotifications: false, telegram: { botToken: 'TOK', chatId: '123' } };
  const { channel, sent } = makeChannel(config, 0);
  channel('sess-id', 'complete', 'first', {});
  assert.equal(sent.length, 0);
  config.telegramNotifications = true;
  channel('sess-id', 'complete', 'second', {});
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'complete: second');
});

test('a deferred complete rechecks the live agent count before sending', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const config = { telegramNotifications: true, telegram: { botToken: 'TOK', chatId: '123' } };
  let activeAgents = 1;
  const sent: { botToken: string; chatId: string; text: string; tag?: string }[] = [];
  const sendTelegramNotification = createTelegramChannel({
    getConfig: () => config,
    getConnectionCount: () => 0,
    getActiveAgentCount: () => activeAgents,
    send: (payload) => { sent.push(payload); },
  });
  const channel = createTelegramCompletionDefer({ deliver: sendTelegramNotification, recheckMs: 25 });
  channel('sess-id', 'complete', 'api finished working', {});
  assert.equal(sent.length, 0);
  t.mock.timers.tick(25);
  assert.equal(sent.length, 0, 'the timer keeps deferring against the current count');
  activeAgents = 0;
  channel.recheck('sess-id');
  assert.equal(sent.length, 1, 'an agent-count change can release without waiting for another timer');
  channel.destroy();
});

test('a later session state change cancels a deferred complete', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const config = { telegramNotifications: true, telegram: { botToken: 'TOK', chatId: '123' } };
  let activeAgents = 1;
  const sent: { botToken: string; chatId: string; text: string; tag?: string }[] = [];
  const sendTelegramNotification = createTelegramChannel({
    getConfig: () => config,
    getConnectionCount: () => 0,
    getActiveAgentCount: () => activeAgents,
    send: (payload) => { sent.push(payload); },
  });
  const channel = createTelegramCompletionDefer({ deliver: sendTelegramNotification, recheckMs: 25 });
  channel('sess-id', 'complete', 'api finished working', {});
  channel.noteStateChange('sess-id');
  activeAgents = 0;
  t.mock.timers.tick(30);
  assert.equal(sent.length, 0);
  channel.destroy();
});

test('a missing config object does not throw the delivery loop', () => {
  const channel = createTelegramChannel({ getConfig: () => null, getConnectionCount: () => 0 });
  assert.doesNotThrow(() => channel('sess-id', 'complete', 'msg', {}));
});

test('the shared transport swallows failures for both lanes', async () => {
  const transport = () => Promise.reject(new Error('boom'));
  const warned: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warned.push(String(msg));
  try {
    await assert.doesNotReject(() => sendTelegramMessage({
      botToken: 'TOK', chatId: '1', text: 'x', tag: 'channel:telegram', transport,
    }));
    await assert.doesNotReject(() => sendPrPing('TOK', '1', 'x', { transport }));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warned.length, 2);
  assert.ok(warned[0].includes('[channel:telegram]'));
  assert.ok(warned[1].includes('[pr-telegram]'), 'the PR lane keeps its own log tag');
});

test('the shared transport posts the Telegram sendMessage shape', async () => {
  const calls: { url: string; body: unknown }[] = [];
  await sendTelegramMessage({
    botToken: 'TOK', chatId: '123', text: 'hello',
    transport: (url, body) => { calls.push({ url, body }); return Promise.resolve(); },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.telegram.org/botTOK/sendMessage');
  assert.deepEqual(calls[0].body, { chat_id: '123', text: 'hello' });
});
