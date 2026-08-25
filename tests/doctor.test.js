'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

test('doctor reports each pack carrier and the codex hook-trust caveat', () => {
  const npmPrefix = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-doctor-'));
  try {
    const result = spawnSync(process.execPath, ['bin/glissa.js', 'doctor'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, npm_config_prefix: npmPrefix },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /claude-code pack carrier\s+--add-dir directories/);
    assert.match(result.stdout, /codex pack carrier\s+developer_instructions index pointers/);
    assert.match(result.stdout, /codex pack notices\s+staleness notices require trusted UserPromptSubmit hooks or the hook-trust bypass/);
  } finally {
    fs.rmSync(npmPrefix, { recursive: true, force: true });
  }
});
