'use strict';

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
  try { ws.close(); } catch {  }
  process.exit(code);
}

ws.on('message', (data) => {
  let msg = {};
  try { msg = JSON.parse(data.toString()); } catch { return; }
  if (msg.type === 'snapshot') done(0, 'OK snapshot');
});

ws.on('open', () => {
  if (!url.includes('/control')) done(0, 'OK open');
});

ws.on('error', (err) => done(1, `REJECTED ${err.message}`));
ws.on('close', () => done(1, 'REJECTED closed'));
