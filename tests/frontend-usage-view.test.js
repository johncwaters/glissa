'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// usage-view-core is ESM (.mjs); dynamic-import it from this CJS test file.
const importCore = () => import('../public/usage-view-core.mjs');

test('formatUsd: cents, thousands grouping, sub-cent precision and a missing value', async () => {
  const { formatUsd, NO_VALUE } = await importCore();
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(1.5), '$1.50');
  assert.equal(formatUsd(1234.567), '$1,234.57');
  assert.equal(formatUsd(1234567.891), '$1,234,567.89');
  // A per-model row can legitimately cost a fraction of a cent; rounding it to $0.00 would read as free.
  assert.equal(formatUsd(0.0042), '$0.0042');
  assert.equal(formatUsd(-2.5), '-$2.50');
  assert.equal(formatUsd(null), NO_VALUE);
  assert.equal(formatUsd(Number.NaN), NO_VALUE);
  assert.equal(formatUsd(undefined), NO_VALUE);
});

test('formatTokens: plain under 1k, k and M abbreviation with trailing zeros trimmed', async () => {
  const { formatTokens, NO_VALUE } = await importCore();
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1000), '1k');
  assert.equal(formatTokens(1250), '1.3k');
  assert.equal(formatTokens(12345), '12.3k');
  assert.equal(formatTokens(1000000), '1M');
  assert.equal(formatTokens(1234567), '1.23M');
  // Just below a million already rounds to 1.0M at k precision, so it must not read "1000k".
  assert.equal(formatTokens(999950), '1M');
  assert.equal(formatTokens(-1500), '-1.5k');
  assert.equal(formatTokens('nope'), NO_VALUE);
});

test('formatCount: thousands grouping for scan stats', async () => {
  const { formatCount, NO_VALUE } = await importCore();
  assert.equal(formatCount(7), '7');
  assert.equal(formatCount(45231), '45,231');
  assert.equal(formatCount(null), NO_VALUE);
});

test('dayLabel and dayRangeLabel: month plus day, and a range worded "to"', async () => {
  const { dayLabel, dayRangeLabel } = await importCore();
  assert.equal(dayLabel('2026-08-19'), 'Aug 19');
  assert.equal(dayLabel('2026-01-01'), 'Jan 1');
  assert.equal(dayLabel('not-a-day'), 'not-a-day');
  assert.equal(dayRangeLabel([]), '');
  assert.equal(dayRangeLabel(['2026-08-19']), 'Aug 19');
  // Order-independent, and the wording is "to" because the repo has no dash characters.
  assert.equal(dayRangeLabel([{ day: '2026-08-19' }, { day: '2026-08-12' }]), 'Aug 12 to Aug 19');
});

test('localDayKey: local calendar day, not UTC', async () => {
  const { localDayKey } = await importCore();
  const date = new Date(2026, 7, 19, 23, 30);
  assert.equal(localDayKey(date), '2026-08-19');
});

test('relativeAgo and formatMinutes: the shared elapsed ladders', async () => {
  const { relativeAgo, formatMinutes, NO_VALUE } = await importCore();
  const now = 1_000_000_000;
  assert.equal(relativeAgo(now - 5000, now), '5s ago');
  assert.equal(relativeAgo(now - 120000, now), '2m ago');
  assert.equal(relativeAgo(now - 7200000, now), '2h ago');
  assert.equal(relativeAgo(now - 172800000, now), '2d ago');
  assert.equal(relativeAgo(null, now), 'never');
  assert.equal(formatMinutes(45), '45m');
  assert.equal(formatMinutes(120), '2h');
  assert.equal(formatMinutes(125), '2h 5m');
  assert.equal(formatMinutes(-1), NO_VALUE);
});

test('burnLine: every reported rate, and nothing at all without a burn block', async () => {
  const { burnLine } = await importCore();
  assert.equal(burnLine(null), '');
  assert.equal(
    burnLine({ tokensPerMinute: 12500, tokensPerMinuteExCache: 900, costPerHour: 3.5 }),
    '12.5k tokens per minute, 900 excluding cache, $3.50 per hour',
  );
  assert.equal(burnLine({ tokensPerMinute: 60 }), '60 tokens per minute');
});

test('projectionLine: uses the ASCII arrow, and degrades to whatever the server reported', async () => {
  const { projectionLine } = await importCore();
  assert.equal(projectionLine(null), '');
  assert.equal(
    projectionLine({ projectedTokens: 2400000, projectedCostUSD: 18.4, remainingMinutes: 95 }),
    '-> 2.4M tokens, $18.40 by block end, 1h 35m left in this block',
  );
  assert.equal(projectionLine({ remainingMinutes: 12 }), '12m left in this block');
  assert.equal(projectionLine({ projectedTokens: 1000 }), '-> 1k tokens by block end');
});

test('blockProgress: elapsed and remaining within the block window, clamped at both ends', async () => {
  const { blockProgress } = await importCore();
  const start = 1_700_000_000_000;
  const end = start + 5 * 3600000;
  const mid = blockProgress({ startTs: start, endTs: end }, start + 3600000);
  assert.equal(mid.pct, 20);
  assert.equal(mid.totalMinutes, 300);
  assert.equal(mid.elapsedMinutes, 60);
  assert.equal(mid.remainingMinutes, 240);
  // A clock that already passed the window end reads full, never over.
  assert.equal(blockProgress({ startTs: start, endTs: end }, end + 60000).pct, 100);
  assert.equal(blockProgress({ startTs: start, endTs: end }, start - 60000).pct, 0);
  assert.equal(blockProgress({ startTs: start, endTs: start }, start), null);
  assert.equal(blockProgress(null), null);
});

test('token limit: 80 percent warns, 100 is critical, and the line names the reference', async () => {
  const { tokenLimitTone, tokenLimitLine, hasUsageAttention, TOKEN_LIMIT_WARN_PCT } = await importCore();
  assert.equal(TOKEN_LIMIT_WARN_PCT, 80);
  assert.equal(tokenLimitTone(10), 'ok');
  assert.equal(tokenLimitTone(79.9), 'ok');
  assert.equal(tokenLimitTone(80), 'warn');
  assert.equal(tokenLimitTone(100), 'crit');
  assert.equal(tokenLimitTone(null), 'ok');
  assert.equal(tokenLimitLine({ max: 1500000, pct: 42.4 }), '42% of 1.5M tokens, the largest completed block seen');
  assert.equal(tokenLimitLine({ max: 0, pct: 10 }), '');
  assert.equal(tokenLimitLine(null), '');
  assert.equal(hasUsageAttention({ tokenLimit: { max: 10, pct: 81 } }), true);
  assert.equal(hasUsageAttention({ tokenLimit: { max: 10, pct: 12 } }), false);
  assert.equal(hasUsageAttention({ tokenLimit: null }), false);
  assert.equal(hasUsageAttention(null), false);
});

test('pricing and scan lines: source, staleness, missing models and a partial pass', async () => {
  const { pricingSourceLine, missingPricingLine, scanLine } = await importCore();
  const now = 1_000_000_000;
  assert.equal(
    pricingSourceLine({ source: 'fetched', fetchedAt: now - 3600000 }, now),
    'Prices fetched from the public model price table, 1h ago.',
  );
  assert.equal(pricingSourceLine({ source: 'fetched' }, now), 'Prices fetched from the public model price table.');
  assert.equal(pricingSourceLine({ source: 'snapshot' }, now), 'Prices from the price table bundled with this Glissa build.');
  assert.equal(pricingSourceLine(null, now), 'Pricing source not reported yet.');

  assert.equal(missingPricingLine([]), '');
  assert.equal(missingPricingLine(['weird-model']), 'No price for 1 model: weird-model. Their cost counts as zero here.');
  assert.equal(missingPricingLine(['a', 'b']), 'No price for 2 models: a, b. Their cost counts as zero here.');

  assert.equal(scanLine(null), '');
  assert.equal(
    scanLine({ dirs: 1, files: 210, entries: 45231, lastScanMs: 318 }),
    'Scanned 1 transcript directory, 210 files, 45,231 entries, last pass 318ms.',
  );
  const partial = scanLine({ dirs: 2, files: 4, entries: 9, lastScanMs: 5, partial: true });
  assert.match(partial, /^Scanned 2 transcript directories, /);
  assert.match(partial, /skipped this pass/);
});

test('sessionRowLabel: a managed session wears its name, anything else its project basename', async () => {
  const { sessionRowLabel, isGlissaSessionRow } = await importCore();
  assert.equal(sessionRowLabel({ id: 'abc', label: 'glissa-1', project: 'C:\\repos\\glissa' }), 'glissa-1');
  assert.equal(sessionRowLabel({ id: null, label: 'ignored', project: 'C:\\repos\\other-thing' }), 'other-thing');
  assert.equal(sessionRowLabel({ id: null, label: '', project: '/home/x/projects/api/' }), 'api');
  assert.equal(sessionRowLabel({ id: null, label: 'only-label' }), 'only-label');
  assert.equal(sessionRowLabel({}), 'unknown project');
  assert.equal(isGlissaSessionRow({ id: 'abc' }), true);
  assert.equal(isGlissaSessionRow({ id: null }), false);
});

test('sortSessionRows: last activity first, then tokens, then label; input is not mutated', async () => {
  const { sortSessionRows } = await importCore();
  const rows = [
    { id: 'a', label: 'alpha', tokens: 10, lastTs: 100 },
    { id: 'b', label: 'bravo', tokens: 50, lastTs: 900 },
    { id: 'c', label: 'charlie', tokens: 70, lastTs: 500 },
    { id: 'd', label: 'delta', tokens: 90, lastTs: 500 },
    { id: 'e', label: 'echo', tokens: 90, lastTs: 500 },
    { id: 'f', label: 'foxtrot', tokens: 5 },
  ];
  const sorted = sortSessionRows(rows);
  assert.deepEqual(sorted.map((r) => r.id), ['b', 'd', 'e', 'c', 'a', 'f']);
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('sortDailyRows and sortModelRows: newest day first, biggest model first', async () => {
  const { sortDailyRows, sortModelRows, modelLabel } = await importCore();
  const daily = [{ day: '2026-08-12' }, { day: '2026-08-19' }, { day: '2026-08-15' }];
  assert.deepEqual(sortDailyRows(daily).map((r) => r.day), ['2026-08-19', '2026-08-15', '2026-08-12']);
  const models = [{ model: 'small', tokens: 10 }, { model: 'big', tokens: 900 }, { model: 'mid', tokens: 100 }];
  assert.deepEqual(sortModelRows(models).map((r) => r.model), ['big', 'mid', 'small']);
  assert.equal(modelLabel({ model: null }), 'unknown model');
  assert.equal(modelLabel('claude-opus-4'), 'claude-opus-4');
  assert.deepEqual(sortModelRows(null), []);
});

test('dailyRowForDay: exact day match or null', async () => {
  const { dailyRowForDay } = await importCore();
  const daily = [{ day: '2026-08-18', tokens: 1 }, { day: '2026-08-19', tokens: 2 }];
  assert.equal(dailyRowForDay(daily, '2026-08-19').tokens, 2);
  assert.equal(dailyRowForDay(daily, '2026-08-01'), null);
  assert.equal(dailyRowForDay(null, '2026-08-19'), null);
});

test('sessionChipText: tokens plus cost, tokens alone, or nothing to show', async () => {
  const { sessionChipText } = await importCore();
  assert.equal(sessionChipText({ tokens: 125000, costUSD: 1.234 }), '125k $1.23');
  assert.equal(sessionChipText({ tokens: 900, costUSD: 0 }), '900');
  assert.equal(sessionChipText({ tokens: 0, costUSD: 5 }), '');
  assert.equal(sessionChipText(null), '');
});

// House rule, and the reason every builder above is worded the way it is: no em dash, en dash or
// ellipsis character may reach the DOM from this module.
test('no produced string contains an em dash, en dash or ellipsis character', async () => {
  const core = await importCore();
  const forbidden = [String.fromCharCode(0x2014), String.fromCharCode(0x2013), String.fromCharCode(0x2026)];
  const now = 1_000_000_000;
  const numbers = [0, 1, 0.004, 999, 1000, 1250, 999950, 1234567.89, -42, Number.NaN, Infinity, null, undefined];

  const produced = [core.USAGE_CAVEAT, core.NO_VALUE];
  for (const n of numbers) {
    produced.push(core.formatUsd(n), core.formatTokens(n), core.formatCount(n), core.formatMinutes(n));
    produced.push(core.relativeAgo(n, now), core.tokenLimitTone(n));
    produced.push(core.burnLine({ tokensPerMinute: n, tokensPerMinuteExCache: n, costPerHour: n }));
    produced.push(core.projectionLine({ projectedTokens: n, projectedCostUSD: n, remainingMinutes: n }));
    produced.push(core.tokenLimitLine({ max: n, pct: n }));
  }
  produced.push(core.dayLabel('2026-08-19'), core.dayLabel(''), core.dayLabel(null));
  produced.push(core.dayRangeLabel([{ day: '2026-08-12' }, { day: '2026-08-19' }]), core.dayRangeLabel([]));
  produced.push(core.pricingSourceLine({ source: 'fetched', fetchedAt: now - 1000 }, now));
  produced.push(core.pricingSourceLine({ source: 'snapshot' }, now), core.pricingSourceLine(null, now));
  produced.push(core.missingPricingLine(['a', 'b']), core.missingPricingLine([]));
  produced.push(core.scanLine({ dirs: 2, files: 3, entries: 4, lastScanMs: 5, partial: true }));
  produced.push(core.scanLine({ dirs: 1, files: 3, entries: 4, lastScanMs: 5 }));
  produced.push(core.sessionRowLabel({}), core.sessionRowLabel({ id: 'x', label: 'name' }));
  produced.push(core.modelLabel({ model: null }), core.sessionChipText({ tokens: 125000, costUSD: 1.2 }));

  for (const value of produced) {
    assert.equal(typeof value, 'string');
    for (const glyph of forbidden) {
      assert.equal(value.includes(glyph), false, `forbidden character in ${JSON.stringify(value)}`);
    }
  }
});
