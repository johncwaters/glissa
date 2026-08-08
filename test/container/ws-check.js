'use strict';

// WebSocket probe for the remote-mode container suite. Raw WS handshakes in curl are not worth the
// shell, so this is the one place the integration script shells out to node.
//
//   node test/container/ws-check.js <url> [--cookie <header-value>] [--origin <origin>]
//
// Exit 0 = the socket opened AND the control channel delivered a snapshot (a real authenticated
// session, not just a TCP connect). Exit 1 = refused. Prints one line either way.

const WebSocket = require('ws');

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

const url = process.argv[2];
if (!url) {
  console.log('REJECTED usage');
  process.exit(1);
}

const headers = {};
const cookie = argValue('--cookie');
if (cookie) headers.Cookie = cookie;
const origin = argValue('--origin');

const ws = new WebSocket(url, { headers, origin: origin || undefined });

const timer = setTimeout(() => {
  console.log('REJECTED timeout');
  process.exit(1);
}, 8000);

function done(code, message) {
  clearTimeout(timer);
  console.log(message);
  try { ws.close(); } catch { /* already gone */ }
  process.exit(code);
}

ws.on('message', (data) => {
  let msg = {};
  try { msg = JSON.parse(data.toString()); } catch { return; }
  if (msg.type === 'snapshot') done(0, 'OK snapshot');
});

ws.on('open', () => {
  // A data socket (/terminals/*) never sends a snapshot; opening is the whole signal there.
  if (!url.includes('/control')) done(0, 'OK open');
});

ws.on('error', (err) => done(1, `REJECTED ${err.message}`));
ws.on('close', () => done(1, 'REJECTED closed'));
