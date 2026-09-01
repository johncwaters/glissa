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
