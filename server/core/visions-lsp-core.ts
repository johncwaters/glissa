const HEADER_END = '\r\n\r\n';
const CONTENT_LENGTH_RE = /^content-length:\s*(\d+)\s*$/i;

export interface LspParserState {
  buffer: Buffer;
  neededBodyBytes: number | null;
}

export interface LspParseError {
  parseError: true;
  reason?: string;
  raw: string;
}

export type LspMessage = Record<string, unknown> | LspParseError;

function createParserState(): LspParserState {
  return {
    buffer: Buffer.alloc(0),
    neededBodyBytes: null,
  };
}

function feedFrameBytes(
  state: LspParserState | null | undefined,
  chunk: Buffer,
): { state: LspParserState; messages: LspMessage[] } {
  const nextState = state || createParserState();
  nextState.buffer = Buffer.concat([nextState.buffer, chunk]);
  const messages: LspMessage[] = [];

  while (true) {
    const bodyBytes = readNeededBodyBytes(nextState);
    if (bodyBytes === null) break;
    if (typeof bodyBytes !== 'number') {
      messages.push(bodyBytes);
      nextState.neededBodyBytes = null;
      continue;
    }
    if (nextState.buffer.length < bodyBytes) break;

    const body = nextState.buffer.subarray(0, bodyBytes);
    nextState.buffer = nextState.buffer.subarray(bodyBytes);
    nextState.neededBodyBytes = null;
    messages.push(parseBody(body));
  }

  return { state: nextState, messages };
}

function readNeededBodyBytes(state: LspParserState): number | LspParseError | null {
  if (state.neededBodyBytes !== null) return state.neededBodyBytes;

  const headerEndAt = state.buffer.indexOf(HEADER_END);
  if (headerEndAt === -1) return null;

  const headerText = state.buffer.subarray(0, headerEndAt).toString('ascii');
  state.buffer = state.buffer.subarray(headerEndAt + HEADER_END.length);
  const contentLength = contentLengthFromHeader(headerText);
  // Nothing after a headerless block can be framed, and an editor's own LSP client does not send one.
  if (contentLength === null) {
    state.buffer = Buffer.alloc(0);
    return { parseError: true, reason: 'missing-content-length', raw: headerText };
  }
  state.neededBodyBytes = contentLength;
  return state.neededBodyBytes;
}

function contentLengthFromHeader(headerText: string): number | null {
  const lines = headerText.split('\r\n');
  for (const line of lines) {
    const match = line.match(CONTENT_LENGTH_RE);
    if (!match) continue;
    return Number(match[1]);
  }
  return null;
}

function parseBody(body: Buffer): LspMessage {
  const raw = body.toString('utf8');
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { parseError: true, raw };
  }
}

function serializeFrame(messageObject: unknown): Buffer {
  const body = JSON.stringify(messageObject);
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  return Buffer.from(`Content-Length: ${bodyBytes}\r\n\r\n${body}`, 'utf8');
}

function classifyMessage(msg: unknown): { kind: string; method: string | undefined; id: unknown } {
  if (!msg || typeof msg !== 'object') return { kind: 'invalid', method: undefined, id: undefined };
  const fields = msg as { method?: unknown; id?: unknown };

  const hasMethod = typeof fields.method === 'string';
  const hasId = Object.hasOwn(msg, 'id');
  const method = typeof fields.method === 'string' ? fields.method : undefined;
  if (hasMethod && hasId) return { kind: 'request', method, id: fields.id };
  if (hasMethod) return { kind: 'notification', method, id: undefined };
  if (hasId) return { kind: 'response', method: undefined, id: fields.id };
  return { kind: 'invalid', method: undefined, id: undefined };
}

export { createParserState, feedFrameBytes, serializeFrame, classifyMessage };
