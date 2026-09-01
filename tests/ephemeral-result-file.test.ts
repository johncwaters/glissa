import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as ephemeralSession from '../server/ephemeral-session.ts';

const { createJobResultFile, JOB_RESULT_FILENAME, readResultFile } = ephemeralSession;

test('a job result file lives in its own fresh directory, named after the job', async () => {
  const file = await createJobResultFile('glissa-pr-owner-repo-42');
  try {
    const dir = path.dirname(file.path);
    assert.equal(path.basename(file.path), JOB_RESULT_FILENAME);
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()), 'the DIRECTORY sits in temp, not the file');
    assert.ok(path.basename(dir).startsWith('glissa-pr-owner-repo-42-'), 'the informative name rides the prefix');
    assert.ok(fs.existsSync(dir), 'the directory exists before the agent is told the path');
    assert.ok(!fs.existsSync(file.path), 'and holds no result file yet');
  } finally {
    await file.cleanup();
  }
});

test('two jobs with the same name never share a directory (nothing is guessable)', async () => {
  const first = await createJobResultFile('glissa-posthog-fix-1-abc');
  const second = await createJobResultFile('glissa-posthog-fix-1-abc');
  try {
    assert.notEqual(path.dirname(first.path), path.dirname(second.path));
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});

test('a prefix carrying repo/issue ids is reduced to a safe path segment', async () => {
  const file = await createJobResultFile('glissa-pr-../../etc/pwn me');
  try {
    const dir = path.dirname(file.path);
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()), 'no traversal out of temp');
    assert.match(path.basename(dir), /^[\w.-]+$/);
  } finally {
    await file.cleanup();
  }
});

test('cleanup removes the whole directory, result file and all, and is safe to repeat', async () => {
  const file = await createJobResultFile('glissa-distill-glissa-0');
  const dir = path.dirname(file.path);
  fs.writeFileSync(file.path, '{"verdict":"CLEAN"}', 'utf8');

  await file.cleanup();
  assert.ok(!fs.existsSync(dir), 'directory gone');
  await file.cleanup();
});

test('a caller-supplied directory is unreachable: the seam exposes no remove-by-path verb', async () => {
  assert.equal(typeof ephemeralSession.createJobResultFile, 'function');
  assert.equal('removeJobResultFile' in ephemeralSession, false,
    'no path-based remover exists to be handed a foreign path');

  const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-foreign-'));
  fs.writeFileSync(path.join(foreignDir, JOB_RESULT_FILENAME), '{}', 'utf8');
  fs.writeFileSync(path.join(foreignDir, 'keep.txt'), 'keep\n', 'utf8');
  try {
    const file = await createJobResultFile('glissa-distill-owned');
    fs.writeFileSync(file.path, '{}', 'utf8');
    await file.cleanup();

    assert.ok(!fs.existsSync(path.dirname(file.path)), 'cleanup removes the directory it minted');
    assert.ok(fs.existsSync(path.join(foreignDir, JOB_RESULT_FILENAME)), 'and nothing else named result.json');
    assert.ok(fs.existsSync(path.join(foreignDir, 'keep.txt')), 'the foreign directory survives intact');
  } finally {
    fs.rmSync(foreignDir, { recursive: true, force: true });
  }
});

test('the result directory is owner-only', { skip: process.platform === 'win32' }, async () => {
  const file = await createJobResultFile('glissa-pr-modes');
  try {
    const mode = fs.statSync(path.dirname(file.path)).mode & 0o777;
    assert.equal(mode, 0o700, 'mkdtemp mints a 0700 directory, so no other account can read the verdict');
  } finally {
    await file.cleanup();
  }
});

test('result reader returns typed failures and keeps validation separate from allowed verdicts', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-result-reader-'));
  const resultPath = path.join(workDir, 'result.json');
  try {
    const missing = readResultFile(resultPath, new Set(['CLEAN']));
    assert.deepEqual(missing, {
      ok: false,
      kind: 'missing',
      reason: 'no result file',
      verdict: 'ERROR',
      summary: 'no result file',
    });

    fs.writeFileSync(resultPath, '{not json', 'utf8');
    const malformed = readResultFile(resultPath, new Set(['CLEAN']));
    assert.equal(malformed.kind, 'invalid-json');

    fs.writeFileSync(resultPath, JSON.stringify({ verdict: 'UNLISTED' }), 'utf8');
    const validated = readResultFile(resultPath, null, null, {
      validate: (parsed) => ({ ok: true, verdict: String(parsed.verdict), summary: '' }),
    });
    assert.deepEqual(validated, { ok: true, verdict: 'UNLISTED', summary: '' });
    assert.throws(
      () => readResultFile(resultPath, new Set(['CLEAN']), null, {
        validate: () => ({ ok: true, verdict: 'CLEAN', summary: '' }),
      }),
      /allowed or validate/
    );
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
