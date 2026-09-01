import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COOKIE_NAME, parseCookieHeader, serializeSetCookie, readDeviceCookie, decideCookieFlags,
} from '../server/core/cookie.ts';

test('parseCookieHeader handles absent, empty and malformed headers', () => {
  assert.deepEqual(parseCookieHeader(undefined), {});
  assert.deepEqual(parseCookieHeader(''), {});
  assert.deepEqual(parseCookieHeader('novalue'), {});
  assert.deepEqual(parseCookieHeader('=orphan'), {});
});

test('parseCookieHeader splits on semicolons and trims', () => {
  assert.deepEqual(parseCookieHeader('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseCookieHeader('  a = 1 ;b=2'), { a: '1', b: '2' });
});

test('a duplicated cookie name keeps the first value, so a trailing forgery cannot override', () => {
  assert.deepEqual(parseCookieHeader('glissa_device=real; glissa_device=forged'), { glissa_device: 'real' });
});

test('a value containing = keeps everything after the first separator', () => {
  assert.deepEqual(parseCookieHeader('a=b=c'), { a: 'b=c' });
});

test('serializeSetCookie emits HttpOnly and Path by default', () => {
  assert.equal(serializeSetCookie('n', 'v'), 'n=v; Path=/; HttpOnly; SameSite=Lax');
});

test('serializeSetCookie renders every flag it is given', () => {
  const header = serializeSetCookie('glissa_device', 'id.secret', {
    maxAgeSeconds: 60, secure: true, sameSite: 'Lax', path: '/', httpOnly: true,
  });
  assert.equal(header, 'glissa_device=id.secret; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax');
});

test('serializeSetCookie can omit HttpOnly and Secure', () => {
  const header = serializeSetCookie('n', 'v', { httpOnly: false, secure: false });
  assert.equal(header.includes('HttpOnly'), false);
  assert.equal(header.includes('Secure'), false);
});

test('readDeviceCookie splits id and secret on the first dot only', () => {
  assert.deepEqual(readDeviceCookie(`${COOKIE_NAME}=abc.def.ghi`), { id: 'abc', secret: 'def.ghi' });
});

test('readDeviceCookie returns null for every degenerate shape', () => {
  assert.equal(readDeviceCookie(undefined), null);
  assert.equal(readDeviceCookie('other=1'), null);
  assert.equal(readDeviceCookie(`${COOKIE_NAME}=`), null);
  assert.equal(readDeviceCookie(`${COOKIE_NAME}=nodot`), null);
  assert.equal(readDeviceCookie(`${COOKIE_NAME}=.leading`), null);
  assert.equal(readDeviceCookie(`${COOKIE_NAME}=trailing.`), null);
});

test('readDeviceCookie finds the cookie among others', () => {
  assert.deepEqual(readDeviceCookie(`theme=dark; ${COOKIE_NAME}=id.secret; x=y`), { id: 'id', secret: 'secret' });
});

test('Secure is set only when the proxy reports https', () => {
  assert.deepEqual(decideCookieFlags({ forwardedProto: 'https' }), { secure: true, sameSite: 'Lax' });
  assert.deepEqual(decideCookieFlags({ forwardedProto: 'HTTPS' }), { secure: true, sameSite: 'Lax' });
  assert.deepEqual(decideCookieFlags({ forwardedProto: 'https, http' }), { secure: true, sameSite: 'Lax' });
  assert.deepEqual(decideCookieFlags({ forwardedProto: 'http' }), { secure: false, sameSite: 'Lax' });
  assert.deepEqual(decideCookieFlags({}), { secure: false, sameSite: 'Lax' });
  assert.deepEqual(decideCookieFlags(), { secure: false, sameSite: 'Lax' });
});

// The proxy's word wins outright. A browser genuinely on TLS must get a Secure cookie, so no local
// bind setting may veto the flag; a wider bind is not evidence about the scheme the browser used.
test('a wider bind never strips Secure from a proxied https request', () => {
  assert.equal(decideCookieFlags({ forwardedProto: 'https', insecureBind: true }).secure, true);
  assert.equal(decideCookieFlags({ forwardedProto: 'http', insecureBind: true }).secure, false);
});

test('with no proxy header Secure stays off, whatever the bind mode', () => {
  assert.equal(decideCookieFlags({ insecureBind: true }).secure, false);
  assert.equal(decideCookieFlags({ insecureBind: false }).secure, false);
  assert.equal(decideCookieFlags({ forwardedProto: '  ' }).secure, false);
});
