import WebSocket from 'ws';

// Test-side twin of public/ws-token.ts. The control and data channels are dashboard-only routes: they
// require a browser Origin on a listener port and the per-process page token, so a test client that
// stands in for the page has to carry both. Everything here is what the browser does, in one place, so
// a suite exercising the real upgrade path does not restate the handshake. The socket helpers below
// are the other half every dashboard suite repeated: open, record, wait, close.

interface DashboardClient {
  origin: string;
  token: string;
  url: (pathAndSearch: string) => string;
  options: { origin: string };
}

// A socket whose frames are recorded from construction onward. `TFrame` is the shape the suite asserts
// on: JSON.parse hands back an untyped value, so each suite states what it expects to read.
interface RecordingSocket<TFrame> {
  ws: WebSocket;
  received: TFrame[];
}

const DEFAULT_MESSAGE_WAIT_MS = 5000;

async function fetchPageToken(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/control-token`);
  if (!res.ok) throw new Error(`/control-token answered ${res.status}`);
  const body = await res.json();
  return body.token;
}

function dashboardOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function withToken(pathAndSearch: string, token: string): string {
  const separator = pathAndSearch.includes('?') ? '&' : '?';
  return `${pathAndSearch}${separator}token=${encodeURIComponent(token)}`;
}

async function dashboardClient(port: number): Promise<DashboardClient> {
  const token = await fetchPageToken(port);
  const origin = dashboardOrigin(port);
  return {
    origin,
    token,
    url: (pathAndSearch: string) => `ws://127.0.0.1:${port}${withToken(pathAndSearch, token)}`,
    options: { origin },
  };
}

function openSocket(client: DashboardClient, pathAndSearch: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(client.url(pathAndSearch), client.options);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/**
 * Opens a socket that records every message from construction onward, in arrival order.
 *
 * The recording has to start before 'open' resolves: the server sends the snapshot the instant the
 * connection lands, so the 101 response and the first frames usually arrive in ONE socket read and ws
 * emits 'open' and 'message' synchronously within it. A listener attached after awaiting 'open' misses
 * the snapshot entirely.
 */
function openRecordingSocket<TFrame>(
  client: DashboardClient,
  pathAndSearch = '/control',
): Promise<RecordingSocket<TFrame>> {
  const ws = new WebSocket(client.url(pathAndSearch), client.options);
  const received: TFrame[] = [];
  ws.on('message', (raw: Buffer) => received.push(JSON.parse(raw.toString())));
  return new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', () => resolve({ ws, received }));
  });
}

function closeSocket(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.once('close', () => resolve());
    ws.close();
  });
}

// The first overload keeps a type predicate's narrowing, so a suite matching on a frame's `type`
// gets that frame's shape back rather than the whole union it was recorded as.
async function waitForMessage<TFrame, TMatch extends TFrame>(
  received: TFrame[],
  matches: (frame: TFrame) => frame is TMatch,
  label: string,
  timeoutMs?: number,
): Promise<TMatch>;
async function waitForMessage<TFrame>(
  received: TFrame[],
  matches: (frame: TFrame) => boolean,
  label: string,
  timeoutMs?: number,
): Promise<TFrame>;
async function waitForMessage<TFrame>(
  received: TFrame[],
  matches: (frame: TFrame) => boolean,
  label: string,
  timeoutMs = DEFAULT_MESSAGE_WAIT_MS,
): Promise<TFrame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = received.find(matches);
    if (hit !== undefined) return hit;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

export {
  closeSocket, dashboardClient, dashboardOrigin, fetchPageToken,
  openRecordingSocket, openSocket, waitForMessage, withToken,
};
export type { DashboardClient, RecordingSocket };
