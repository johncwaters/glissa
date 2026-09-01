let token = '';
let inflight: Promise<string> | null = null;

export function pageToken() {
  return token;
}

export function loadPageToken() {
  if (token) return Promise.resolve(token);
  if (inflight) return inflight;
  inflight = fetch('/control-token', { credentials: 'same-origin', cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .then((body: unknown) => {
      const tokenValue = (body as { token?: unknown } | null)?.token;
      token = typeof tokenValue === 'string' ? tokenValue : '';
      return token;
    })
    .catch(() => '')
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function clearPageToken() {
  token = '';
}

export function withPageToken(pathAndSearch: string) {
  if (!token) return pathAndSearch;
  const separator = pathAndSearch.includes('?') ? '&' : '?';
  return `${pathAndSearch}${separator}token=${encodeURIComponent(token)}`;
}
