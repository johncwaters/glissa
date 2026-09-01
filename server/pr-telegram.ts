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
