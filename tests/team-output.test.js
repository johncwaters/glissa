'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const out = require('../teamlib/team-output');

const OUT = '.glissa/teams/marketing';
const TEMPLATES = path.join(__dirname, '..', 'teams', 'marketing', 'pack-templates');
const REQUIRED = ['voice-guide.md', 'avoid-list.md', 'brand.md', 'content-calendar.md', 'channels.md'];

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-proj-'));
}

test('teamPaths roots everything under <project>/<outputPath> with a pack folder', () => {
  const proj = tmpProject();
  try {
    const p = out.teamPaths(proj, OUT);
    assert.equal(p.base, path.join(proj, OUT));
    assert.equal(p.packDir, path.join(proj, OUT, 'pack'));
    assert.equal(p.runsDir, path.join(proj, OUT, 'runs'));
    assert.equal(p.logPath, path.join(proj, OUT, 'log.md'));
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('ensureStructure creates runs + log only (no pack seeding)', () => {
  const proj = tmpProject();
  try {
    const r = out.ensureStructure(proj, OUT);
    assert.ok(fs.existsSync(r.runsDir), 'runs/');
    assert.ok(fs.existsSync(r.logPath), 'log.md');
    assert.ok(!fs.existsSync(r.packDir), 'pack is not seeded by ensureStructure');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('scaffoldPack copies the required templates + README and is idempotent', () => {
  const proj = tmpProject();
  try {
    const r1 = out.scaffoldPack(proj, OUT, TEMPLATES, REQUIRED);
    for (const name of REQUIRED) {
      assert.ok(fs.existsSync(path.join(r1.packDir, name)), `${name} scaffolded`);
    }
    assert.ok(fs.existsSync(path.join(r1.packDir, 'README.md')), 'README scaffolded');
    // Edit a file, then re-scaffold: it must not be clobbered.
    const vg = path.join(r1.packDir, 'voice-guide.md');
    fs.writeFileSync(vg, 'CUSTOM VOICE', 'utf8');
    const r2 = out.scaffoldPack(proj, OUT, TEMPLATES, REQUIRED);
    assert.deepEqual(r2.created, [], 'nothing recreated on the second pass');
    assert.equal(fs.readFileSync(vg, 'utf8'), 'CUSTOM VOICE', 'edited pack file untouched');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('packStatus is unfilled until every required file loses the sentinel', () => {
  const proj = tmpProject();
  try {
    // Nothing scaffolded yet -> all missing/unfilled.
    const s0 = out.packStatus(proj, OUT, REQUIRED);
    assert.equal(s0.configured, false);
    assert.deepEqual(s0.unfilled.slice().sort(), REQUIRED.slice().sort());

    // Scaffolded templates carry the sentinel -> still unfilled.
    out.scaffoldPack(proj, OUT, TEMPLATES, REQUIRED);
    const s1 = out.packStatus(proj, OUT, REQUIRED);
    assert.equal(s1.configured, false);
    assert.ok(s1.unfilled.length > 0);

    // Fill every required file (remove the sentinel) -> configured.
    for (const name of REQUIRED) {
      fs.writeFileSync(path.join(proj, OUT, 'pack', name), `# ${name}\nreal content\n`, 'utf8');
    }
    const s2 = out.packStatus(proj, OUT, REQUIRED);
    assert.equal(s2.configured, true);
    assert.deepEqual(s2.unfilled, []);
    assert.equal(s2.packDir, path.join(proj, OUT, 'pack'));
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('createRunFolder suffixes -2 on same-date collision', () => {
  const proj = tmpProject();
  try {
    out.ensureStructure(proj, OUT);
    const a = out.createRunFolder(proj, OUT, '2026-06-02-tuesday');
    const b = out.createRunFolder(proj, OUT, '2026-06-02-tuesday');
    assert.ok(a.endsWith('2026-06-02-tuesday'), `got ${a}`);
    assert.ok(b.endsWith('2026-06-02-tuesday-2'), `got ${b}`);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('runFolderLabel formats YYYY-MM-DD-weekday', () => {
  // 2026-06-02 is a Tuesday.
  assert.equal(out.runFolderLabel(new Date(2026, 5, 2)), '2026-06-02-tuesday');
});

test('verifyHandoff detects present and missing sections', () => {
  const proj = tmpProject();
  try {
    const run = out.createRunFolder(proj, OUT, '2026-06-02-tuesday');
    const f = path.join(run, 'plan.md');
    fs.writeFileSync(f, '## Platforms\nX\n## Per-platform angle\nthread\n## CTA\nnone\n', 'utf8');
    const r = out.verifyHandoff(f, ['Platforms', 'Per-platform angle', 'CTA', 'Length']);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ['Length']);
    assert.equal(out.verifyHandoff(f, ['Platforms', 'CTA']).ok, true);
    const r3 = out.verifyHandoff(path.join(run, 'nope.md'), ['Topic']);
    assert.equal(r3.ok, false);
    assert.deepEqual(r3.missing, ['Topic']);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('appendLog writes one line per call; parseRecentTopics reads topics', () => {
  const proj = tmpProject();
  try {
    out.ensureStructure(proj, OUT);
    out.appendLog(proj, OUT, '2026-06-02 | Boondocking basics | X,LinkedIn | SHIP | 3 drafts');
    out.appendLog(proj, OUT, '2026-06-04 | Mobile trip planning | Blog | SHIP');
    assert.deepEqual(
      out.parseRecentTopics(proj, OUT, 5),
      ['boondocking basics', 'mobile trip planning'],
    );
    const lines = fs.readFileSync(out.teamPaths(proj, OUT).logPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean);
    assert.equal(lines.length, 3, 'header + 2 entries');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('listRunSummaries extracts topic/platforms/verdict/summary + reached from artifacts', () => {
  const proj = tmpProject();
  try {
    out.ensureStructure(proj, OUT);
    const run = out.createRunFolder(proj, OUT, '2026-06-02-tuesday');
    fs.writeFileSync(path.join(run, 'brief.md'), '## Topic\nBoondocking basics\n## Angle\nhook\n', 'utf8');
    fs.writeFileSync(path.join(run, 'plan.md'), '## Platforms\nX, LinkedIn\n', 'utf8');
    fs.writeFileSync(path.join(run, 'review.md'), '## Summary\nStrong run overall, minor fixes.\n\nVERDICT: FIX\n', 'utf8');
    const stages = [
      { id: 'researcher', produces: 'brief.md' },
      { id: 'strategist', produces: 'plan.md' },
      { id: 'writer', produces: 'drafts.md' },
      { id: 'editor', produces: 'review.md' },
    ];
    const runs = out.listRunSummaries(proj, OUT, stages, 10);
    assert.equal(runs.length, 1);
    const r = runs[0];
    assert.equal(r.topic, 'Boondocking basics');
    assert.equal(r.platforms, 'X, LinkedIn');
    assert.equal(r.verdict, 'FIX');
    assert.match(r.summary, /Strong run overall/);
    // drafts.md was never written, so the writer stage is not "reached".
    assert.deepEqual(r.reached, ['researcher', 'strategist', 'editor']);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('listRunSummaries is newest-first and tolerates a partial (no-review) run', () => {
  const proj = tmpProject();
  try {
    out.ensureStructure(proj, OUT);
    const r1 = out.createRunFolder(proj, OUT, '2026-06-02-tuesday');
    fs.writeFileSync(path.join(r1, 'brief.md'), '## Topic\nFirst\n', 'utf8');
    const r2 = out.createRunFolder(proj, OUT, '2026-06-04-thursday');
    fs.writeFileSync(path.join(r2, 'brief.md'), 'INSUFFICIENT_TOPICS\n', 'utf8');
    const stages = [{ id: 'researcher', produces: 'brief.md' }, { id: 'editor', produces: 'review.md' }];
    const runs = out.listRunSummaries(proj, OUT, stages, 10);
    assert.equal(runs[0].runId, '2026-06-04-thursday', 'newest first');
    assert.equal(runs[0].verdict, '', 'no review.md -> no verdict (incomplete)');
    assert.deepEqual(runs[1].reached, ['researcher']);
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
