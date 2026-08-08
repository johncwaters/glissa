'use strict';

// PR-only Telegram push helper. NOT a notification-manager channel - this is a standalone
// fire-and-forget ping used by PR-related tooling, so it must never let a network/API failure
// bubble up to its caller. The HTTP call itself lives in server/telegram-transport.js, shared with
// the opt-in session-notification channel (notifications/channels/telegram.js); the only thing this
// module adds is the lane's log tag and its positional signature.

const { sendTelegramMessage } = require('./telegram-transport');

async function sendPrPing(botToken, chatId, text, opts = {}) {
  await sendTelegramMessage({ botToken, chatId, text, tag: 'pr-telegram', transport: opts.transport });
}

module.exports = { sendPrPing };
