'use strict';

// PR-only Telegram push helper. NOT a notification-manager channel - this is
// a standalone fire-and-forget ping used by PR-related tooling, so it must
// never let a network/API failure bubble up to its caller.

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

async function sendPrPing(botToken, chatId, text, opts = {}) {
  const transport = opts.transport || defaultTransport;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = { chat_id: chatId, text };

  try {
    await transport(url, body);
  } catch (err) {
    console.warn(`[pr-telegram] ${err?.message ? err.message : String(err)}`);
  }
}

module.exports = { sendPrPing };
