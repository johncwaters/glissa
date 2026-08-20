'use strict';

const HEADER_END = '\r\n\r\n';
const CONTENT_LENGTH_RE = /^content-length:\s*(\d+)\s*$/i;
const CONTENT_LENGTH_HEADER = 'content-length:';

function createParserState() {
  return {
    buffer: Buffer.alloc(0),
    neededBodyBytes: null,
  };
}

function feedFrameBytes(state, chunk) {
  const nextState = state || createParserState();
  nextState.buffer = Buffer.concat([nextState.buffer, chunk]);
  const messages = [];

  while (true) {
    const bodyBytes = readNeededBodyBytes(nextState);
    if (bodyBytes === null) break;
    if (bodyBytes.parseError) {
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

function readNeededBodyBytes(state) {
  if (state.neededBodyBytes !== null) return state.neededBodyBytes;

  const headerEndAt = state.buffer.indexOf(HEADER_END);
  if (headerEndAt === -1) return null;

  const headerText = state.buffer.subarray(0, headerEndAt).toString('ascii');
  state.buffer = state.buffer.subarray(headerEndAt + HEADER_END.length);
  const contentLength = contentLengthFromHeader(headerText);
  if (contentLength === null) {
    resyncAfterBadHeader(state);
    return { parseError: true, reason: 'missing-content-length', raw: headerText };
  }
  state.neededBodyBytes = contentLength;
  return state.neededBodyBytes;
}

function contentLengthFromHeader(headerText) {
  const lines = headerText.split('\r\n');
  for (const line of lines) {
    const match = line.match(CONTENT_LENGTH_RE);
    if (!match) continue;
    return Number(match[1]);
  }
  return null;
}

function parseBody(body) {
  const raw = body.toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return { parseError: true, raw };
  }
}

function resyncAfterBadHeader(state) {
  const lowerBuffer = state.buffer.toString('ascii').toLowerCase();
  const headerAt = lowerBuffer.indexOf(CONTENT_LENGTH_HEADER);
  if (headerAt >= 0) {
    state.buffer = state.buffer.subarray(headerAt);
    return;
  }

  const maxSuffixLength = Math.min(state.buffer.length, CONTENT_LENGTH_HEADER.length - 1);
  for (let suffixLength = maxSuffixLength; suffixLength > 0; suffixLength--) {
    const suffix = lowerBuffer.slice(lowerBuffer.length - suffixLength);
    if (!CONTENT_LENGTH_HEADER.startsWith(suffix)) continue;
    state.buffer = state.buffer.subarray(state.buffer.length - suffixLength);
    return;
  }

  state.buffer = Buffer.alloc(0);
}

function serializeFrame(messageObject) {
  const body = JSON.stringify(messageObject);
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  return Buffer.from(`Content-Length: ${bodyBytes}\r\n\r\n${body}`, 'utf8');
}

function classifyMessage(msg) {
  if (!msg || typeof msg !== 'object') return { kind: 'invalid', method: undefined, id: undefined };

  const hasMethod = typeof msg.method === 'string';
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
  if (hasMethod && hasId) return { kind: 'request', method: msg.method, id: msg.id };
  if (hasMethod) return { kind: 'notification', method: msg.method, id: undefined };
  if (hasId) return { kind: 'response', method: undefined, id: msg.id };
  return { kind: 'invalid', method: undefined, id: undefined };
}

module.exports = {
  createParserState,
  feedFrameBytes,
  serializeFrame,
  classifyMessage,
};
