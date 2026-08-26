// ── Dashboard page token ──────────────────────────────────────
// The third layer of the localhost defense (see server/backend.js): a local client must present a
// per-process token to open the control or data socket, so another web app on another local port
// cannot reach a channel that spawns permissionless sessions. The page fetches it same-origin, which
// a cross-origin page can issue but cannot read the answer to.
//
// A paired REMOTE device authenticates with its pairing cookie instead and is exempt server-side, but
// it fetches the token the same way (the endpoint sits behind the same gate), so there is one path
// here, not two.

let token = '';
/** @type {Promise<string>|null} */
let inflight = null;

export function pageToken() {
  return token;
}

/** Resolves once a token is held, or once the attempt failed; never rejects. */
export function loadPageToken() {
  if (token) return Promise.resolve(token);
  if (inflight) return inflight;
  inflight = fetch('/control-token', { credentials: 'same-origin', cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => {
      token = typeof body?.token === 'string' ? body.token : '';
      return token;
    })
    .catch(() => '')
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Drops the cached token so the next load refetches it: a restarted server mints a new one. */
export function clearPageToken() {
  token = '';
}

/** "/control?since=4" -> "/control?since=4&token=..."; a missing token leaves the target alone. */
export function withPageToken(pathAndSearch) {
  if (!token) return pathAndSearch;
  const separator = pathAndSearch.includes('?') ? '&' : '?';
  return `${pathAndSearch}${separator}token=${encodeURIComponent(token)}`;
}
