'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildStagePrompt, writePromptFile } = require('../teamlib/team-prompt');

test('buildStagePrompt embeds agent text and every run-context path', () => {
  const runDir = 'C:/proj/.glissa/teams/marketing/runs/2026-06-02-tuesday';
  const packDir = 'C:/proj/.glissa/teams/marketing/pack';
  const ctx = {
    runDir,
    packDir,
    packFiles: [
      { name: 'voice-guide.md', path: `${packDir}/voice-guide.md` },
      { name: 'brand.md', path: `${packDir}/brand.md` },
    ],
    reads: [
      { name: 'brief.md', path: `${runDir}/brief.md` },
      { name: 'plan.md', path: `${runDir}/plan.md` },
    ],
    produces: { name: 'drafts.md', path: `${runDir}/drafts.md` },
  };
  const prompt = buildStagePrompt('# Writer\nYou write copy.', ctx);

  assert.ok(prompt.includes('# Writer'), 'includes agent markdown');
  assert.ok(prompt.includes(ctx.runDir), 'includes run dir');
  assert.ok(prompt.includes(ctx.packDir), 'includes pack dir');
  for (const f of ctx.packFiles) {
    assert.ok(prompt.includes(f.path), `includes pack file ${f.name}`);
  }
  for (const r of ctx.reads) {
    assert.ok(prompt.includes(r.path), `includes read path ${r.name}`);
  }
  assert.ok(prompt.includes(ctx.produces.path), 'includes produces path');
  assert.ok(/RUN CONTEXT/.test(prompt), 'has a RUN CONTEXT section');
  assert.ok(/write your output/i.test(prompt), 'instructs writing the output');
});

test('buildStagePrompt tolerates a first stage with no reads', () => {
  const prompt = buildStagePrompt('# Researcher', {
    runDir: '/p/runs/x',
    packDir: '/p/pack',
    produces: { name: 'brief.md', path: '/p/runs/x/brief.md' },
  });
  assert.ok(prompt.includes('/p/runs/x/brief.md'));
  assert.ok(!/Read these inputs first/.test(prompt));
});

test('buildStagePrompt injects the operator conversation read + honor instruction when chat is provided', () => {
  const runDir = '/p/runs/x';
  const prompt = buildStagePrompt('# Writer', {
    runDir,
    packDir: '/p/pack',
    produces: { name: 'drafts.md', path: `${runDir}/drafts.md` },
    chat: { name: 'chat.md', path: `${runDir}/chat.md` },
  });
  assert.ok(prompt.includes(`${runDir}/chat.md`), 'includes the chat path');
  assert.ok(/operator conversation/i.test(prompt), 'labels it the operator conversation');
  assert.ok(/operator wins/i.test(prompt), 'tells the agent the operator wins on conflict');
});

test('buildStagePrompt omits the conversation block when chat is null', () => {
  const prompt = buildStagePrompt('# Writer', {
    runDir: '/p/runs/x',
    packDir: '/p/pack',
    produces: { name: 'drafts.md', path: '/p/runs/x/drafts.md' },
  });
  assert.ok(!/operator conversation/i.test(prompt));
});

test('buildStagePrompt appends the QUESTION protocol only when allowQuestions is true', () => {
  const ctx = {
    runDir: '/p/runs/x',
    packDir: '/p/pack',
    produces: { name: 'drafts.md', path: '/p/runs/x/drafts.md' },
  };
  const off = buildStagePrompt('# Writer', ctx);
  assert.ok(!/QUESTION:/.test(off), 'no protocol by default in this call');
  const on = buildStagePrompt('# Writer', { ...ctx, allowQuestions: true });
  assert.ok(/QUESTION:/.test(on), 'protocol present when allowQuestions is true');
  assert.ok(/do not guess/i.test(on), 'tells the agent not to guess');
  // The produces line must stay parseable by the orchestrator stage fake regardless of the additions.
  assert.match(on, /Write your single output file to: (.+)/);
});

test('writePromptFile writes the exact content and returns a path under dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-prompt-'));
  try {
    const content = '# Researcher\nPick a topic.\n## RUN CONTEXT\n- Run folder: X';
    const file = writePromptFile(dir, content);
    assert.ok(fs.existsSync(file), 'file created');
    assert.equal(fs.readFileSync(file, 'utf8'), content);
    assert.ok(path.resolve(file).startsWith(path.resolve(dir)), 'path under dir');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
