// PR-only Telegram push helper. NOT a notification-manager channel - this is a standalone
// fire-and-forget ping used by PR-related tooling, so it must never let a network/API failure
// bubble up to its caller. The HTTP call itself lives in server/telegram-transport.ts, shared with
// the opt-in session-notification channel (notifications/channels/telegram.ts); the only thing this
// module adds is the lane's log tag and its positional signature.

import { sendTelegramMessage } from './telegram-transport.ts';
import type { TelegramTransport } from './telegram-transport.ts';

async function sendPrPing(
  botToken: string,
  chatId: string,
  text: string,
  opts: { transport?: TelegramTransport | null } = {},
): Promise<void> {
  await sendTelegramMessage({ botToken, chatId, text, tag: 'pr-telegram', transport: opts.transport });
}

export { sendPrPing };
