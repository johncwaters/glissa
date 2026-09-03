
import fs from 'node:fs';
import path from 'node:path';

import type { HookRouter } from '../detection/hook-source.ts';
import { Session } from '../session/sessions.ts';
import type { SessionOptions } from '../session/sessions.ts';
import { glissaHomeDir } from './config-store.ts';
import { millPackNames } from './core/pack-core.ts';
import {
  awaitSessionExit, createJobResultFile, readResultFile, registerEphemeralSession,
} from './ephemeral-session.ts';
import type { JobResultFile, RecordLane, ResultFileOutcome, SpawnGate } from './ephemeral-session.ts';
import { createLaneRunner } from './lane-runner.ts';
import type { LaneRunnerGate, LaneStatusRecord } from './lane-runner.ts';
import { emptyLaneStatus } from './lane-status.ts';
import { writeJsonAtomic } from './json-file.ts';
import { createPrGh } from './pr-gh.ts';
import { createPrPoller } from './pr-poller.ts';
import type { PrGitWorkspace, PrState, SpawnReviewArgs } from './pr-poller.ts';
import { sendPrPing } from './pr-telegram.ts';

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

interface PrReviewWiringConfig {
  replayBufferKB?: number;
  worktreeRoot?: string;
  millEnabled?: unknown;
  prReview?: {
    enabled?: boolean;
    packs?: unknown;
    projects?: string[];
    intervalMinutes?: number;
    mergeMethod?: string;
    maxConcurrentReviews?: number;
    reviewTimeoutSeconds?: number;
  } | null;
  telegram?: { botToken?: string; chatId?: string } | null;
}

interface PrReviewWiringOptions {
  config: PrReviewWiringConfig;
  reviewSessions: Map<string, unknown>;
  closeSessionDataClients: (id: string) => void;
  hookRouter: Pick<HookRouter, 'register' | 'unregister'> | null;
  getHookPort: (() => number | null) | null;
  spawnGate: SpawnGate;
  gitWorkspace: PrGitWorkspace;
  getProjectPathById: (projectId: string) => string | null;
  getProjectNameById?: (projectId: string) => string | null;
  broadcast?: (message: LaneStatusRecord) => void;
  recordLane?: RecordLane | null;
  makeSession?: (options: SessionOptions) => Session;
}

function buildReviewPrompt(
  { slug, number, baseRefName, conflicting, resultPath }: {
    slug: string;
    number: number;
    baseRefName?: string | null;
    conflicting?: boolean;
    resultPath: string;
  },
): string {
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

function readReviewResult(resultPath: string): ResultFileOutcome {
  return readResultFile(resultPath, REVIEW_VERDICTS);
}

function prPollerShouldStart(cfg: PrReviewWiringConfig): LaneRunnerGate {
  if (!cfg.prReview || !cfg.prReview.enabled) return { start: false, reason: null };
  const t = cfg.telegram;
  if (!t || !t.botToken || !t.chatId) {
    return { start: false, reason: 'prReview.enabled but telegram botToken/chatId missing' };
  }
  return { start: true, reason: null };
}

function prReviewCfgKey(cfg: PrReviewWiringConfig): string {
  return JSON.stringify({ prReview: cfg.prReview || null, telegram: cfg.telegram || null });
}

function prReviewPackNames(cfg: PrReviewWiringConfig): string[] {
  return millPackNames(cfg, cfg.prReview ? cfg.prReview.packs : null);
}

function createPrReviewWiring({
  config, reviewSessions, closeSessionDataClients, hookRouter, getHookPort, spawnGate, gitWorkspace,
  getProjectPathById, getProjectNameById = () => null,
  broadcast = () => {},
  recordLane = null,
  makeSession = (options: SessionOptions) => new Session(options),
}: PrReviewWiringOptions) {
  function makeReviewSession(
    { id, name, path: cwd, initialPrompt }: { id: string; name: string; path: string; initialPrompt: string },
  ): Session {
    const sess = makeSession({
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

  async function prReviewSpawn({ cwd, pr, slug, conflicting, signal }: SpawnReviewArgs) {
    const safeSlug = String(slug).replace(/[^\w.-]+/g, '-');
    let resultFile: JobResultFile | null = null;
    try {
      resultFile = await createJobResultFile(`glissa-pr-${safeSlug}-${pr.number}-${pr.headRefOid}`);
      const prompt = buildReviewPrompt({
        slug, number: pr.number, baseRefName: pr.baseRefName, conflicting, resultPath: resultFile.path,
      });
      const id = `pr-review:${slug}#${pr.number}`;
      const sess = makeReviewSession({ id, name: `PR review ${slug}#${pr.number}`, path: cwd, initialPrompt: prompt });
      await awaitSessionExit(sess, { signal, spawnGate });
      return readReviewResult(resultFile.path);
    } catch (e) {
      const failure = (e ?? {}) as { message?: unknown };
      return { verdict: 'ERROR', summary: String(failure.message || e) };
    } finally {
      if (resultFile) await resultFile.cleanup();
    }
  }

  const prStatePath = path.join(glissaHomeDir(), 'pr-review-state.json');
  async function readPrState(): Promise<PrState> {
    try { return JSON.parse(fs.readFileSync(prStatePath, 'utf8')); }
    catch { return {}; }
  }
  async function writePrState(state: PrState): Promise<void> {
    await writeJsonAtomic(prStatePath, state, { mkdir: true });
  }

  const runner = createLaneRunner({
    tag: 'pr-poller',
    gate: () => {
      const verdict = prPollerShouldStart(config);
      if (verdict.reason) return verdict;
      return { start: verdict.start };
    },
    cfgKey: () => prReviewCfgKey(config),
    emptyStatus: () => emptyLaneStatus('pr-status', prPollerShouldStart(config)),
    broadcast,
    createPoller: ({ onTickComplete }) => {
      const prReviewConfig = config.prReview;
      const telegramConfig = config.telegram;
      if (!prReviewConfig || !telegramConfig?.botToken || !telegramConfig.chatId) {
        throw new Error('PR review poller started without its required configuration');
      }
      const botToken = telegramConfig.botToken;
      const chatId = telegramConfig.chatId;
      return createPrPoller({
        projects: prReviewConfig.projects || [],
        getProjectPathById,
        getProjectNameById,
        makePrGh: (projectPath: string) => createPrGh(projectPath),
        gitWorkspace,
        getWorktreeBase: (projectPath: string) => config.worktreeRoot
          || path.join(path.dirname(path.resolve(projectPath)), '.glissa-worktrees'),
        spawnReview: prReviewSpawn,
        telegram: (text: string) => { void sendPrPing(botToken, chatId, text); },
        readState: readPrState,
        writeState: writePrState,
        intervalMinutes: prReviewConfig.intervalMinutes || 15,
        mergeMethod: prReviewConfig.mergeMethod || 'rebase',
        maxConcurrentReviews: prReviewConfig.maxConcurrentReviews || 3,
        reviewTimeoutSeconds: prReviewConfig.reviewTimeoutSeconds || 900,
        onTickComplete,
      });
    },
  });

  return {
    startPoller: runner.startPoller,
    restartIfConfigChanged: runner.restartIfConfigChanged,
    stopPoller: runner.stopPoller,
    getStatus: runner.getStatus,
    _makeReviewSession: makeReviewSession,
  };
}

export {
  buildReviewPrompt,
  createPrReviewWiring,
  prPollerShouldStart,
  prReviewCfgKey,
  prReviewPackNames,
  readReviewResult,
};
export type { PrReviewWiringConfig, PrReviewWiringOptions };
