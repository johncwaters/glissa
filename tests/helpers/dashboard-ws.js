'use strict';

// Test-side twin of public/ws-token.ts. The control and data channels are dashboard-only routes: they
// require a browser Origin on a listener port and the per-process page token, so a test client that
// stands in for the page has to carry both. Everything here is what the browser does, in one place, so
// a suite exercising the real upgrade path does not restate the handshake.

async function fetchPageToken(port) {
  const res = await fetch(`http://127.0.0.1:${port}/control-token`);
  if (!res.ok) throw new Error(`/control-token answered ${res.status}`);
  const body = await res.json();
  return body.token;
}

function dashboardOrigin(port) {
  return `http://127.0.0.1:${port}`;
}

function withToken(pathAndSearch, token) {
  const separator = pathAndSearch.includes('?') ? '&' : '?';
  return `${pathAndSearch}${separator}token=${encodeURIComponent(token)}`;
}

/**
 * @param {number} port the bound listener port
 * @returns {{ origin: string, token: string, url: (p: string) => string, options: object }}
 */
async function dashboardClient(port) {
  const token = await fetchPageToken(port);
  const origin = dashboardOrigin(port);
  return {
    origin,
    token,
    url: (pathAndSearch) => `ws://127.0.0.1:${port}${withToken(pathAndSearch, token)}`,
    options: { origin },
  };
}

module.exports = { dashboardClient, dashboardOrigin, fetchPageToken, withToken };
