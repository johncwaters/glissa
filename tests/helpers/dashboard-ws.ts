import WebSocket from 'ws';

interface DashboardClient {
  origin: string;
  token: string;
  url: (pathAndSearch: string) => string;
  options: { origin: string };
}

interface RecordingSocket<TFrame> {
  ws: WebSocket;
  received: TFrame[];
}

interface DataFrame {
  binary: boolean;
  text: string;
}

interface DataRecordingSocket {
  ws: WebSocket;
  frames: DataFrame[];
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

function openDataRecordingSocket(client: DashboardClient, pathAndSearch: string): Promise<DataRecordingSocket> {
  const ws = new WebSocket(client.url(pathAndSearch), client.options);
  const frames: DataFrame[] = [];
  ws.on('message', (raw: Buffer, isBinary: boolean) => {
    frames.push({ binary: isBinary, text: raw.toString('utf8') });
  });
  return new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', () => resolve({ ws, frames }));
  });
}

function binaryFramesOf(socket: DataRecordingSocket): string[] {
  return socket.frames.filter((frame) => frame.binary).map((frame) => frame.text);
}

function textFramesOf(socket: DataRecordingSocket): string[] {
  return socket.frames.filter((frame) => !frame.binary).map((frame) => frame.text);
}

function closeSocket(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.once('close', () => resolve());
    ws.close();
  });
}

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
  binaryFramesOf, closeSocket, dashboardClient, dashboardOrigin, fetchPageToken,
  openDataRecordingSocket, openRecordingSocket, openSocket, textFramesOf, waitForMessage, withToken,
};
export type { DashboardClient, DataFrame, DataRecordingSocket, RecordingSocket };
