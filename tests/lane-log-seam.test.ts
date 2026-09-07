import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createLaneLog } from '../server/lane-log.ts';

const repoRoot = path.join(import.meta.dirname, '..');

const laneModules = [
  { file: 'server/trace-wiring.ts', prefix: '[trace]' },
  { file: 'server/usage-wiring.ts', prefix: '[usage]' },
  { file: 'server/usage-scanner.ts', prefix: '[usage]' },
  { file: 'server/usage-lane-ledger.ts', prefix: '[usage]' },
  { file: 'server/usage-pricing.ts', prefix: '[usage]' },
];

const calledLoggerChannel = /\blogger\s*\.\s*(?:log|warn|error|info|debug)\s*\(/;
const loggerGuard = /typeof\s+logger\s*\.\s*(?:log|warn)/;
const bracketPrefix = /['\"]\s*(\[[a-z][a-z0-9:-]*\])/g;

function sourceFor(file: string): string {
  return fs.readFileSync(path.join(repoRoot, file), 'utf8');
}

function wiringArgumentBlock(source: string, call: string): string {
  const lines = source.split('\n');
  const startLine = lines.findIndex((line) => line.includes(call));
  assert.notEqual(startLine, -1, `expected ${call} in server/backend-lanes.ts`);
  const endLine = lines.findIndex((line, index) => index > startLine && line === '  });');
  assert.notEqual(endLine, -1, `expected ${call} to end at   });`);
  return lines.slice(startLine, endLine + 1).join('\n');
}

test('trace and usage lanes use lane-log for their logging boundary', () => {
  const offenders: string[] = [];
  for (const { file, prefix } of laneModules) {
    const source = sourceFor(file);
    if (!source.includes("from './lane-log.ts'")) offenders.push(`${file}: missing import from './lane-log.ts'`);
    if (/console\./.test(source)) offenders.push(`${file}: direct console channel`);
    if (calledLoggerChannel.test(source)) offenders.push(`${file}: called logger channel`);
    if (loggerGuard.test(source)) offenders.push(`${file}: hand-rolled logger guard`);
    for (const match of source.matchAll(bracketPrefix)) {
      if (match[1] !== prefix) offenders.push(`${file}: unexpected bracket prefix ${match[1]}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `These lane modules must use createLaneLog exclusively:\n  ${offenders.join('\n  ')}`,
  );
});

test('backend lane wiring forwards logger and debug settings', () => {
  const source = sourceFor('server/backend-lanes.ts');
  for (const call of ['createTraceWiring({', 'createUsageWiring({']) {
    const block = wiringArgumentBlock(source, call);
    assert.match(block, /\blogger\b/, `${call} must receive logger`);
    assert.match(block, /\bdebug:/, `${call} must receive debug`);
  }
});

test('createLaneLog exposes every lane logging channel', () => {
  const laneLog = createLaneLog();
  for (const channel of [laneLog.note, laneLog.warn, laneLog.warnOnce, laneLog.debugNote]) {
    assert.equal(typeof channel, 'function');
  }
});
