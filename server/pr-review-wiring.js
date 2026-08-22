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
const { registerEphemeralSession } = require('./ephemeral-session');
const { normalizePackNames } = require('./core/pack-core');
const { createPrPoller } = require('./pr-poller');
const { createPrGh } = require('./pr-gh');
const { sendPrPing } = require('./pr-telegram');
const { emptyLaneStatus } = require('./lane-status');

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
    `- Before posting, check for a previous comment carrying that marker (\`gh pr view ${number} --json comments\`). If one exists, open with a delta line: "Reviewed <short head sha>. Resolved since last review: N. Still open: M." and report only still-open and new findings.`,
    '- Then a header line: "Findings: N blocking, M non-blocking." followed by a 1-2 sentence plain-language summary of the common theme.',
    '- Group findings under "### Blocking" and "### Non-blocking" headings; omit a heading that has no findings.',
    `- Number each finding. Start it with a bold one-line title stating the problem in plain words plus an inline-code \`path:line\`; on the next line, alone, a permalink \`https://github.com/${slug}/blob/<full head sha>/<path>#L<start>-L<end>\` so GitHub renders a clickable snippet.`,
    '- Each finding has three parts, in order: the problem (at most 2 short sentences), why it matters (one sentence naming the concrete consequence), and a "Fix:" line giving the specific change.',
    '- Report only findings that affect behavior, correctness, security, performance, or data. Skip style and formatting nitpicks entirely; a nitpick comment trains the reader to ignore the bot.',
    '- Merge repeats of the same defect across files into ONE finding listing all locations. Show at most 10 findings; fold any beyond that into a single <details> block titled "N additional lower-severity findings".',
    '- Move long call-chain walkthroughs or multi-file evidence into a <details><summary>Details</summary>...</details> block so the main comment stays skimmable.',
    '- End with a <details><summary>Prompt for AI agents</summary>...</details> block containing verbatim, self-contained fix instructions for every finding, ready to paste into a coding agent.',
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

// Read the verdict a review session wrote to its result file. Missing/invalid file -> ERROR, so a
// crashed or confused session never masquerades as a clean pass.
function readReviewResult(resultPath) {
  const allowed = new Set(['CLEAN', 'RESOLVED', 'CHANGES', 'ERROR']);
  try {
    const obj = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const verdict = String(obj.verdict || '').toUpperCase();
    if (!allowed.has(verdict)) return { verdict: 'ERROR', summary: 'invalid verdict in result file' };
    return { verdict, summary: String(obj.summary || '') };
  } catch {
    return { verdict: 'ERROR', summary: 'no result file' };
  }
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

    let onAbort = null;
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const done = () => { if (settled) return; settled = true; resolve(); };
        const fail = (e) => { if (settled) return; settled = true; reject(e); };
        sess.on('exit', done);
        sess.on('error', fail);
        if (signal) {
          onAbort = () => { try { sess.destroy(); } catch { /* already gone */ } done(); };
          if (signal.aborted) onAbort();
          if (!signal.aborted) signal.addEventListener('abort', onAbort, { once: true });
        }
        spawnGate.run(() => (signal?.aborted ? undefined : sess.start())).catch(fail);
      });
      return readReviewResult(resultPath);
    } catch (e) {
      return { verdict: 'ERROR', summary: String(e.message || e) };
    } finally {
      if (signal && onAbort) { try { signal.removeEventListener('abort', onAbort); } catch { /* noop */ } }
      try { fs.rmSync(resultPath, { force: true }); } catch { /* best-effort */ }
    }
  }

  // State lives in one cross-project file under the user config dir, written atomically (tmp+rename).
  const prStatePath = path.join(os.homedir(), '.glissa', 'pr-review-state.json');
  async function readPrState() {
    try { return JSON.parse(fs.readFileSync(prStatePath, 'utf8')); }
    catch { return {}; }
  }
  async function writePrState(state) {
    try { fs.mkdirSync(path.dirname(prStatePath), { recursive: true }); } catch { /* exists */ }
    const tmp = `${prStatePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, prStatePath);
  }

  // Started at boot and re-evaluated on every settings reload whose prReview/telegram key changed
  // (restartIfConfigChanged, gated by prReviewCfgKey), so toggling config.prReview / config.telegram
  // via the Settings dialog or a config.json hand-edit hot-applies without a server restart.
  //
  // Restarts are serialized through prPollerChain so a stop-drain-start never overlaps a prior one: the
  // old instance's in-flight reviews (up to reviewTimeoutSeconds) and pending state writes finish before
  // a new instance reuses the same result-file paths, gitWorkspace, and state file. A settings save that
  // lands mid-drain just queues another restart on the chain; that coalesces naturally. startPoller
  // itself stays synchronous from its callers' perspective (it only appends to the chain).
  // The last tick summary, replayed to a control client that connects between ticks (the same
  // cached-snapshot pattern the PostHog lane and the startup update check use).
  let lastStatus = null;
  const emptyPrStatus = () => emptyLaneStatus('pr-status', prPollerShouldStart(config));
  const getStatus = () => lastStatus || emptyPrStatus();

  let prPoller = null;
  let prPollerChain = Promise.resolve();
  let prPollerStopped = false;
  let prReviewLastKey = null;
  function startPoller() {
    prReviewLastKey = prReviewCfgKey(config);
    prPollerChain = prPollerChain.then(async () => {
      if (prPollerStopped) return;
      if (prPoller) {
        const old = prPoller;
        prPoller = null;
        await old.stop();
      }
      const gate = prPollerShouldStart(config);
      if (!gate.start) {
        lastStatus = null;
        broadcast(emptyPrStatus());
        if (gate.reason) console.warn(`[pr-poller] not starting: ${gate.reason}`);
        return;
      }
      if (!lastStatus) broadcast(emptyPrStatus());
      prPoller = createPrPoller({
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
        onTickComplete: (summary) => {
          lastStatus = { ...summary, configured: true };
          broadcast(lastStatus);
        },
      });
      await prPoller.start().catch((e) => console.warn(`[pr-poller] start failed: ${e.message}`));
    }).catch((e) => console.warn(`[pr-poller] restart failed: ${e.message}`));
  }

  // The poller closure captures config.prReview/telegram at creation time, so a restart (stop+start,
  // gated by prPollerShouldStart) is how a config change actually takes effect. Only restart when the
  // prReview/telegram key actually changed: an unrelated settings save (cursorBlink, etc.) must never
  // interrupt a review that may be in flight (see prReviewCfgKey / prReviewLastKey above).
  function restartIfConfigChanged() {
    if (prReviewCfgKey(config) !== prReviewLastKey) startPoller();
  }

  // Blocks a restart still queued on prPollerChain (e.g. a settings save that raced shutdown) from
  // starting a fresh poller after the process has begun tearing down. stop() is async, but fire-and-
  // forget here is deliberate: the process is exiting, nothing awaits it.
  function stopPoller() {
    prPollerStopped = true;
    if (prPoller) prPoller.stop();
  }

  // Exposed for tests only (the pack-service `_watcherCount` precedent): the session factory is the
  // one place the lane's Session options are assembled, and pinning them needs no live poller.
  return { startPoller, restartIfConfigChanged, stopPoller, getStatus, _makeReviewSession: makeReviewSession };
}

module.exports = {
  createPrReviewWiring,
  buildReviewPrompt,
  readReviewResult,
  prPollerShouldStart,
  prReviewCfgKey,
  prReviewPackNames,
};
