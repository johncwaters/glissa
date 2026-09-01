'use strict';

// M5 acceptance: a SUPERVISED codex card shows its own token/cost chip from its own Codex transcript.
// The join is the same one a Claude card uses (the card's captured session id, which is its
// resumeSessionId), so nothing in usage-wiring is vendor-branched: the scanner keys a codex session by
// its own id, and the card carries that id.
//
// SAFETY: the scanner reads transcripts, so it is pointed at a throwaway CODEX_HOME (and empty CLAUDE /
// GROK homes) through an explicit env passed to scannerDeps. It never touches process.env or the
// operator's real ~/.codex. isolateTranscriptHomes is applied to process.env too, belt and suspenders.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createUsageWiring } = require('../server/usage-wiring.ts');
const { createUsageScanner } = require('../server/usage-scanner.ts');
const { loadPricing } = require('../server/usage-pricing.ts');
const { isolateTranscriptHomes } = require('./helpers/transcript-homes.ts');

const CODEX_SESSION_ID = '019f43ea-76ac-7041-bd4b-6362e85f6630';
const CARD_ID = 'b0000000-0000-4000-8000-0000000000c0';
const MODEL = 'gpt-5.5';

// The real Codex rollout shape: a turn_context line names the model, a token_count line reports the
// CUMULATIVE usage. codexSessionIdFromPath reads the id out of the rollout filename.
function writeCodexFixture(codexHome, { input, output }) {
  const dir = path.join(codexHome, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ timestamp: '2026-08-20T10:00:00.000Z', type: 'turn_context', payload: { turn_id: 't1', model: MODEL, cwd: 'C:/repo' } }),
    JSON.stringify({
      timestamp: '2026-08-20T10:00:05.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: output, total_tokens: input + output },
          model_context_window: 258400,
        },
      },
    }),
  ];
  fs.writeFileSync(path.join(dir, `rollout-${CODEX_SESSION_ID}.jsonl`), `${lines.join('\n')}\n`);
}

test('a supervised codex card shows its own token/cost chip from the Codex transcript', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-codex-chip-'));
  const restoreEnv = isolateTranscriptHomes(root);
  try {
    const homes = path.join(root, 'vendor-homes');
    const codexHome = path.join(homes, 'codex_home');
    const emptyHome = path.join(homes, 'empty');
    fs.mkdirSync(emptyHome, { recursive: true });
    writeCodexFixture(codexHome, { input: 2000, output: 200 });

    // The card is only ever read for ephemeral + resumeSessionId, but it is shaped like a real codex
    // Session so the test states what it stands for.
    const codexCard = { ephemeral: false, resumeSessionId: CODEX_SESSION_ID, agentId: 'codex', usageVendor: 'codex' };
    const sessions = new Map([[CARD_ID, codexCard]]);

    const broadcasts = [];
    const usage = createUsageWiring({
      config: {},
      sessions,
      broadcast: (msg) => broadcasts.push(msg),
      loadPricingFn: (args) => loadPricing({ ...args, fetchEnabled: false }),
      createScanner: createUsageScanner,
      // Explicit env: the scanner never reads process.env, so the real ~/.codex is unreachable. CODEX_HOME
      // points at the fixture; the claude and grok homes are empty, so no other vendor contributes.
      scannerDeps: { env: { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: emptyHome, GROK_HOME: emptyHome, HOME: emptyHome, USERPROFILE: emptyHome } },
      logger: { warn: () => {} },
    });

    await usage.start();

    const message = usage.getSessionsMessage();
    assert.ok(message, 'a usage-sessions message was produced');
    const row = message.sessions.find((r) => r.id === CARD_ID);
    assert.ok(row, 'the codex card has a usage row');
    assert.equal(row.tokens, 2200, 'the codex transcript tokens are attributed to the card (2000 + 200)');
    assert.ok(row.costUSD > 0, 'priced from the committed snapshot (gpt-5.5 is in it)');
    // No statusLine for codex, so the official-cost figure is absent and the chip shows the estimate.
    assert.equal(row.officialCostUSD, null);

    await usage.stop();
  } finally {
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
