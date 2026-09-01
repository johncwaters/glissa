import test from 'node:test';
import assert from 'node:assert/strict';

import { sendPrPing } from '../server/pr-telegram.ts';
import type { TelegramBody, TelegramTransport } from '../server/telegram-transport.ts';

function captureWarnings(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message: unknown) => {
    warnings.push(String(message));
  };
  return { warnings, restore: () => { console.warn = original; } };
}

test('posts to the botToken URL with chat_id/text body via injected transport', async () => {
  let captured: { url: string; body: TelegramBody } | null = null;
  const transport: TelegramTransport = (url, body) => {
    captured = { url, body };
    return Promise.resolve();
  };

  await sendPrPing('TOK', '123', 'hello', { transport });

  assert.ok(captured, 'the transport was called');
  const { url, body }: { url: string; body: TelegramBody } = captured;
  assert.ok(url.includes('/botTOK/sendMessage'));
  assert.deepEqual(body, { chat_id: '123', text: 'hello' });
});

test('resolves even when the transport throws', async () => {
  const { warnings, restore } = captureWarnings();
  try {
    const transport: TelegramTransport = () => {
      throw new Error('boom');
    };
    await assert.doesNotReject(() => sendPrPing('TOK', '123', 'hello', { transport }));
  } finally {
    restore();
  }

  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]?.includes('[pr-telegram]'));
});

test('resolves even when the transport returns a rejected promise', async () => {
  const { warnings, restore } = captureWarnings();
  try {
    const transport: TelegramTransport = () => Promise.reject(new Error('network down'));
    await assert.doesNotReject(() => sendPrPing('TOK', '123', 'hello', { transport }));
  } finally {
    restore();
  }

  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]?.includes('network down'));
});

test('empty token/chatId does not throw', async () => {
  const transport: TelegramTransport = () => Promise.resolve();
  await assert.doesNotReject(() => sendPrPing('', '', '', { transport }));
});
