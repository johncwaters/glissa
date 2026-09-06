const SOURCE = 'agentLogs';

const PROMPT_KIND = 'agent-prompt';

const MAX_RAW_CHARS = 4000;

export type VendorState = Record<string, string>;

export type AgentIngestEvent = {
  source: string;
  kind: string;
  ts: number;
  scope: { root: string | null; sessionId: string | null };
  summary: string;
  detail: Record<string, unknown>;
}

export interface AgentMapResult {
  events: AgentIngestEvent[];
  root: string | null;
  sessionId: string | null;
  vendorState: VendorState | null;
}

type ContentBlock = { type?: unknown; text?: unknown; name?: unknown; input?: unknown };

type GrokUpdate = {
  sessionUpdate?: unknown;
  content?: { text?: unknown };
  stop_reason?: unknown;
  rawInput?: unknown;
  title?: unknown;
  _meta?: Record<string, { name?: unknown }>;
};

type TranscriptLine = {
  type?: unknown;
  cwd?: unknown;
  sessionId?: unknown;
  timestamp?: unknown;
  isMeta?: unknown;
  isCompactSummary?: unknown;
  message?: { content?: unknown };
  payload?: Record<string, unknown>;
  params?: { update?: GrokUpdate; sessionId?: unknown };
};

interface MapContext {
  root: string | null;
  sessionId: string | null;
  vendorState: VendorState | null;
  includeUserPrompts: boolean;
  now: number;
}

interface EventBase {
  ts: number;
  root: string | null;
  sessionId: string | null;
  vendor: string;
}

const TOOL_TARGET_KEYS: readonly string[] = Object.freeze([
  'file_path', 'notebook_path', 'path', 'command', 'pattern', 'url', 'query', 'to', 'subagent_type',
  'description', 'prompt',
]);

const DISPATCH_WORKDIR_MARKERS: readonly string[] = Object.freeze([
  'glissa-visions', 'glissa-memory-distill', 'glissa-wt-pr-review', 'glissa-wt-radar-fix',
]);
const DISPATCH_WORKDIR_PATTERN = new RegExp(`(^|[\\\\/-])(${DISPATCH_WORKDIR_MARKERS.join('|')})-`, 'i');

function isDispatchWorkdir(candidate: unknown): boolean {
  if (typeof candidate !== 'string' || !candidate) return false;
  if (DISPATCH_WORKDIR_PATTERN.test(candidate)) return true;

  try {
    const decoded = decodeURIComponent(candidate);
    if (decoded === candidate) return false;
    return DISPATCH_WORKDIR_PATTERN.test(decoded);
  } catch {
    return false;
  }
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}

function boundRaw(value: unknown, max: number = MAX_RAW_CHARS): string {
  const text = String(value == null ? '' : value);
  if (text.length <= max) return text;
  const lastBreak = Math.max(text.lastIndexOf('\n', max), text.lastIndexOf('\r', max));
  if (lastBreak > 0) return text.slice(0, lastBreak).replace(/[\r\n]+$/, '');
  return text;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 0 && value < 1e12) return Math.floor(value * 1000);
    if (value > 0) return Math.floor(value);
    return null;
  }
  const text = str(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function parseJson(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toolTarget(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const record = input as Record<string, unknown>;
  for (const key of TOOL_TARGET_KEYS) {
    const value = str(record[key]);
    if (!value) continue;
    return boundRaw(value);
  }
  return '';
}

function turnEvent({ ts, root, sessionId, vendor, text }: EventBase & { text: unknown }): AgentIngestEvent | null {
  const summary = boundRaw(text).trim();
  if (!summary) return null;
  return {
    source: SOURCE,
    kind: 'agent-turn',
    ts,
    scope: { root, sessionId },
    summary: `${vendor}: ${summary}`,
    detail: { vendor },
  };
}

function promptEvent({ ts, root, sessionId, vendor, text }: EventBase & { text: unknown }): AgentIngestEvent | null {
  const summary = boundRaw(text).trim();
  if (!summary) return null;
  return {
    source: SOURCE,
    kind: PROMPT_KIND,
    ts,
    scope: { root, sessionId },
    summary: `${vendor} prompt: ${summary}`,
    detail: { vendor },
  };
}

function toolEvent({ ts, root, sessionId, vendor, name, target }: EventBase & { name: unknown; target: string }): AgentIngestEvent {
  const tool = boundRaw(str(name) || 'tool');
  const suffix = target ? ` ${target}` : '';
  return {
    source: SOURCE,
    kind: 'agent-tool',
    ts,
    scope: { root, sessionId },
    summary: `${vendor}: ${tool}${suffix}`,
    detail: { vendor, tool },
  };
}

function result(
  events: AgentIngestEvent[],
  root: string | null,
  sessionId: string | null,
  vendorState: VendorState | null,
): AgentMapResult {
  return { events, root, sessionId, vendorState };
}

function firstTextBlock(content: ContentBlock[]): string | null {
  for (const block of content) {
    if (block?.type !== 'text') continue;
    const text = str(block.text);
    if (text) return text;
  }
  return null;
}

function claudeUserText(line: TranscriptLine): string | null {
  if (line.isMeta === true || line.isCompactSummary === true) return null;
  const content = line.message?.content;
  if (typeof content === 'string') return str(content);
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block?.type === 'tool_result') return null;
  }
  return firstTextBlock(content);
}

function mapClaudeUserLine(line: TranscriptLine, ctx: MapContext): AgentMapResult | null {
  const text = claudeUserText(line);
  if (!text) return null;
  const root = str(line.cwd) || ctx.root;
  const sessionId = str(line.sessionId) || ctx.sessionId;
  const prompt = promptEvent({
    ts: parseTimestamp(line.timestamp) || ctx.now, root, sessionId, vendor: 'claude', text,
  });
  return result(prompt ? [prompt] : [], root, sessionId, ctx.vendorState);
}

function mapClaudeLine(line: TranscriptLine, ctx: MapContext): AgentMapResult | null {
  if (line.type === 'user') return ctx.includeUserPrompts ? mapClaudeUserLine(line, ctx) : null;
  if (line.type !== 'assistant') return null;
  const content = line.message?.content;
  if (!Array.isArray(content)) return null;

  const root = str(line.cwd) || ctx.root;
  const sessionId = str(line.sessionId) || ctx.sessionId;
  const ts = parseTimestamp(line.timestamp) || ctx.now;
  const events: AgentIngestEvent[] = [];
  const turn = turnEvent({ ts, root, sessionId, vendor: 'claude', text: firstTextBlock(content) });
  if (turn) events.push(turn);
  for (const block of content) {
    if (block?.type !== 'tool_use') continue;
    events.push(toolEvent({
      ts, root, sessionId, vendor: 'claude', name: block.name, target: toolTarget(block.input),
    }));
  }
  return result(events, root, sessionId, ctx.vendorState);
}

function mapCodexLine(line: TranscriptLine, ctx: MapContext): AgentMapResult | null {
  const payload = line.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const ts = parseTimestamp(line.timestamp) || ctx.now;

  if (line.type === 'session_meta' || line.type === 'turn_context') {
    return result([], str(payload.cwd) || ctx.root, str(payload.session_id) || ctx.sessionId, ctx.vendorState);
  }
  const base: EventBase = { ts, root: ctx.root, sessionId: ctx.sessionId, vendor: 'codex' };
  if (ctx.includeUserPrompts && line.type === 'event_msg' && payload.type === 'user_message') {
    const prompt = promptEvent({ ...base, text: payload.message });
    if (!prompt) return null;
    return result([prompt], ctx.root, ctx.sessionId, ctx.vendorState);
  }

  if (line.type === 'event_msg' && payload.type === 'agent_message') {
    const turn = turnEvent({ ...base, text: payload.message });
    if (!turn) return null;
    return result([turn], ctx.root, ctx.sessionId, ctx.vendorState);
  }
  if (line.type === 'response_item' && payload.type === 'function_call') {
    const target = toolTarget(parseJson(payload.arguments));
    return result([toolEvent({ ...base, name: payload.name, target })], ctx.root, ctx.sessionId, ctx.vendorState);
  }
  return null;
}

const PENDING_TURN_FIELD = 'pendingText';
const PENDING_PROMPT_FIELD = 'pendingUserText';

function appendChunk(vendorState: VendorState | null | undefined, text: unknown, field: string): VendorState {
  const addition = str(text);
  const held = typeof vendorState?.[field] === 'string' ? vendorState[field] : '';
  if (!addition) return { [field]: held };
  const remaining = MAX_RAW_CHARS - held.length - 1;
  if (remaining <= 0) return { [field]: held };
  const bounded = boundRaw(addition, remaining);

  if (bounded.length > remaining) return { [field]: held };
  return { [field]: `${held} ${bounded}` };
}

const GROK_TURN_BOUNDARIES: readonly string[] = Object.freeze(['user_message_chunk', 'retry_state']);

function takeGrokPrompt(
  vendorState: VendorState | null,
  base: EventBase,
): { events: AgentIngestEvent[]; vendorState: VendorState | null } {
  const held = str(vendorState?.[PENDING_PROMPT_FIELD]);
  if (!held) return { events: [], vendorState };
  const prompt = promptEvent({ ...base, text: held });
  return {
    events: prompt ? [prompt] : [],
    vendorState: { [PENDING_TURN_FIELD]: str(vendorState?.[PENDING_TURN_FIELD]) || '' },
  };
}

function grokToolName(update: GrokUpdate): string {
  const meta = update._meta && typeof update._meta === 'object' ? update._meta['x.ai/tool'] : null;
  return str(meta?.name) || str(update.title) || 'tool';
}

function mapGrokTurn(
  kind: string | null,
  update: GrokUpdate,
  base: EventBase,
  ctx: { root: string | null; sessionId: string | null; vendorState: VendorState | null },
): AgentMapResult | null {
  if (kind !== null && GROK_TURN_BOUNDARIES.includes(kind)) return result([], ctx.root, ctx.sessionId, null);
  if (kind === 'agent_message_chunk') {
    const next = appendChunk(ctx.vendorState, update.content?.text, PENDING_TURN_FIELD);
    return result([], ctx.root, ctx.sessionId, next);
  }
  if (kind === 'turn_completed') {
    const pending = str(ctx.vendorState?.[PENDING_TURN_FIELD]);
    const stopReason = str(update.stop_reason);
    const text = pending || `turn complete${stopReason ? ` (${stopReason})` : ''}`;
    const turn = turnEvent({ ...base, text });
    if (!turn) return result([], ctx.root, ctx.sessionId, null);
    return result([turn], ctx.root, ctx.sessionId, null);
  }

  if (kind === 'tool_call') {
    const target = toolTarget(update.rawInput);
    return result([toolEvent({ ...base, name: grokToolName(update), target })], ctx.root, ctx.sessionId, ctx.vendorState);
  }
  return null;
}

function mapGrokLine(line: TranscriptLine, ctx: MapContext): AgentMapResult | null {
  const update = line.params?.update;
  if (!update || typeof update !== 'object' || Array.isArray(update)) return null;
  const sessionId = str(line.params?.sessionId) || ctx.sessionId;
  const ts = parseTimestamp(line.timestamp) || ctx.now;
  const base: EventBase = { ts, root: ctx.root, sessionId, vendor: 'grok' };
  const kind = str(update.sessionUpdate);
  if (kind === 'user_message_chunk' && ctx.includeUserPrompts) {
    const next = appendChunk(ctx.vendorState, update.content?.text, PENDING_PROMPT_FIELD);
    return result([], ctx.root, sessionId, next);
  }
  const prompt = takeGrokPrompt(ctx.vendorState, base);
  const turn = mapGrokTurn(kind, update, base, {
    root: ctx.root, sessionId, vendorState: prompt.vendorState,
  });

  if (!turn) {
    if (prompt.events.length === 0) return null;
    return result(prompt.events, ctx.root, sessionId, prompt.vendorState);
  }
  return result([...prompt.events, ...turn.events], turn.root, turn.sessionId, turn.vendorState);
}

const MAPPERS: Readonly<Record<string, ((line: TranscriptLine, ctx: MapContext) => AgentMapResult | null) | undefined>> =
  Object.freeze({ claude: mapClaudeLine, codex: mapCodexLine, grok: mapGrokLine });

function mapAgentLine({
  vendor = '',
  rawLine = null,
  ctx = {},
  vendorState = null,
  includeUserPrompts = false,
}: {
  vendor?: string;
  rawLine?: unknown;
  ctx?: { root?: string | null; sessionId?: string | null; now?: number };
  vendorState?: VendorState | null;
  includeUserPrompts?: boolean;
} = {}): AgentMapResult {
  const root = ctx.root == null ? null : ctx.root;
  const sessionId = ctx.sessionId == null ? null : ctx.sessionId;
  const unchanged = result([], root, sessionId, vendorState);
  const mapper = MAPPERS[vendor];
  if (!mapper) return unchanged;
  const line = parseJson(rawLine);
  if (!line) return unchanged;
  const mapped = mapper(line as TranscriptLine, {
    root, sessionId, vendorState, includeUserPrompts: includeUserPrompts === true,
    now: typeof ctx.now === 'number' && Number.isFinite(ctx.now) ? ctx.now : 0,
  });
  if (!mapped) return unchanged;
  return mapped;
}

export {
  DISPATCH_WORKDIR_MARKERS,
  MAX_RAW_CHARS,
  PROMPT_KIND,
  isDispatchWorkdir,
  firstTextBlock,
  mapAgentLine,
  parseJson,
  parseTimestamp,
  toolTarget,
};
