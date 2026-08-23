/*
 * GitHub PR auto-review wiring - the IO shell that binds server/pr-poller.js (IO-free) to real
 * Sessions, gh/git, Telegram, and the on-disk state file.
 *
 * createBackend calls createPrReviewWiring once with its live locals; it returns the three verbs
 * the backend needs (start the poller at boot, restart it when the prReview/telegram config
 * actually changed, stop it on shutdown). The pure pieces at the top (prompt builder, result
 * reader, start gate, config key) are exported directly for unit tests.
 *
 * The lane is opt-in and inert unless config.prReview.enabled AND config.telegram are both set;
 * see AGENTS.md, "GitHub PR Auto-Review".
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Session } = require('../session/sessions');
const { awaitSessionExit, readResultFile, registerEphemeralSession } = require('./ephemeral-session');
const { normalizePackNames } = require('./core/pack-core');
const { createPrPoller } = require('./pr-poller');
const { createPrGh } = require('./pr-gh');
const { sendPrPing } = require('./pr-telegram');
const { emptyLaneStatus } = require('./lane-status');
const { createLaneRunner } = require('./lane-runner');
const { writeJsonAtomic } = require('./json-file');
const { glissaHomeDir } = require('./config-store');

// Belt-and-suspenders deny-list for the headless PR-review sessions (they run under
// --dangerously-skip-permissions, so this is a guard, not the guard). Blocks the destructive/
// outward verbs the reviewer must never take: the poller merges (never the agent), and workflow
// files are never edited or merged automatically.
const PR_REVIEW_DENY = {
  deny: [
    'Bash(gh pr merge:*)',
    'Bash(gh pr close:*)',
    'Bash(gh repo delete:*)',
    'Bash(git push --force:*)',
    'Bash(git push -f:*)',
    'Bash(git push --force-with-lease:*)',
    'Edit(.github/workflows/**)',
    'Write(.github/workflows/**)',
  ],
};

// The seed prompt for one headless PR review. Pure string building (unit-coverable via the poller's
// integration path). The verdict travels back through a result FILE, not stdout, mirroring the teams
// file-handoff convention. Self-review via `gh pr review` is impossible on your own PR, so findings go
// out as a `gh pr comment`; the poller (never the agent) merges once checks are green.
function buildReviewPrompt({ slug, number, baseRefName, conflicting, resultPath }) {
  const base = baseRefName || 'the base branch';
  const lines = [
    `You are an automated reviewer for ${slug}, a repository the operator owns. Review pull request #${number} (base branch: ${base}).`,
    '',
    'Hard rules:',
    '- Do NOT run `gh pr merge`. A separate process merges after checks pass.',
    '- Do NOT use `gh pr review` (approving/requesting-changes on your own PR is rejected by GitHub). Post findings with `gh pr comment`.',
    '- Never force-push, never delete branches or the repo, never touch other PRs, never edit files under .github/workflows/.',
    '',
    'Comment format (the reader is a busy human, often on a phone; optimize for skimming):',
    '- The first line of the comment body is the literal marker `<!-- glissa-pr-review -->` (invisible when rendered; it lets later runs find this comment).',
    '- The second line is exactly: "*Automated review (glissa). A separate gated process merges; no human wrote this.*" so nobody mistakes it for a human review.',
    `- Before posting, check for a previous comment carrying that marker (\`gh pr view ${number} --json comments\`). If one exists, open with a delta line: "Reviewed <short head sha>. Resolved since last review: N. Still open: M." and report only still-open and new findings.`,
    '- On a re-review with 0 resolved, 0 still-open, and 0 new findings, post NO comment at all; just write the verdict. A re-review that resolves prior findings and finds nothing new posts only the delta line, the findings line, and one sentence of verification evidence.',
    '- Then a header line: "Findings: N blocking, M non-blocking." Add a summary sentence only when a common theme is worth naming. Never praise, never describe what is fine; state only what needs to change.',
    '- Group findings under "### Blocking" and "### Non-blocking" headings; omit a heading that has no findings.',
    `- Number each finding. Start it with a bold one-line title stating the problem in plain words plus an inline-code \`path:line\`; on the next line, alone, a permalink \`https://github.com/${slug}/blob/<full head sha>/<path>#L<start>-L<end>\` so GitHub renders a clickable snippet.`,
    '- Each finding has three parts, in order: the problem (at most 2 short sentences, a hard cap; overflow goes to a Details block), why it matters (one sentence naming the concrete consequence), and a "Fix:" line giving the specific change.',
    '- Report only findings that affect behavior, correctness, security, performance, or data. Skip style and formatting nitpicks entirely; a nitpick comment trains the reader to ignore the bot.',
    '- Merge repeats of the same defect across files into ONE finding listing all locations. Show at most 10 findings; fold any beyond that into a single <details> block titled "N additional lower-severity findings".',
    '- Move long call-chain walkthroughs or multi-file evidence into a <details><summary>Details</summary>...</details> block so the main comment stays skimmable.',
    '- When there is at least one finding, end with a <details><summary>Prompt for AI agents</summary>...</details> block: per finding, only the file, the exact change, and the test to add or update. Do not re-explain the mechanism (the finding above carries it) and do not restate repo conventions or test commands (the fixing agent reads AGENTS.md itself). Omit the block entirely when there are no findings.',
    '- No emoji. Prefer short sentences and blank lines over dense prose; never write a paragraph longer than 3 sentences.',
    '',
    'Steps:',
    `1. Inspect: \`gh pr view ${number} --json mergeable,mergeStateStatus,files\`.`,
    `2. If any changed file is under .github/workflows/: post a \`gh pr comment ${number}\` saying a human must review and merge workflow changes, write verdict CHANGES, and stop.`,
  ];
  if (conflicting) {
    lines.push(
      `3. This PR has conflicts and you are in an ISOLATED worktree. Run \`gh pr checkout ${number}\`, rebase onto \`origin/${base}\` (\`git rebase origin/${base}\`), resolve every conflict faithfully to the intent of BOTH sides, commit, and \`git push\`. If you cannot resolve confidently, write verdict ERROR with the reason and stop. Never push a guessed resolution.`,
    );
  }
  lines.push(
    `${conflicting ? 4 : 3}. Review the diff (\`gh pr diff ${number}\`) against the repo conventions (read CLAUDE.md / AGENTS.md if present).`,
    '   - If it needs changes: post the findings as a `gh pr comment` following the comment format above and write verdict CHANGES.',
    '   - If it was conflicting and you resolved+pushed and it is otherwise clean: write verdict RESOLVED.',
    '   - If clean with no conflict: write verdict CLEAN.',
    `${conflicting ? 5 : 4}. Write the result as JSON to ${resultPath}: {"verdict":"CLEAN|RESOLVED|CHANGES|ERROR","head":"<current head sha>","summary":"<one line>"}.`,
  );
  return lines.join('\n');
}

const REVIEW_VERDICTS = new Set(['CLEAN', 'RESOLVED', 'CHANGES', 'ERROR']);

function readReviewResult(resultPath) {
  return readResultFile(resultPath, REVIEW_VERDICTS);
}

// Pure gate for the opt-in poller: start only when enabled AND telegram is configured (pings must be
// deliverable). A plain "disabled" reports no reason (silent); a misconfiguration reports one (warned).
function prPollerShouldStart(cfg) {
  if (!cfg.prReview || !cfg.prReview.enabled) return { start: false, reason: null };
  const t = cfg.telegram;
  if (!t || !t.botToken || !t.chatId) {
    return { start: false, reason: 'prReview.enabled but telegram botToken/chatId missing' };
  }
  return { start: true, reason: null };
}

// Identity of the poller-relevant config, recomputed on every settings reload and compared against the
// key recorded at the last startPoller() invocation. A settings save that touches neither prReview
// nor telegram (cursorBlink, etc.) must never restart a poller that may have a review in flight.
function prReviewCfgKey(cfg) {
  return JSON.stringify({ prReview: cfg.prReview || null, telegram: cfg.telegram || null });
}

// Context packs this lane delivers to its review sessions (config.prReview.packs). A review session is
// exactly the consumer packs were built for: the company-context pack carries the review checklist. The
// list is normalized the same defensive way a project's is, so a hand-edited entry costs that entry and
// never the review. Absent key means an empty list, i.e. a spawn identical to before packs existed.
function prReviewPackNames(cfg) {
  return normalizePackNames(cfg.prReview ? cfg.prReview.packs : null).names;
}

function createPrReviewWiring({
  config, reviewSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate, gitWorkspace,
  getProjectPathById, getProjectNameById = () => null, broadcast = () => {},
  // Lane attribution: names this lane on the ledger when its headless session reports a Claude session id.
  recordLane = null,
}) {
  // Build one headless (claude -p) PR-review session, registered in reviewSessions and auto-removed on
  // exit. Mirrors makeStageSession; not surfaced as a card (a -p session has no watchable TUI).
  function makeReviewSession({ id, name, path: cwd, initialPrompt }) {
    const sess = new Session({
      id,
      name,
      path: cwd,
      dangerouslySkipPermissions: true,
      extraClaudeArgs: ['-p'],
      initialPrompt,
      ephemeral: true,
      settingsPermissions: PR_REVIEW_DENY,
      packs: prReviewPackNames(config),
      replayBufferKB: config.replayBufferKB,
      hookRouter,
      getHookPort,
    });
    registerEphemeralSession({ map: reviewSessions, id, sess, closeSessionDataClients, logPrefix: 'pr-review', name, recordLane });
    return sess;
  }

  // The real spawnReview the poller injects: seed a headless review, run it through the spawn gate,
  // and resolve the file-borne verdict on exit. Honors an AbortSignal (the poller's hard timeout) by
  // destroying the session; the poller has already resolved ERROR in that case, so the returned value
  // is ignored. Never rejects: any failure resolves to an ERROR verdict.
  async function prReviewSpawn({ cwd, pr, slug, conflicting, signal }) {
    const safeSlug = String(slug).replace(/[^\w.-]+/g, '-');
    const resultPath = path.join(os.tmpdir(), `glissa-pr-${safeSlug}-${pr.number}-${process.pid}-${pr.headRefOid}.json`);
    try { fs.rmSync(resultPath, { force: true }); } catch { /* fresh file */ }
    const prompt = buildReviewPrompt({
      slug, number: pr.number, baseRefName: pr.baseRefName, conflicting, resultPath,
    });
    const id = `pr-review:${slug}#${pr.number}`;
    const sess = makeReviewSession({ id, name: `PR review ${slug}#${pr.number}`, path: cwd, initialPrompt: prompt });

    try {
      await awaitSessionExit(sess, { signal, spawnGate });
      return readReviewResult(resultPath);
    } catch (e) {
      return { verdict: 'ERROR', summary: String(e.message || e) };
    } finally {
      try { fs.rmSync(resultPath, { force: true }); } catch { /* best-effort */ }
    }
  }

  // State lives in one cross-project file under the user config dir, written atomically (tmp+rename).
  const prStatePath = path.join(glissaHomeDir(), 'pr-review-state.json');
  async function readPrState() {
    try { return JSON.parse(fs.readFileSync(prStatePath, 'utf8')); }
    catch { return {}; }
  }
  // ASYNC on purpose: this is a recurring path (every tick that changes a PR's phase), and all
  // sessions share one event loop, so a synchronous whole-file write here stalls hook replies, PTY
  // streaming and control traffic for its duration. Serialization is the tick loop's persist chain
  // (server/lane-runner.js), which already awaits this, so ordering is unchanged.
  async function writePrState(state) {
    await writeJsonAtomic(prStatePath, state, { mkdir: true });
  }

  // Started at boot and re-evaluated on every settings reload whose prReview/telegram key changed
  // (restartIfConfigChanged, gated by prReviewCfgKey), so toggling config.prReview / config.telegram
  // via the Settings dialog or a config.json hand-edit hot-applies without a server restart. The
  // restart serialization and the cached last status live in server/lane-runner.js.
  const runner = createLaneRunner({
    tag: 'pr-poller',
    gate: () => prPollerShouldStart(config),
    cfgKey: () => prReviewCfgKey(config),
    emptyStatus: () => emptyLaneStatus('pr-status', prPollerShouldStart(config)),
    broadcast,
    createPoller: ({ onTickComplete }) => createPrPoller({
      projects: config.prReview.projects || [],
      getProjectPathById,
      getProjectNameById,
      makePrGh: (projectPath) => createPrGh(projectPath),
      gitWorkspace,
      getWorktreeBase: (projectPath) => config.worktreeRoot
        || path.join(path.dirname(path.resolve(projectPath)), '.glissa-worktrees'),
      spawnReview: prReviewSpawn,
      telegram: (text) => sendPrPing(config.telegram.botToken, config.telegram.chatId, text),
      readState: readPrState,
      writeState: writePrState,
      intervalMinutes: config.prReview.intervalMinutes || 15,
      mergeMethod: config.prReview.mergeMethod || 'rebase',
      maxConcurrentReviews: config.prReview.maxConcurrentReviews || 3,
      reviewTimeoutSeconds: config.prReview.reviewTimeoutSeconds || 900,
      onTickComplete,
    }),
  });

  // Exposed for tests only (the pack-service `_watcherCount` precedent): the session factory is the
  // one place the lane's Session options are assembled, and pinning them needs no live poller.
  return {
    startPoller: runner.startPoller,
    restartIfConfigChanged: runner.restartIfConfigChanged,
    stopPoller: runner.stopPoller,
    getStatus: runner.getStatus,
    _makeReviewSession: makeReviewSession,
  };
}

module.exports = {
  createPrReviewWiring,
  buildReviewPrompt,
  readReviewResult,
  prPollerShouldStart,
  prReviewCfgKey,
  prReviewPackNames,
};
