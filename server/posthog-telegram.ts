// PostHog-lane Telegram push helper, the sibling of server/pr-telegram.ts. NOT a
// notification-manager channel: this is a standalone fire-and-forget ping from a poller tick, so it
// must never let a network/API failure bubble up to its caller. The HTTP call itself lives in
// server/telegram-transport.ts, shared with the PR lane and the opt-in session-notification channel;
// the only thing this module adds is the lane's log tag and its positional signature.

import { sendTelegramMessage } from './telegram-transport.ts';
import type { TelegramTransport } from './telegram-transport.ts';

async function sendPosthogPing(
  botToken: string,
  chatId: string,
  text: string,
  opts: { transport?: TelegramTransport | null } = {},
): Promise<void> {
  await sendTelegramMessage({ botToken, chatId, text, tag: 'posthog', transport: opts.transport });
}

export { sendPosthogPing };
