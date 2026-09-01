const COOKIE_NAME = 'glissa_device';

export interface SetCookieOptions {
  maxAgeSeconds?: number | null;
  secure?: boolean;
  sameSite?: string;
  path?: string;
  httpOnly?: boolean;
}

export interface DeviceCookie {
  id: string;
  secret: string;
}

export interface CookieFlags {
  secure: boolean;
  sameSite: string;
}

function parseCookieHeader(header: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof header !== 'string' || header === '') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === '') continue;
    const value = part.slice(eq + 1).trim();
    if (name in out) continue;
    out[name] = value;
  }
  return out;
}

function serializeSetCookie(name: string, value: string | undefined, opts: SetCookieOptions = {}): string {
  const {
    maxAgeSeconds = null,
    secure = false,
    sameSite = 'Lax',
    path = '/',
    httpOnly = true,
  } = opts;
  const parts = [`${name}=${value}`];
  parts.push(`Path=${path}`);
  if (maxAgeSeconds != null) parts.push(`Max-Age=${Math.floor(maxAgeSeconds)}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (sameSite) parts.push(`SameSite=${sameSite}`);
  return parts.join('; ');
}

function readDeviceCookie(header: unknown, cookieName: string = COOKIE_NAME): DeviceCookie | null {
  const jar = parseCookieHeader(header);
  const raw = jar[cookieName];
  if (typeof raw !== 'string' || raw === '') return null;
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;
  return { id: raw.slice(0, dot), secret: raw.slice(dot + 1) };
}

function decideCookieFlags({ forwardedProto }: { forwardedProto?: unknown; [key: string]: unknown } = {}): CookieFlags {
  const first = typeof forwardedProto === 'string' ? forwardedProto.split(',')[0].trim().toLowerCase() : '';
  return { secure: first === 'https', sameSite: 'Lax' };
}

export { COOKIE_NAME, parseCookieHeader, serializeSetCookie, readDeviceCookie, decideCookieFlags };
