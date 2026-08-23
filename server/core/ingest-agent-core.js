/*
 * Pure mapping from one line of a vendor's JSONL transcript to ingest events (docs/plan-ingestion.md,
 * M7). Summarizing happens HERE, at the edge: one event per COMPLETED assistant message or per tool
 * call, never one per token or per line of streaming, which is what keeps an agent session's chatter
 * from becoming the whole ring.
 *
 * It sits beside ingest-tail-core rather than inside it because that core is the shared tail machinery
 * the plan also hands to the shellHistory source, and vendor transcript shapes are not shared.
 *
 * Every mapper is a function of its line plus a context, returning the events plus the context values
 * the line revised, so the IO shell owns all the mutable state and this file owns none.
 */

'use strict';

const SOURCE = 'agentLogs';
// Absent from ingest-core's KINDS_BY_SOURCE on purpose, so no routing slip puts prompt text on the wire.
const PROMPT_KIND = 'agent-prompt';
/*
 * A MEMORY bound and nothing else (docs/plan-ingestion.md, M11). Summarizing is the ring's job:
 * `normalizeEvent` scrubs, THEN folds, THEN slices to 400, and a cut taken here would run ahead of the
 * scrub. That is how a quoted secret loses its closing quote, leaving the scrub's quoted alternative
 * unmatched and its bare-token alternative taking only the first WORD of the value, so the rest of it
 * publishes as innocent words. An agent tool target carries a `command`, so `Bash export TOKEN="..."`
 * leaks exactly the way the shell source's own pre-slice did.
 */
const MAX_RAW_CHARS = 4000;

// The first of these a tool's input carries becomes its bounded target, so `Read` reads as the file it
// opened rather than as a bare verb.
const TOOL_TARGET_KEYS = Object.freeze([
  'file_path', 'notebook_path', 'path', 'command', 'pattern', 'url', 'query', 'to', 'subagent_type',
  'description', 'prompt',
]);

/*
 * Second, independent layer of the feedback-loop exclusion. The ledger is primary, but it depends on a
 * hook callback having landed, so this covers the same transcripts by SHAPE: a visions dispatch runs
 * in a throwaway temp workdir (server/visions-dispatch.js makeWorkDir), and Claude names that
 * session's transcript directory after that cwd with every separator collapsed to one dash. Matching
 * the marker as a segment therefore catches both the raw cwd and the encoded directory name.
 */
const DISPATCH_WORKDIR_MARKER = 'glissa-visions';
const DISPATCH_WORKDIR_PATTERN = new RegExp(`(^|[\\\\/-])${DISPATCH_WORKDIR_MARKER}-`, 'i');

function isDispatchWorkdir(candidate) {
  if (typeof candidate !== 'string' || !candidate) return false;
  if (DISPATCH_WORKDIR_PATTERN.test(candidate)) return true;
  // Grok percent-encodes the cwd into its directory name, so the marker only appears once decoded.
  try {
    const decoded = decodeURIComponent(candidate);
    if (decoded === candidate) return false;
    return DISPATCH_WORKDIR_PATTERN.test(decoded);
  } catch {
    return false;
  }
}

function str(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}

/**
 * The one bound left on text heading for a ring, and it never folds. A scrub value pattern stops at a
 * line break by construction, so a LINE-ALIGNED cut is the one cut that cannot split a value; the
 * character cut below it is the fallback for a single line longer than the whole bound, and it is the
 * known limit this source accepts (docs/plan-ingestion.md, "Privacy and trust posture").
 *
 * BOTH break characters count. A vendor writing bare carriage returns would otherwise fall straight to
 * the character cut, and a CRLF cut on the newline alone would leave the carriage return dangling.
 */
function boundRaw(value, max = MAX_RAW_CHARS) {
  const text = String(value == null ? '' : value);
  if (text.length <= max) return text;
  const lastBreak = Math.max(text.lastIndexOf('\n', max), text.lastIndexOf('\r', max));
  if (lastBreak > 0) return text.slice(0, lastBreak).replace(/[\r\n]+$/, '');
  return text.slice(0, max);
}

// Grok stamps whole seconds; Claude and Codex ship ISO strings.
function parseTimestamp(value) {
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

function parseJson(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function toolTarget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  for (const key of TOOL_TARGET_KEYS) {
    const value = str(input[key]);
    if (!value) continue;
    return boundRaw(value);
  }
  return '';
}

// --- Events ---------------------------------------------------------------

function turnEvent({ ts, root, sessionId, vendor, text }) {
  // The M7 vendor prefix is composed here and bounded downstream: normalizeEvent's 400 covers the whole
  // composed line, prefix included.
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

function promptEvent({ ts, root, sessionId, vendor, text }) {
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

function toolEvent({ ts, root, sessionId, vendor, name, target }) {
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

function result(events, root, sessionId, vendorState) {
  return { events, root, sessionId, vendorState };
}

// --- Claude ---------------------------------------------------------------

// The visible text of an assistant message. Thinking blocks are deliberately skipped: they are long,
// they are not what the turn said, and the digest has one line to spend on this turn.
function firstTextBlock(content) {
  for (const block of content) {
    if (block?.type !== 'text') continue;
    const text = str(block.text);
    if (text) return text;
  }
  return null;
}

// A tool result and an isMeta reminder arrive on `user` lines too, and neither is anything a carbon unit typed.
function claudeUserText(line) {
  if (line.isMeta === true || line.isCompactSummary === true) return null;
  const content = line.message?.content;
  if (typeof content === 'string') return str(content);
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block?.type === 'tool_result') return null;
  }
  return firstTextBlock(content);
}

function mapClaudeUserLine(line, ctx) {
  const text = claudeUserText(line);
  if (!text) return null;
  const root = str(line.cwd) || ctx.root;
  const sessionId = str(line.sessionId) || ctx.sessionId;
  const prompt = promptEvent({
    ts: parseTimestamp(line.timestamp) || ctx.now, root, sessionId, vendor: 'claude', text,
  });
  return result(prompt ? [prompt] : [], root, sessionId, ctx.vendorState);
}

function mapClaudeLine(line, ctx) {
  if (line.type === 'user') return ctx.includeUserPrompts ? mapClaudeUserLine(line, ctx) : null;
  if (line.type !== 'assistant') return null;
  const content = line.message?.content;
  if (!Array.isArray(content)) return null;
  /*
   * The line carries its own cwd, which names the project root EXACTLY where reversing the transcript
   * directory's encoding could only guess (that encoding collapses every separator to one dash).
   */
  const root = str(line.cwd) || ctx.root;
  const sessionId = str(line.sessionId) || ctx.sessionId;
  const ts = parseTimestamp(line.timestamp) || ctx.now;
  const events = [];
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

// --- Codex ----------------------------------------------------------------

function mapCodexLine(line, ctx) {
  const payload = line.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const ts = parseTimestamp(line.timestamp) || ctx.now;
  // A rollout file is nested under date directories that name no project, so these two lines are where
  // the cwd for everything after them comes from.
  if (line.type === 'session_meta' || line.type === 'turn_context') {
    return result([], str(payload.cwd) || ctx.root, str(payload.session_id) || ctx.sessionId, ctx.vendorState);
  }
  const base = { ts, root: ctx.root, sessionId: ctx.sessionId, vendor: 'codex' };
  if (ctx.includeUserPrompts && line.type === 'event_msg' && payload.type === 'user_message') {
    const prompt = promptEvent({ ...base, text: payload.message });
    if (!prompt) return null;
    return result([prompt], ctx.root, ctx.sessionId, ctx.vendorState);
  }
  // agent_message is the completed message; the response_item/message stream beside it carries the raw
  // request items, including the whole system prompt.
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

// --- Grok -----------------------------------------------------------------

/*
 * Grok is the one vendor that writes its assistant text as streaming chunks, so the opening text is
 * held on the per-file vendor state and spent on the `turn_completed` line. Publishing per chunk is
 * exactly the per-token event the plan forbids.
 */
const PENDING_TURN_FIELD = 'pendingText';
const PENDING_PROMPT_FIELD = 'pendingUserText';

/*
 * The OPENING text is what the summary wants, so once there is enough of it the rest is not held. The
 * budget is applied to the INCOMING chunk rather than checked after it landed: one chunk is one
 * transcript line's text, and nothing bounds that below the tail's own catch-up read (256KB), so a
 * bound checked afterwards would overshoot by a whole one of those. boundRaw is what does the cutting,
 * so what it cuts is still line-aligned wherever the chunk holds a break.
 *
 * Returning only the named field is deliberate: spending one held stream drops the other, which is what
 * keeps a prompt and the turn that answered it from ever being concatenated.
 */
function appendChunk(vendorState, text, field) {
  const addition = str(text);
  const held = typeof vendorState?.[field] === 'string' ? vendorState[field] : '';
  if (!addition) return { [field]: held };
  const remaining = MAX_RAW_CHARS - held.length - 1;
  if (remaining <= 0) return { [field]: held };
  return { [field]: `${held} ${boundRaw(addition, remaining)}` };
}

/*
 * A turn that never completes (an abort, a rate-limit retry, a killed session) leaves its chunks held,
 * and without a boundary that stale text would surface as the NEXT turn's summary. A fresh user prompt
 * and a retry are both unambiguously the start of a different turn, so either drops what is held.
 */
const GROK_TURN_BOUNDARIES = Object.freeze(['user_message_chunk', 'retry_state']);

/*
 * The user-prompt half, kept OUT of the turn state machine below: nothing marks the end of a chunked user
 * message, so the first update that is not another user chunk spends what was held. The state it hands
 * back no longer carries the prompt, which is what makes the emit exactly once whatever kind follows.
 */
function takeGrokPrompt(vendorState, base) {
  const held = str(vendorState?.[PENDING_PROMPT_FIELD]);
  if (!held) return { events: [], vendorState };
  const prompt = promptEvent({ ...base, text: held });
  return {
    events: prompt ? [prompt] : [],
    vendorState: { [PENDING_TURN_FIELD]: str(vendorState?.[PENDING_TURN_FIELD]) || '' },
  };
}

function grokToolName(update) {
  const meta = update._meta && typeof update._meta === 'object' ? update._meta['x.ai/tool'] : null;
  return str(meta?.name) || str(update.title) || 'tool';
}

// The turn and tool state machine, unchanged by the prompt feature: it never reads or writes a held prompt.
function mapGrokTurn(kind, update, base, ctx) {
  if (GROK_TURN_BOUNDARIES.includes(kind)) return result([], ctx.root, ctx.sessionId, null);
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
  // tool_call is the call; tool_call_update is its streaming progress, and there are four of those per
  // call in a live transcript.
  if (kind === 'tool_call') {
    const target = toolTarget(update.rawInput);
    return result([toolEvent({ ...base, name: grokToolName(update), target })], ctx.root, ctx.sessionId, ctx.vendorState);
  }
  return null;
}

function mapGrokLine(line, ctx) {
  const update = line.params?.update;
  if (!update || typeof update !== 'object' || Array.isArray(update)) return null;
  const sessionId = str(line.params.sessionId) || ctx.sessionId;
  const ts = parseTimestamp(line.timestamp) || ctx.now;
  const base = { ts, root: ctx.root, sessionId, vendor: 'grok' };
  const kind = str(update.sessionUpdate);
  if (kind === 'user_message_chunk' && ctx.includeUserPrompts) {
    const next = appendChunk(ctx.vendorState, update.content?.text, PENDING_PROMPT_FIELD);
    return result([], ctx.root, sessionId, next);
  }
  const prompt = takeGrokPrompt(ctx.vendorState, base);
  const turn = mapGrokTurn(kind, update, base, {
    root: ctx.root, sessionId, vendorState: prompt.vendorState,
  });
  // A kind this mapper has no interest in still has to spend a held prompt, or the next kind would repeat it.
  if (!turn) {
    if (prompt.events.length === 0) return null;
    return result(prompt.events, ctx.root, sessionId, prompt.vendorState);
  }
  return result([...prompt.events, ...turn.events], turn.root, turn.sessionId, turn.vendorState);
}

// --- Dispatch -------------------------------------------------------------

const MAPPERS = Object.freeze({ claude: mapClaudeLine, codex: mapCodexLine, grok: mapGrokLine });

/**
 * One raw transcript line in, the events it produced plus the revised context out. An unparseable line,
 * an unknown vendor, and a line the vendor's mapper has no interest in all resolve to no events and an
 * unchanged context, so the shell never has to branch on any of those.
 */
function mapAgentLine({ vendor, rawLine, ctx = {}, vendorState = null, includeUserPrompts = false } = {}) {
  const root = ctx.root == null ? null : ctx.root;
  const sessionId = ctx.sessionId == null ? null : ctx.sessionId;
  const unchanged = result([], root, sessionId, vendorState);
  const mapper = MAPPERS[vendor];
  if (!mapper) return unchanged;
  const line = parseJson(rawLine);
  if (!line) return unchanged;
  const mapped = mapper(line, {
    root, sessionId, vendorState, includeUserPrompts: includeUserPrompts === true,
    now: Number.isFinite(ctx.now) ? ctx.now : 0,
  });
  if (!mapped) return unchanged;
  return mapped;
}

module.exports = {
  MAX_RAW_CHARS,
  PROMPT_KIND,
  isDispatchWorkdir,
  mapAgentLine,
  parseTimestamp,
  toolTarget,
};
