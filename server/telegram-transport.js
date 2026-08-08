'use strict';

// The one Telegram sendMessage path. Two callers with unrelated lifecycles share it: the PR
// auto-review lane (server/pr-telegram.js) and the opt-in session-notification channel
// (notifications/channels/telegram.js).
//
// Fire-and-forget by contract: it NEVER throws and never rejects. Both callers sit on paths where a
// failed ping must not disturb the work that triggered it (a poller tick, a notification delivery
// loop), and this process has no uncaughtException handler by design.

const https = require('node:https');

function defaultTransport(url, bodyObject) {
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
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
            return;
          }
          reject(new Error(`non-2xx status ${res.statusCode}`));
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * @param {object} opts
 * @param {string} opts.botToken
 * @param {string} opts.chatId
 * @param {string} opts.text plain text, no parse_mode - no markdown escaping surprises
 * @param {string} [opts.tag] log prefix identifying the calling lane
 * @param {Function} [opts.transport] injected for tests
 */
async function sendTelegramMessage({ botToken, chatId, text, tag = 'telegram', transport }) {
  const send = transport || defaultTransport;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  try {
    await send(url, { chat_id: chatId, text });
  } catch (err) {
    console.warn(`[${tag}] ${err?.message ? err.message : String(err)}`);
  }
}

module.exports = { sendTelegramMessage };
