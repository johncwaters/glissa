'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { sendPrPing } = require('../server/pr-telegram');

test('posts to the botToken URL with chat_id/text body via injected transport', async () => {
  let cap;
  const transport = (url, body) => {
    cap = { url, body };
    return Promise.resolve();
  };

  await sendPrPing('TOK', '123', 'hello', { transport });

  assert.ok(cap.url.includes('/botTOK/sendMessage'));
  assert.deepEqual(cap.body, { chat_id: '123', text: 'hello' });
});

test('resolves even when the transport throws', async () => {
  const warnCalls = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnCalls.push(msg);

  try {
    const transport = () => {
      throw new Error('boom');
    };
    await assert.doesNotReject(() => sendPrPing('TOK', '123', 'hello', { transport }));
  } finally {
    console.warn = origWarn;
  }

  assert.equal(warnCalls.length, 1);
  assert.ok(warnCalls[0].includes('[pr-telegram]'));
});

test('resolves even when the transport returns a rejected promise', async () => {
  const warnCalls = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnCalls.push(msg);

  try {
    const transport = () => Promise.reject(new Error('network down'));
    await assert.doesNotReject(() => sendPrPing('TOK', '123', 'hello', { transport }));
  } finally {
    console.warn = origWarn;
  }

  assert.equal(warnCalls.length, 1);
  assert.ok(warnCalls[0].includes('network down'));
});

test('missing token/chatId does not throw', async () => {
  const transport = () => Promise.resolve();
  await assert.doesNotReject(() => sendPrPing(undefined, undefined, 'hello', { transport }));
  await assert.doesNotReject(() => sendPrPing('', '', '', { transport }));
});
