import https from 'node:https';

interface TelegramBody {
  chat_id: string;
  text: string;
}

type TelegramTransport = (url: string, body: TelegramBody) => Promise<unknown>;

interface SendTelegramOptions {
  botToken: string;
  chatId: string;

  text: string;

  tag?: string;

  transport?: TelegramTransport | null;
}

interface SendTelegramResult {
  ok: boolean;
  error: string | null;
}

function defaultTransport(url: string, bodyObject: TelegramBody): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObject);
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          const statusCode = res.statusCode ?? 0;
          if (statusCode >= 200 && statusCode < 300) {
            resolve();
            return;
          }
          reject(new Error(`non-2xx status ${statusCode}`));
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendTelegramMessage({
  botToken, chatId, text, tag = 'telegram', transport,
}: SendTelegramOptions): Promise<SendTelegramResult> {
  const send = transport || defaultTransport;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  try {
    await send(url, { chat_id: chatId, text });
    return { ok: true, error: null };
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : String(err);
    console.warn(`[${tag}] ${message}`);
    return { ok: false, error: message };
  }
}

export { sendTelegramMessage };
export type { SendTelegramOptions, SendTelegramResult, TelegramBody, TelegramTransport };
