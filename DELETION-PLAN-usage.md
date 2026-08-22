# Usage lane deletion plan

The lane is ~5,600 source lines plus ~5,850 test lines to render one dashboard tab of token and cost
statistics over local transcripts. The base job (scan Claude transcripts, dedup, price, aggregate, show
blocks and per-card chips) is maybe a third of that. The rest is six accreted features, each of which
added a core, a wiring branch, a config knob, a UI section and a test file.

The rule applied below: delete the features whose line cost is worst against what an operator can act on,
and prefer removing a whole feature over shaving every file. A number an operator cannot act on is not
worth a core module, and a number the lane itself documents as unbillable is worth even less.

## Features deleted

| Feature | Why it is not worth its weight |
|---|---|
| Multi-vendor parsing (Codex CLI, Grok CLI) | Two more transcript formats, two dedup identity rules, per-file vendor carry state, four root resolvers and a whole "Claude only" hint apparatus, so that a tab about Claude Code can also print an estimate for CLIs whose billing Glissa cannot see; removing it makes the remaining pipeline simpler, not just shorter. |
| Durable warehouse (day-by-model history) | A second storage format, a merge/prune/rollup core and a live-wins layering rule, all to extend one table past Claude's ~30 day transcript retention; the lane already reports estimates, and remembering older estimates is not a decision anyone makes. |
| Spend budgets (ceilings, 50/75/100 ladder, alerts) | An alert ladder with durable fired state, a Telegram delivery path and two meters, all firing on a number the panel's own caveat calls "not a bill"; the official plan limits are the real ceiling and they are kept. |
| Anomaly detection (daily + burn) | ~210 lines of trailing baselines to print one sentence comparing today to a 30 day mean, on a series short enough for the operator to read directly off the table beneath it. |
| Savings estimates (rtk gain + prompt cache) | Two tiles the code itself qualifies away: rtk's half counts machine-wide work Glissa never did, the cache half prices tokens against a list price nobody was billed. A number with two disclaimers is not a number. |
| Calendar heatmap + week/month period views | ~660 lines of client rollup and a 112-cell grid over a daily table that is already on the page; without the warehouse the window is mostly unobserved days anyway. |

## Features kept

Claude transcript scan with incremental offsets and dedup (ccusage parity), pricing (snapshot + optional
LiteLLM fetch), totals / daily / by-model / by-session rollups, 5h blocks with burn rate, projection and
the largest-block token-limit heuristic, official plan limits via the statusLine relay (including its
chaining of the operator's own statusLine), per-card usage chips with Claude's official per-conversation
cost, and Glissa lane attribution (`byLane`) -- the one answer a transcript reader cannot give, and whose
ledger the ingest lane already depends on.

## What dies, file by file

Deleted outright: `server/core/usage-{codex,grok,warehouse,budget,anomaly,savings}-core.js` and their
test files, plus `tests/usage-{scanner-vendors,warehouse-wiring,budget-wiring,savings-wiring}.test.js`
and `tests/frontend-usage-periods.test.js` (its surviving lane assertions move to the lane test).

Folded or trimmed:
- `server/usage-scanner.js`: vendor roots/walk/state, warehouse persist+merge, `budgetSpend`,
  `buildBudget`, `buildAnomaly`, `entryRetentionDays` widening, `isClaudeEntry` filters.
- `server/usage-wiring.js`: budget state file, alert text and Telegram delivery, rtk exec + TTL cache,
  `buildSavings`, the `rtkSavings` / `budget` / `vendors` / `warehouseRetainDays` config keys.
- `server/core/usage-aggregate-core.js`: `byVendor` totals, per-row `vendor` / `vendors`.
- `server/core/usage-scan-core.js`: the whole "other vendors" half.
- `public/usage-view-core.mjs`: savings, budget, anomaly, period rollup, heatmap, vendor and history
  sections (~450 lines).
- `public/usage-panel.js`: the matching sections and the period switch (~180 lines).
- `public/components/settings-dialog.html`, `public/dialogs.js`, `server/control-handlers.js`: vendor and
  budget fields, `rtkSavings` boolean.
- `server/backend.js`: `warehousePath` / `budgetStatePath` wiring.
- `server/data/claude-pricing.json`: the 43 openai gpt-5 entries Codex needed.
- `AGENTS.md`: the Usage Tracking section shrinks to the kept behavior.

## Expected delta

Roughly -2,000 source lines and -2,300 test lines, about -4,300 net.
