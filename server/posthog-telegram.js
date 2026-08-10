'use strict';

// PostHog-lane Telegram push helper, the sibling of server/pr-telegram.js. NOT a
// notification-manager channel: this is a standalone fire-and-forget ping from a poller tick, so it
// must never let a network/API failure bubble up to its caller. The HTTP call itself lives in
// server/telegram-transport.js, shared with the PR lane and the opt-in session-notification channel;
// the only thing this module adds is the lane's log tag and its positional signature.

const { sendTelegramMessage } = require('./telegram-transport');

async function sendPosthogPing(botToken, chatId, text, opts = {}) {
  await sendTelegramMessage({ botToken, chatId, text, tag: 'posthog', transport: opts.transport });
}

module.exports = { sendPosthogPing };
