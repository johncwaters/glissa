import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  buildRtkHookEntry,
  resolveRtkPath,
} from '../session/core/rtk-command.ts';
import type { StatApi } from '../session/core/rtk-command.ts';
import { getRtkPath, resetRtkPathCache } from '../server/rtk-resolver.ts';
import { MAX_RTK_STDOUT_BYTES, normalizeRtkHookResponse } from '../session/core/rtk-hook-core.ts';

function fsWithFiles(files: string[]): StatApi {
  const normalized = new Set(files.map((file) => path.resolve(file)));
  return {
    statSync(candidate: string) {
      const resolved = path.resolve(candidate);
      if (!normalized.has(resolved)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { isFile: () => true };
    },
  };
}

test('buildRtkHookEntry emits a forward-slash hook command without quoting a plain path', () => {
  assert.deepEqual(buildRtkHookEntry('C:\\tools\\rtk.exe'), {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: 'C:/tools/rtk.exe hook claude' }],
  });
});

test('buildRtkHookEntry quotes a forward-slash hook command containing spaces', () => {
  assert.deepEqual(buildRtkHookEntry('C:\\Program Files\\rtk\\rtk.exe'), {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: '"C:/Program Files/rtk/rtk.exe" hook claude' }],
  });
});

test('resolveRtkPath prefers the Glissa managed bin directory before PATH', () => {
  const homeDir = path.join('C:\\Users', 'johnw');
  const bundled = path.join(homeDir, '.glissa', 'bin', 'rtk.exe');
  const resolved = resolveRtkPath({
    homeDir,
    platform: 'win32',
    fsApi: fsWithFiles([bundled]),
    exec: () => {
      throw new Error('PATH should not be queried');
    },
  });
  assert.equal(resolved, path.resolve(bundled));
});

test('resolveRtkPath probes extensionless Glissa bin candidate for non-Windows installs', () => {
  const homeDir = '/home/jw';
  const bundled = path.join(homeDir, '.glissa', 'bin', 'rtk');
  const resolved = resolveRtkPath({
    homeDir,
    platform: 'linux',
    fsApi: fsWithFiles([bundled]),
    exec: () => {
      throw new Error('PATH should not be queried');
    },
  });
  assert.equal(resolved, path.resolve(bundled));
});

test('resolveRtkPath falls back to the first PATH match', () => {
  const resolved = resolveRtkPath({
    homeDir: 'C:\\Users\\johnw',
    platform: 'win32',
    fsApi: fsWithFiles([]),
    exec: () => 'C:\\tools\\rtk.exe\r\nC:\\other\\rtk.exe\r\n',
  });
  assert.equal(resolved, path.resolve('C:\\tools\\rtk.exe'));
});

test('resolveRtkPath falls back to command -v when which is missing on posix', () => {
  const commands: string[] = [];
  const resolved = resolveRtkPath({
    homeDir: '/home/jw',
    platform: 'linux',
    fsApi: fsWithFiles([]),
    exec(command: string) {
      commands.push(command);
      if (command === 'which -a rtk') throw new Error('which missing');
      assert.equal(command, 'sh -c "command -v rtk"');
      return '/home/jw/.local/bin/rtk\n';
    },
  });

  assert.deepEqual(commands, ['which -a rtk', 'sh -c "command -v rtk"']);
  assert.equal(resolved, path.resolve('/home/jw/.local/bin/rtk'));
});

test('resolveRtkPath falls back to command -v when which returns no matches', () => {
  const commands: string[] = [];
  const resolved = resolveRtkPath({
    homeDir: '/home/jw',
    platform: 'linux',
    fsApi: fsWithFiles([]),
    exec(command: string) {
      commands.push(command);
      if (command === 'which -a rtk') return '\n';
      return '/usr/local/bin/rtk\n';
    },
  });

  assert.deepEqual(commands, ['which -a rtk', 'sh -c "command -v rtk"']);
  assert.equal(resolved, path.resolve('/usr/local/bin/rtk'));
});

test('resolveRtkPath returns null when neither managed bin nor PATH resolves', () => {
  const resolved = resolveRtkPath({
    homeDir: 'C:\\Users\\johnw',
    platform: 'win32',
    fsApi: fsWithFiles([]),
    exec: () => {
      throw new Error('not found');
    },
  });
  assert.equal(resolved, null);
});

test('the RTK resolution cache has an explicit invalidation path', () => {
  let calls = 0;
  resetRtkPathCache();
  assert.equal(getRtkPath(() => {
    calls += 1;
    return '/first/rtk';
  }), '/first/rtk');
  assert.equal(getRtkPath(() => {
    calls += 1;
    return '/ignored/rtk';
  }), '/first/rtk');
  assert.equal(calls, 1);
  resetRtkPathCache();
  assert.equal(getRtkPath(() => {
    calls += 1;
    return '/second/rtk';
  }), '/second/rtk');
  assert.equal(calls, 2);
  resetRtkPathCache();
});

test('a rewrite missing permissionDecision is completed with allow', () => {
  const raw = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecisionReason: 'RTK auto-rewrite',
      updatedInput: { command: 'rtk git log --oneline -3' },
    },
  });
  const normalized = JSON.parse(normalizeRtkHookResponse(`${raw}\n`));
  assert.equal(normalized.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(normalized.hookSpecificOutput.updatedInput, { command: 'rtk git log --oneline -3' });
  assert.equal(normalized.hookSpecificOutput.permissionDecisionReason, 'RTK auto-rewrite');
});

test('an explicit decision is never rewritten, whatever it says', () => {
  for (const permissionDecision of ['allow', 'deny', 'ask']) {
    const raw = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, updatedInput: { command: 'rtk ls -la' } },
    });
    assert.equal(JSON.parse(normalizeRtkHookResponse(raw)).hookSpecificOutput.permissionDecision, permissionDecision);
  }
});

test('a verdict carrying no updatedInput passes through without gaining a decision', () => {
  const raw = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse' } });
  const normalized = JSON.parse(normalizeRtkHookResponse(raw));
  assert.equal('permissionDecision' in normalized.hookSpecificOutput, false);
});

test('anything unusable normalizes to the empty response, which leaves the tool call alone', () => {
  for (const unusable of ['', '   ', '\n', 'not json', '{"a":', '[]', 'null', '"text"', '42', undefined, null, 7]) {
    assert.equal(normalizeRtkHookResponse(unusable), '', String(unusable));
  }
});

test('an oversize verdict is refused rather than forwarded', () => {
  const padded = JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'x'.repeat(MAX_RTK_STDOUT_BYTES) } },
  });
  assert.equal(normalizeRtkHookResponse(padded), '');
});
