import test from 'node:test';
import assert from 'node:assert/strict';

// usage-view-core is ESM (.mjs); dynamic-import it so the suite drives the shipped module.
const importCore = () => import('../public/usage-view-core.ts');

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

test('formatUsd: a nonzero cost below the last decimal never prints as $0.0000', async () => {
  const { formatUsd } = await importCore();
  assert.equal(formatUsd(0.000004), '<$0.0001');
  assert.equal(formatUsd(0.00009), '<$0.0001');
  assert.equal(formatUsd(-0.000004), 'above -$0.0001');
  // The boundary itself is representable, so it prints normally.
  assert.equal(formatUsd(0.0001), '$0.0001');
});

test('formatTokens: plain under 1k, then k, M and B with trailing zeros trimmed', async () => {
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

test('formatTokens: cache totals reach billions, so they get a B tier rather than reading 1000M', async () => {
  const { formatTokens } = await importCore();
  assert.equal(formatTokens(1e9), '1B');
  assert.equal(formatTokens(12.5e9), '12.5B');
  assert.equal(formatTokens(1.234e9), '1.23B');
  // Same crossing rule one tier up: this already rounds to 1000.00M at M precision.
  assert.equal(formatTokens(999995000), '1B');
  assert.equal(formatTokens(999994000), '999.99M');
  // A magnitude that rounds to zero must not carry a sign.
  assert.equal(formatTokens(-0.4), '0');
});

test('formatCount: thousands grouping for scan stats', async () => {
  const { formatCount, NO_VALUE } = await importCore();
  assert.equal(formatCount(7), '7');
  assert.equal(formatCount(45231), '45,231');
  assert.equal(formatCount(null), NO_VALUE);
});

test('formatPercent and percentOfTotal: share of the whole, with a floor for the invisible slice', async () => {
  const { formatPercent, percentOfTotal, NO_VALUE } = await importCore();
  assert.equal(percentOfTotal(25, 100), 25);
  assert.equal(percentOfTotal(1, 0), null);
  assert.equal(percentOfTotal(1, null), null);
  assert.equal(percentOfTotal('x', 100), null);
  assert.equal(formatPercent(60), '60%');
  assert.equal(formatPercent(12.34), '12.3%');
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(0.04), '<0.1%');
  assert.equal(formatPercent(null), NO_VALUE);
});

test('shareBasis: cost when there is any, tokens when every cost is zero', async () => {
  const { shareBasis, shareLabel } = await importCore();
  assert.equal(shareBasis({ costUSD: 12, tokens: 5 }), 'costUSD');
  assert.equal(shareBasis({ costUSD: 0, tokens: 5 }), 'tokens');
  assert.equal(shareBasis(null), 'tokens');
  assert.equal(shareLabel('costUSD'), 'share of cost');
  assert.equal(shareLabel('tokens'), 'share of tokens');
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

// The daily buckets are keyed on the SERVER's clock, so the today tile has to be resolved in the
// server's zone. Reading the browser's calendar day silently missed the bucket for any viewer in
// another zone, which remote mode makes routine.
test('reportDayKey: the report ts resolved in the report timezone, not the browser one', async () => {
  const { reportDayKey } = await importCore();
  const ts = Date.UTC(2026, 7, 19, 3, 30);
  assert.equal(reportDayKey({ ts, tz: 'UTC' }), '2026-08-19');
  assert.equal(reportDayKey({ ts, tz: 'Asia/Tokyo' }), '2026-08-19');
  // Same instant, still the previous day in Los Angeles.
  assert.equal(reportDayKey({ ts, tz: 'America/Los_Angeles' }), '2026-08-18');
  // An unresolvable zone falls back to this machine's day rather than losing the tile.
  assert.match(reportDayKey({ ts, tz: 'Not/AZone' }), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(reportDayKey(null), '');
  assert.equal(reportDayKey({ ts: 0, tz: 'UTC' }), '');
});

test('formatMinutes: the elapsed ladder', async () => {
  const { formatMinutes, NO_VALUE } = await importCore();
  assert.equal(formatMinutes(45), '45m');
  assert.equal(formatMinutes(120), '2h');
  assert.equal(formatMinutes(125), '2h 5m');
  assert.equal(formatMinutes(-1), NO_VALUE);
});

test('blockLabel: the wall-clock start of a 5h window', async () => {
  const { blockLabel, NO_VALUE } = await importCore();
  const start = new Date(2026, 7, 19, 14, 0).getTime();
  assert.equal(blockLabel(start), 'Aug 19 14:00');
  assert.equal(blockLabel(0), NO_VALUE);
  assert.equal(blockLabel(null), NO_VALUE);
});

test('burnTiles: the two rate numbers as tiles, with cache exclusion as the sub', async () => {
  const { burnTiles } = await importCore();
  assert.deepEqual(burnTiles(null), []);
  assert.deepEqual(burnTiles({ tokensPerMinute: 12500, tokensPerMinuteExCache: 900, costPerHour: 3.5 }), [
    { label: 'tokens per min', value: '12.5k', sub: '900 excluding cache' },
    { label: 'cost per hour', value: '$3.50', sub: '' },
  ]);
  assert.deepEqual(burnTiles({ tokensPerMinute: 60 }), [
    { label: 'tokens per min', value: '60', sub: '' },
  ]);
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
  assert.ok(mid, 'a clock inside the window reports progress');
  assert.equal(mid.pct, 20);
  assert.equal(mid.totalMinutes, 300);
  assert.equal(mid.elapsedMinutes, 60);
  assert.equal(mid.remainingMinutes, 240);
  // A clock that already passed the window end reads full, never over.
  assert.equal(blockProgress({ startTs: start, endTs: end }, end + 60000)?.pct, 100);
  assert.equal(blockProgress({ startTs: start, endTs: end }, start - 60000)?.pct, 0);
  assert.equal(blockProgress({ startTs: start, endTs: start }, start), null);
  assert.equal(blockProgress(null), null);
});

// The wire carries tokenLimit.pct as a RATIO (server/core/usage-blocks-core.ts builds
// activeBlock.tokens / max, pinned by tests/usage-blocks-core.test.js). Treating it as a percentage
// left the meter near empty, the line reading 0%, and the attention dot unable to fire at all.
test('limitPct: the wire ratio converted to the percent every threshold works in', async () => {
  const { limitPct } = await importCore();
  assert.equal(limitPct({ max: 1000, pct: 0.8 }), 80);
  assert.equal(limitPct({ max: 1000, pct: 1.25 }), 125);
  assert.equal(limitPct({ max: 0, pct: 0.8 }), null);
  assert.equal(limitPct({ max: 1000, pct: null }), null);
  assert.equal(limitPct(null), null);
});

test('token limit: 80 percent warns, 100 is critical, and the line names the reference', async () => {
  const { tokenLimitTone, tokenLimitLine, TOKEN_LIMIT_WARN_PCT } = await importCore();
  assert.equal(TOKEN_LIMIT_WARN_PCT, 80);
  assert.equal(tokenLimitTone(10), 'ok');
  assert.equal(tokenLimitTone(79.9), 'ok');
  assert.equal(tokenLimitTone(80), 'warn');
  assert.equal(tokenLimitTone(100), 'crit');
  assert.equal(tokenLimitTone(null), 'ok');
  assert.equal(tokenLimitLine({ max: 1500000, pct: 0.424 }), '42% of 1.5M tokens, the largest completed block seen');
  assert.equal(tokenLimitLine({ max: 0, pct: 0.1 }), '');
  assert.equal(tokenLimitLine(null), '');
});

test('projected limit: where the burn rate lands, not only where the block already is', async () => {
  const { projectedLimitPct, projectionLimitLine, blockAttentionTone, hasUsageAttention } = await importCore();
  const tokenLimit = { max: 1000, pct: 0.2 };
  assert.equal(projectedLimitPct({ projectedTokens: 900 }, tokenLimit), 90);
  assert.equal(projectedLimitPct({ projectedTokens: 900 }, { max: 0 }), null);
  assert.equal(projectedLimitPct(null, tokenLimit), null);
  assert.equal(
    projectionLimitLine({ projectedTokens: 900 }, tokenLimit),
    'On this burn rate the block ends at 90% of that reference.',
  );
  assert.equal(
    projectionLimitLine({ projectedTokens: 1400 }, tokenLimit),
    'On this burn rate the block ends past that reference, at 140% of it.',
  );
  assert.equal(projectionLimitLine(null, tokenLimit), '');

  // A block only a fifth of the way in but heading past the reference is the whole point: a purely
  // reactive alarm fires after the tokens are already spent.
  const heading = { tokenLimit, activeBlock: { projection: { projectedTokens: 900 } } };
  assert.equal(blockAttentionTone(heading), 'warn');
  assert.equal(hasUsageAttention(heading), true);
  const calm = { tokenLimit, activeBlock: { projection: { projectedTokens: 300 } } };
  assert.equal(blockAttentionTone(calm), 'ok');
  assert.equal(hasUsageAttention(calm), false);
  // Already past the threshold, regardless of where it is heading.
  assert.equal(blockAttentionTone({ tokenLimit: { max: 10, pct: 0.81 } }), 'warn');
  assert.equal(blockAttentionTone({ tokenLimit: { max: 10, pct: 1.4 } }), 'crit');
  assert.equal(hasUsageAttention({ tokenLimit: { max: 10, pct: 0.12 } }), false);
  assert.equal(hasUsageAttention({ tokenLimit: null }), false);
  assert.equal(hasUsageAttention(null), false);
});

test('usageAttentionSignature: names which arbiter fires, at a coarse bucket', async () => {
  const { usageAttentionSignature } = await importCore();
  assert.equal(usageAttentionSignature({ tokenLimit: { max: 10, pct: 0.85 } }), 'block:warn');
  assert.equal(usageAttentionSignature({ tokenLimit: { max: 10, pct: 1.4 } }), 'block:crit');
  assert.equal(usageAttentionSignature({ anomaly: { daily: { ratio: 3 }, burn: null } }), 'anomaly:daily');
  assert.equal(usageAttentionSignature({ anomaly: { daily: null, burn: { ratio: 2 } } }), 'anomaly:burn');
  assert.equal(
    usageAttentionSignature({ budget: { rows: [{ scope: 'daily', budgetUsd: 2, pct: 95 }, { scope: 'monthly', budgetUsd: 50, pct: 120 }] } }),
    'budget:daily:near|budget:monthly:over',
  );
});

test('usageAttentionSignature: a wobbling percentage keeps its bucket, a crossed threshold does not', async () => {
  const { usageAttentionSignature } = await importCore();
  const at = (pct: number) => usageAttentionSignature({ tokenLimit: { max: 10, pct } });
  assert.equal(at(0.91), at(0.92), 'a percentage drifting inside its bucket must not re-light the dot');
  assert.notEqual(at(0.91), at(1.05), 'warn to crit is a new thing to say');
  const budgetAt = (pct: number) => usageAttentionSignature({ budget: { rows: [{ scope: 'daily', budgetUsd: 2, pct }] } });
  assert.equal(budgetAt(91), budgetAt(92));
  assert.notEqual(budgetAt(91), budgetAt(101));
});

test('usageAttentionSignature: a calm report is the empty signature, and hasUsageAttention agrees with it', async () => {
  const { usageAttentionSignature, hasUsageAttention } = await importCore();
  const calm = { tokenLimit: { max: 10, pct: 0.1 }, anomaly: null, budget: null };
  assert.equal(usageAttentionSignature(calm), '');
  assert.equal(hasUsageAttention(calm), false);
  assert.equal(usageAttentionSignature(null), '');
  const alarming = { tokenLimit: { max: 10, pct: 0.95 }, anomaly: { burn: { ratio: 2 } } };
  assert.equal(usageAttentionSignature(alarming), 'anomaly:burn|block:warn');
  assert.equal(hasUsageAttention(alarming), true);
});

test('usageAttentionSignature: official plan limits drive the block bucket when they exist', async () => {
  const { usageAttentionSignature } = await importCore();
  const calmEstimate = { tokenLimit: { max: 1000, pct: 0.1 } };
  assert.equal(usageAttentionSignature(calmEstimate, { fiveHour: { pct: 85 } }), 'block:warn');
  assert.equal(usageAttentionSignature({ tokenLimit: { max: 10, pct: 0.95 } }, { fiveHour: { pct: 4 } }), '');
});

test('pricing and scan lines: source, staleness, missing models and a partial pass', async () => {
  const { pricingSourceLine, missingPricingLine, scanLine } = await importCore();
  assert.equal(
    pricingSourceLine({ source: 'fetched' }, '1h ago'),
    'Prices fetched from the public model price table, 1h ago.',
  );
  assert.equal(pricingSourceLine({ source: 'fetched' }), 'Prices fetched from the public model price table.');
  assert.equal(pricingSourceLine({ source: 'snapshot' }), 'Prices from the price table bundled with this Glissa build.');
  // A failed pricing load is a reported state on the wire, not an unknown one.
  assert.equal(
    pricingSourceLine({ source: 'unavailable' }),
    'Model prices could not be loaded, so every cost below counts as zero.',
  );
  assert.equal(pricingSourceLine(null), 'Pricing source not reported yet.');

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

// scan.dirs is an ARRAY of resolved directories on the wire (server/usage-scanner.js sends
// dirs.slice()), so a finite-number check dropped the clause on every real report.
test('scanLine: counts the dirs array the wire actually sends', async () => {
  const { scanLine } = await importCore();
  assert.match(scanLine({ dirs: ['/a', '/b'], files: 3, entries: 4 }), /^Scanned 2 transcript directories, /);
  assert.match(scanLine({ dirs: ['/only'], files: 3, entries: 4 }), /^Scanned 1 transcript directory, /);
  assert.match(scanLine({ dirs: [], files: 3, entries: 4 }), /^Scanned 0 transcript directories, /);
});

// An error report carries no totals, so rendering the normal sections against it printed a confident
// zero for a lane that is switched off or cannot see its transcripts.
test('unavailable reports: the reason is surfaced instead of a page of zeros', async () => {
  const { isUsageUnavailable, usageErrorLine, usageWarningLine } = await importCore();
  assert.equal(isUsageUnavailable({ error: 'Usage tracking is disabled' }), true);
  assert.equal(usageErrorLine({ error: 'Usage tracking is disabled' }), 'Usage tracking is disabled');
  assert.equal(isUsageUnavailable({ error: null, totals: {} }), false);
  assert.equal(isUsageUnavailable({ error: '   ' }), false);
  assert.equal(isUsageUnavailable(null), false);
  assert.equal(usageErrorLine(null), '');
  assert.equal(
    usageWarningLine({ warning: 'CLAUDE_CONFIG_DIR is set but empty' }),
    'Glissa could not read every transcript location: CLAUDE_CONFIG_DIR is set but empty',
  );
  assert.equal(usageWarningLine({ warning: null }), '');
  assert.equal(usageWarningLine(null), '');
});

test('shouldApplyUsageReport: an unsolicited report always lands, a superseded reply never does', async () => {
  const { shouldApplyUsageReport } = await importCore();
  // The connect-time replay and any broadcast carry no id.
  assert.equal(shouldApplyUsageReport({ requestId: null }, 'usage-4'), true);
  assert.equal(shouldApplyUsageReport({}, 'usage-4'), true);
  assert.equal(shouldApplyUsageReport({ requestId: 'usage-4' }, 'usage-4'), true);
  assert.equal(shouldApplyUsageReport({ requestId: 'usage-3' }, 'usage-4'), false);
  assert.equal(shouldApplyUsageReport(null, 'usage-4'), false);
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

test('visibleSessionRows: caps collapsed session rows and reports hidden count', async () => {
  const { SESSION_ROW_LIMIT, visibleSessionRows } = await importCore();
  const underLimit = Array.from({ length: SESSION_ROW_LIMIT - 1 }, (_, index) => ({ id: String(index) }));
  const overLimit = Array.from({ length: SESSION_ROW_LIMIT + 3 }, (_, index) => ({ id: String(index) }));

  assert.deepEqual(visibleSessionRows(underLimit, false), { rows: underLimit, hiddenCount: 0 });
  assert.deepEqual(visibleSessionRows(overLimit, false), {
    rows: overLimit.slice(0, SESSION_ROW_LIMIT),
    hiddenCount: 3,
  });
  assert.deepEqual(visibleSessionRows(overLimit, true), { rows: overLimit, hiddenCount: 0 });
  assert.deepEqual(visibleSessionRows(null, false), { rows: [], hiddenCount: 0 });
});

test('sessionOverflowText: only positive hidden counts produce copy', async () => {
  const { sessionOverflowText } = await importCore();
  const forbidden = [String.fromCharCode(0x2014), String.fromCharCode(0x2013), String.fromCharCode(0x2026)];

  assert.equal(sessionOverflowText(0), '');
  assert.equal(sessionOverflowText(-1), '');
  assert.equal(sessionOverflowText(Number.NaN), '');

  const text = sessionOverflowText(42);
  assert.equal(text, '42 hidden');
  for (const glyph of forbidden) {
    assert.equal(text.includes(glyph), false);
  }
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

// The tables are sorted for whatever question the operator brought, so cost order has to be reachable:
// the default recency order buries the expensive row.
test('sortUsageRows: any column, either direction, with the header state helpers agreeing', async () => {
  const { sortUsageRows, sortSessionRows, nextSortState, defaultSortDir, ariaSortValue, modelLabel } = await importCore();
  const rows = [
    { id: 'a', label: 'alpha', tokens: 10, costUSD: 9, lastTs: 900 },
    { id: 'b', label: 'bravo', tokens: 90, costUSD: 1, lastTs: 100 },
    { id: 'c', label: 'charlie', tokens: 50, costUSD: 5, lastTs: 500 },
  ];
  assert.deepEqual(sortUsageRows(rows, 'costUSD', 'desc').map((r) => r.id), ['a', 'c', 'b']);
  assert.deepEqual(sortUsageRows(rows, 'costUSD', 'asc').map((r) => r.id), ['b', 'c', 'a']);
  assert.deepEqual(sortUsageRows(rows, 'tokens', 'desc').map((r) => r.id), ['b', 'c', 'a']);
  assert.deepEqual(sortUsageRows(rows, 'label', 'asc').map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(sortUsageRows(rows, 'label', 'desc').map((r) => r.id), ['c', 'b', 'a']);
  assert.deepEqual(sortSessionRows(rows, { key: 'costUSD', dir: 'desc' }).map((r) => r.id), ['a', 'c', 'b']);
  // A model table tie-breaks on its own label, not a session one.
  const models = [{ model: 'zeta', tokens: 5 }, { model: 'alpha', tokens: 5 }];
  assert.deepEqual(sortUsageRows(models, 'tokens', 'desc', modelLabel).map((r) => r.model), ['alpha', 'zeta']);

  assert.equal(defaultSortDir('tokens'), 'desc');
  assert.equal(defaultSortDir('label'), 'asc');
  // A date column leads with the newest, matching DEFAULT_DAY_SORT and the section's stated default.
  assert.equal(defaultSortDir('day'), 'desc');
  // Same column toggles; a new column takes its own default.
  assert.deepEqual(nextSortState({ key: 'tokens', dir: 'desc' }, 'tokens'), { key: 'tokens', dir: 'asc' });
  assert.deepEqual(nextSortState({ key: 'tokens', dir: 'asc' }, 'tokens'), { key: 'tokens', dir: 'desc' });
  assert.deepEqual(nextSortState({ key: 'tokens', dir: 'asc' }, 'costUSD'), { key: 'costUSD', dir: 'desc' });
  assert.deepEqual(nextSortState(null, 'label'), { key: 'label', dir: 'asc' });
  assert.equal(ariaSortValue({ key: 'tokens', dir: 'desc' }, 'tokens'), 'descending');
  assert.equal(ariaSortValue({ key: 'tokens', dir: 'asc' }, 'tokens'), 'ascending');
  assert.equal(ariaSortValue({ key: 'tokens', dir: 'asc' }, 'costUSD'), 'none');
});

test('dailyRowForDay: exact day match or null', async () => {
  const { dailyRowForDay } = await importCore();
  const daily = [{ day: '2026-08-18', tokens: 1 }, { day: '2026-08-19', tokens: 2 }];
  assert.equal(dailyRowForDay(daily, '2026-08-19')?.tokens, 2);
  assert.equal(dailyRowForDay(daily, '2026-08-01'), null);
  assert.equal(dailyRowForDay(null, '2026-08-19'), null);
});

// A gap block is the ABSENCE of work; a row of zeros for it would read as a quiet block instead.
test('blockHistoryRows: newest first, gaps dropped, active flagged, capped', async () => {
  const { blockHistoryRows } = await importCore();
  const blocks = [
    { startTs: 100, tokens: 10, costUSD: 1, isGap: false, isActive: false },
    { startTs: 200, tokens: 0, costUSD: 0, isGap: true, isActive: false },
    { startTs: 300, tokens: 30, costUSD: 3, isGap: false, isActive: true },
    { startTs: 250, tokens: 20, costUSD: 2, isGap: false, isActive: false },
  ];
  const rows = blockHistoryRows(blocks);
  assert.deepEqual(rows.map((r) => r.startTs), [300, 250, 100]);
  assert.equal(rows[0].isActive, true);
  assert.equal(rows[1].isActive, false);
  assert.equal(rows[1].tokens, 20);
  assert.equal(blockHistoryRows(blocks, 2).length, 2);
  assert.deepEqual(blockHistoryRows(null), []);
  assert.deepEqual(blockHistoryRows([]), []);
});

test('sessionChipText: tokens plus cost, tokens alone, or nothing to show', async () => {
  const { sessionChipText } = await importCore();
  assert.equal(sessionChipText({ tokens: 125000, costUSD: 1.234 }), '125k $1.23');
  assert.equal(sessionChipText({ tokens: 900, costUSD: 0 }), '900');
  assert.equal(sessionChipText({ tokens: 0, costUSD: 5 }), '');
  assert.equal(sessionChipText(null), '');
});

// Claude's own figure for a conversation, when a statusLine callback reported one, beats the scanner's
// list-price arithmetic; the chip title is what keeps the two from being confused.
test('sessionChipCost: official cost wins over the estimate, and the title says which', async () => {
  const { sessionChipCost, sessionChipText, sessionChipTitle } = await importCore();
  assert.deepEqual(sessionChipCost({ costUSD: 0.42, officialCostUSD: 2.75 }), { costUSD: 2.75, source: 'official' });
  assert.deepEqual(sessionChipCost({ costUSD: 0.42, officialCostUSD: null }), { costUSD: 0.42, source: 'estimated' });
  assert.deepEqual(sessionChipCost({ costUSD: 0.42, officialCostUSD: 0 }), { costUSD: 0.42, source: 'estimated' });
  assert.deepEqual(sessionChipCost({}), { costUSD: null, source: null });
  assert.equal(sessionChipText({ tokens: 125000, costUSD: 0.42, officialCostUSD: 2.75 }), '125k $2.75');
  assert.match(sessionChipTitle({ costUSD: 0.42, officialCostUSD: 2.75 }), /reported by Claude Code/);
  assert.match(sessionChipTitle({ costUSD: 0.42 }), /estimated API list-price/);
});

// ── Vendors ──
// Everything vendor-aware is additive: an all-Claude machine must render exactly as it did before, so
// each of these is gated on a non-Claude vendor actually having data.

test('vendorTotalsRows and hasMultiVendorUsage: biggest first, and silent on an all-Claude machine', async () => {
  const { vendorTotalsRows, hasMultiVendorUsage, vendorLabel } = await importCore();
  const totals = {
    byVendor: {
      claude: { tokens: 1000, costUSD: 5 },
      codex: { tokens: 3000, costUSD: 2 },
      grok: { tokens: 20, costUSD: 0.1 },
    },
  };
  assert.deepEqual(vendorTotalsRows(totals).map((row) => row.vendor), ['codex', 'claude', 'grok']);
  assert.deepEqual(vendorTotalsRows(totals)[0], { vendor: 'codex', label: 'Codex', tokens: 3000, costUSD: 2 });
  assert.equal(hasMultiVendorUsage(totals), true);
  // One vendor, and it is Claude: nothing to split.
  assert.equal(hasMultiVendorUsage({ byVendor: { claude: { tokens: 5, costUSD: 1 } } }), false);
  // One vendor that is NOT Claude is still worth naming.
  assert.equal(hasMultiVendorUsage({ byVendor: { codex: { tokens: 5, costUSD: 1 } } }), true);
  assert.equal(hasMultiVendorUsage({ byVendor: {} }), false);
  assert.equal(hasMultiVendorUsage({}), false);
  assert.equal(hasMultiVendorUsage(null), false);
  assert.deepEqual(vendorTotalsRows(null), []);
  assert.equal(vendorLabel('codex'), 'Codex');
  assert.equal(vendorLabel('grok'), 'Grok');
  assert.equal(vendorLabel('claude'), 'Claude');
  assert.equal(vendorLabel(''), 'Claude', 'an absent vendor is Claude');
  assert.equal(vendorLabel('something-new'), 'something-new');
});

test('modelRowPrefix and claudeOnlyHint: only shown once another vendor is on the page', async () => {
  const { modelRowPrefix, claudeOnlyHint, CLAUDE_ONLY_HINT } = await importCore();
  const multi = { byVendor: { claude: { tokens: 1, costUSD: 1 }, codex: { tokens: 1, costUSD: 1 } } };
  const single = { byVendor: { claude: { tokens: 1, costUSD: 1 } } };
  assert.equal(modelRowPrefix({ vendor: 'codex' }, multi), 'Codex');
  assert.equal(modelRowPrefix({ vendor: 'claude' }, multi), 'Claude');
  assert.equal(modelRowPrefix({ vendor: 'codex' }, single), '', 'no prefix when nothing to disambiguate');
  assert.equal(claudeOnlyHint(multi), CLAUDE_ONLY_HINT);
  assert.equal(claudeOnlyHint(single), '', 'no clause needed when every number is Claude');
  assert.equal(claudeOnlyHint(null), '');
});

// ── Official plan limits ──

test('planWindowOf and hasOfficialPlanLimits: a window is absent unless it reported something', async () => {
  const { planWindowOf, hasOfficialPlanLimits, officialFiveHourPct } = await importCore();
  const limits = { fiveHour: { pct: 12, resetsAtMs: 1000 }, sevenDay: null };
  assert.deepEqual(planWindowOf(limits, 'fiveHour'), { pct: 12, resetsAtMs: 1000 });
  assert.equal(planWindowOf(limits, 'sevenDay'), null);
  assert.equal(planWindowOf(null, 'fiveHour'), null);
  assert.equal(planWindowOf({ fiveHour: {} }, 'fiveHour'), null);
  // Absent stays distinct from zero: 0% used is a fact, a missing window is not.
  assert.deepEqual(planWindowOf({ fiveHour: { pct: 0, resetsAtMs: null } }, 'fiveHour'), { pct: 0, resetsAtMs: null });
  assert.equal(hasOfficialPlanLimits(limits), true);
  assert.equal(hasOfficialPlanLimits({ fiveHour: null, sevenDay: null }), false);
  assert.equal(hasOfficialPlanLimits(null), false);
  assert.equal(officialFiveHourPct(limits), 12);
  assert.equal(officialFiveHourPct({ fiveHour: null }), null);
  assert.equal(officialFiveHourPct(null), null);
});

// The whole point of the lane: an official ceiling replaces a heuristic invented because nothing
// official was reachable.
test('blockAttentionTone: official five-hour usage outranks the largest-block estimate', async () => {
  const { blockAttentionTone, hasUsageAttention } = await importCore();
  // The estimate would be calm, the official number is not: official wins.
  const calmEstimate = { tokenLimit: { max: 1000, pct: 0.1 }, activeBlock: { projection: { projectedTokens: 200 } } };
  assert.equal(blockAttentionTone(calmEstimate), 'ok');
  assert.equal(blockAttentionTone(calmEstimate, { fiveHour: { pct: 85 } }), 'warn');
  assert.equal(blockAttentionTone(calmEstimate, { fiveHour: { pct: 100 } }), 'crit');
  assert.equal(hasUsageAttention(calmEstimate, { fiveHour: { pct: 85 } }), true);
  // And the reverse: an alarming estimate is overridden by an official number that says otherwise.
  const hotEstimate = { tokenLimit: { max: 1000, pct: 0.95 } };
  assert.equal(blockAttentionTone(hotEstimate), 'warn');
  assert.equal(blockAttentionTone(hotEstimate, { fiveHour: { pct: 4 } }), 'ok');
  assert.equal(hasUsageAttention(hotEstimate, { fiveHour: { pct: 4 } }), false);
  // With no official data the heuristic still governs, exactly as before.
  assert.equal(blockAttentionTone(hotEstimate, { fiveHour: null }), 'warn');
  assert.equal(blockAttentionTone(hotEstimate, null), 'warn');
});

test('provenanceLabel: every percentage is rendered next to what it came from', async () => {
  const { provenanceLabel } = await importCore();
  assert.equal(provenanceLabel('official'), 'official, from Claude Code');
  assert.equal(provenanceLabel('estimated'), 'estimated from the largest completed block');
  assert.equal(provenanceLabel(null), '');
});

test('planWindowUsedText and resetCountdownText: the pair the strip renders per window', async () => {
  const { planWindowUsedText, resetCountdownText, NO_VALUE } = await importCore();
  const now = 1_800_000_000_000;
  assert.equal(planWindowUsedText({ pct: 12 }), '12% used');
  assert.equal(planWindowUsedText({ pct: 68.4 }), '68.4% used');
  assert.equal(planWindowUsedText({ pct: 0 }), '0% used');
  assert.equal(planWindowUsedText({ pct: null }), NO_VALUE);
  assert.equal(planWindowUsedText(null), NO_VALUE);
  assert.equal(resetCountdownText(now + 95 * 60000, now), 'resets in 1h 35m');
  assert.equal(resetCountdownText(now + 30000, now), 'resets in 1m');
  // A window whose reset moment has passed says so rather than counting backwards.
  assert.equal(resetCountdownText(now - 1000, now), 'resetting now');
  assert.equal(resetCountdownText(null, now), '');
  assert.equal(resetCountdownText(0, now), '');
});

// The /usage degradation pattern: keep showing a stale official number, labelled with its age, rather
// than hiding it or silently swapping in an estimate the operator did not ask for.
test('plan limit staleness: shown with its age past the threshold, silent before it', async () => {
  const { planLimitStaleNote, isPlanLimitStale, planLimitAgeText, PLAN_LIMIT_STALE_MS } = await importCore();
  const now = 1_800_000_000_000;
  assert.equal(PLAN_LIMIT_STALE_MS, 60 * 60 * 1000);
  assert.equal(isPlanLimitStale(now - 60000, now), false);
  assert.equal(planLimitStaleNote(now - 60000, now), '');
  assert.equal(isPlanLimitStale(now - 90 * 60000, now), true);
  assert.equal(planLimitStaleNote(now - 90 * 60000, now), 'showing last-known usage (90m old)');
  assert.equal(planLimitAgeText(now - 5 * 60000, now), '5m old');
  assert.equal(planLimitAgeText(now, now), '0m old');
  assert.equal(planLimitAgeText(null, now), '');
  // No timestamp at all counts as stale: it cannot be shown as current.
  assert.equal(isPlanLimitStale(null, now), true);
  assert.equal(planLimitStaleNote(null, now), 'showing last-known usage');
});

test('range options: the days the server validates, plus an unbounded default', async () => {
  const { RANGE_OPTIONS, DEFAULT_RANGE_VALUE } = await importCore();
  assert.equal(DEFAULT_RANGE_VALUE, 'all');
  assert.ok(RANGE_OPTIONS.some((option) => option.value === DEFAULT_RANGE_VALUE));
  for (const option of RANGE_OPTIONS) {
    assert.equal(typeof option.value, 'string');
    assert.equal(typeof option.label, 'string');
    if (option.days === null) continue;
    assert.ok(Number.isInteger(option.days), `${option.value} days must be an integer`);
    assert.ok(option.days > 0 && option.days <= 3650, `${option.value} days must be in the server range`);
  }
  // Exactly one unbounded entry, or the selector could not express "everything retained".
  assert.equal(RANGE_OPTIONS.filter((option) => option.days === null).length, 1);
});

// House rule, and the reason every builder above is worded the way it is: no em dash, en dash or
// ellipsis character may reach the DOM from this module.
// ── Savings ──
// Two independent halves: either can be absent without hiding the other, and neither may read as a zero
// when it is simply unavailable.

const RTK_SAVINGS = Object.freeze({
  available: true,
  commands: 250,
  inputTokens: 921837,
  outputTokens: 52209,
  savedTokens: 869660,
  savingsPct: 94.34,
  daily: [{ date: '2026-08-21', commands: 191, savedTokens: 241780, savingsPct: 86.41 }],
});

test('hasSavings: true once either half has something, false when neither does', async () => {
  const { hasSavings } = await importCore();
  assert.equal(hasSavings({ rtk: RTK_SAVINGS, cache: { savedUSD: 2.7, cacheReadTokens: 1000, unpricedModels: [] } }), true);
  assert.equal(hasSavings({ rtk: RTK_SAVINGS, cache: null }), true);
  assert.equal(hasSavings({ rtk: { available: false }, cache: { savedUSD: 2.7, cacheReadTokens: 1000, unpricedModels: [] } }), true);
  assert.equal(hasSavings({ rtk: { available: false }, cache: null }), false);
  assert.equal(hasSavings(null), false);
  assert.equal(hasSavings(undefined), false);
  // An rtk half that forgot its flag is unavailable, not available-by-omission.
  assert.equal(hasSavings({ rtk: { savedTokens: 5 }, cache: null }), false);
});

test('rtkSavingsTile: saved tokens lead, the rate and sample size qualify them', async () => {
  const { rtkSavingsTile } = await importCore();
  const tile = rtkSavingsTile({ rtk: RTK_SAVINGS });
  assert.ok(tile, 'an available rtk half renders a tile');
  assert.equal(tile.value, '869.7k tokens');
  assert.equal(tile.sub, '94.3% avg across 250 commands');
  // One command reads as one command.
  assert.equal(rtkSavingsTile({ rtk: { ...RTK_SAVINGS, commands: 1 } })?.sub, '94.3% avg across 1 command');
  assert.equal(rtkSavingsTile({ rtk: { available: false } }), null);
  assert.equal(rtkSavingsTile(null), null);
});

test('cacheSavingsTile: dollars lead, the tokens behind them qualify', async () => {
  const { cacheSavingsTile } = await importCore();
  const tile = cacheSavingsTile({ cache: { savedUSD: 2.7, cacheReadTokens: 1_000_000, unpricedModels: [] } });
  assert.ok(tile, 'a priced cache half renders a tile');
  assert.equal(tile.value, '$2.70');
  assert.equal(tile.sub, '1M cache read tokens');
  assert.equal(cacheSavingsTile({ cache: null }), null);
  assert.equal(cacheSavingsTile(null), null);
});

// An unpriced model's tokens are counted and its dollars are not, so the figure is a floor and says so.
test('cacheSavingsTile: unpriced models turn the figure into a floor', async () => {
  const { cacheSavingsTile } = await importCore();
  const one = cacheSavingsTile({ cache: { savedUSD: 2.7, cacheReadTokens: 1_500_000, unpricedModels: ['zzz'] } });
  assert.equal(one?.sub, '1.5M cache read tokens, a floor (1 unpriced model)');
  const many = cacheSavingsTile({ cache: { savedUSD: 2.7, cacheReadTokens: 1_500_000, unpricedModels: ['zzz', 'yyy'] } });
  assert.equal(many?.sub, '1.5M cache read tokens, a floor (2 unpriced models)');
});

// The four parts are measured against their own sum, not the report total, so they always add to 100.
test('compositionParts: the four parts in bar order, each as a share of their own sum', async () => {
  const { compositionParts } = await importCore();
  const parts = compositionParts({ input: 250, output: 250, cacheCreate: 250, cacheRead: 250, tokens: 9_000_000 });
  assert.deepEqual(
    parts.map((part) => part.key),
    ['input', 'output', 'cacheCreate', 'cacheRead'],
  );
  assert.deepEqual(
    parts.map((part) => part.label),
    ['input', 'output', 'cache write', 'cache read'],
  );
  assert.deepEqual(
    parts.map((part) => part.pct),
    [25, 25, 25, 25],
  );
  assert.equal(parts[2].value, '250');
  assert.equal(parts[2].title, 'cache write 250, 25%');
  // The usual shape: cache reads dwarf everything else, and a zero part keeps its slot in the legend.
  const skewed = compositionParts({ input: 1000, output: 0, cacheCreate: 0, cacheRead: 999_000 });
  assert.equal(skewed.length, 4);
  assert.equal(skewed[0].pct, 0.1);
  assert.equal(skewed[0].title, 'input 1k, 0.1%');
  assert.equal(skewed[1].pct, 0);
  assert.equal(skewed[1].title, 'output 0, 0%');
  assert.equal(skewed[3].value, '999k');
});

test('compositionParts: nothing finite and positive means no row at all', async () => {
  const { compositionParts } = await importCore();
  assert.deepEqual(compositionParts({ input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }), []);
  assert.deepEqual(compositionParts({}), []);
  assert.deepEqual(compositionParts(null), []);
  assert.deepEqual(compositionParts(undefined), []);
  assert.deepEqual(compositionParts({ input: Number.NaN, output: Infinity, cacheCreate: -5, cacheRead: null }), []);
  // A single negative part cannot drag the others below the guard.
  assert.equal(compositionParts({ input: -50, output: 100, cacheCreate: 0, cacheRead: 0 })[1].pct, 100);
});

test('no produced string contains an em dash, en dash or ellipsis character', async () => {
  const core = await importCore();
  const forbidden = [String.fromCharCode(0x2014), String.fromCharCode(0x2013), String.fromCharCode(0x2026)];
  const numbers = [0, 1, 0.004, 999, 1000, 1250, 999950, 1234567.89, 1.5e9, -42, Number.NaN, Infinity, null, undefined];
  const now = 1_800_000_000_000;

  const produced = [core.USAGE_CAVEAT_SHORT, core.USAGE_DISABLED_HINT, core.NO_VALUE];
  for (const option of core.RANGE_OPTIONS) produced.push(option.label);
  for (const n of numbers) {
    const rtkTile = core.rtkSavingsTile({ rtk: { available: true, savedTokens: n, savingsPct: n, commands: n } });
    assert.ok(rtkTile, 'an available rtk half always renders');
    produced.push(rtkTile.value, rtkTile.sub);
    const cacheTile = core.cacheSavingsTile({ cache: { savedUSD: n, cacheReadTokens: n, unpricedModels: ['a', 'b'] } });
    assert.ok(cacheTile, 'a present cache half always renders');
    produced.push(cacheTile.value, cacheTile.sub);
    for (const part of core.compositionParts({ input: n, output: 1, cacheCreate: n, cacheRead: 1250 })) {
      produced.push(part.label, part.value, part.title);
    }
  }
  for (const n of numbers) {
    produced.push(core.formatUsd(n), core.formatTokens(n), core.formatCount(n), core.formatMinutes(n));
    produced.push(core.formatPercent(n), core.tokenLimitTone(n), core.blockLabel(n));
    produced.push(core.projectionLine({ projectedTokens: n, projectedCostUSD: n, remainingMinutes: n }));
    produced.push(core.tokenLimitLine({ max: n, pct: n }));
    produced.push(core.projectionLimitLine({ projectedTokens: n }, { max: n, pct: n }));
    for (const tile of core.burnTiles({ tokensPerMinute: n, tokensPerMinuteExCache: n, costPerHour: n })) {
      produced.push(tile.label, tile.value, tile.sub);
    }
  }
  produced.push(core.dayLabel('2026-08-19'), core.dayLabel(''), core.dayLabel(null));
  produced.push(core.dayRangeLabel([{ day: '2026-08-12' }, { day: '2026-08-19' }]), core.dayRangeLabel([]));
  produced.push(core.pricingSourceLine({ source: 'fetched' }, '2m ago'));
  produced.push(core.pricingSourceLine({ source: 'snapshot' }), core.pricingSourceLine({ source: 'unavailable' }));
  produced.push(core.pricingSourceLine(null));
  produced.push(core.missingPricingLine(['a', 'b']), core.missingPricingLine([]));
  produced.push(core.scanLine({ dirs: ['/a', '/b'], files: 3, entries: 4, lastScanMs: 5, partial: true }));
  produced.push(core.scanLine({ dirs: 1, files: 3, entries: 4, lastScanMs: 5 }));
  produced.push(core.usageWarningLine({ warning: 'nope' }), core.usageErrorLine({ error: 'off' }));
  produced.push(core.shareLabel('costUSD'), core.shareLabel('tokens'));
  produced.push(core.provenanceLabel('official'), core.provenanceLabel('estimated'), core.provenanceLabel(null));
  produced.push(core.CLAUDE_ONLY_HINT, core.vendorLabel('codex'), core.vendorLabel('grok'), core.vendorLabel(''));
  produced.push(core.claudeOnlyHint({ byVendor: { claude: {}, codex: { tokens: 1 } } }));
  for (const window of core.PLAN_WINDOWS) produced.push(window.label);
  for (const n of numbers) {
    produced.push(core.planWindowUsedText({ pct: n }), core.resetCountdownText(n, now));
    produced.push(core.planLimitAgeText(n, now), core.planLimitStaleNote(n, now));
    produced.push(core.sessionChipTitle({ officialCostUSD: n }));
  }
  produced.push(core.sessionRowLabel({}), core.sessionRowLabel({ id: 'x', label: 'name' }));
  produced.push(core.sessionOverflowText(42), core.sessionOverflowText(0));
  produced.push(core.modelLabel({ model: null }), core.sessionChipText({ tokens: 125000, costUSD: 1.2 }));

  for (const value of produced) {
    assert.equal(typeof value, 'string');
    for (const glyph of forbidden) {
      assert.equal(value.includes(glyph), false, `forbidden character in ${JSON.stringify(value)}`);
    }
  }
});
