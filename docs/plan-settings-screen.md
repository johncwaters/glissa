# Plan: Settings Screen

Status: proposal, 2026-08-25. Research only, nothing implemented.

## Why

The settings dialog (`public/components/settings-dialog.html`, `public/dialogs.js:168`) is a 560px modal with 11 horizontal tabs and roughly 80 controls. It was designed for five tabs (`DESIGN.md`, "Settings Dialog (tabbed)"). Since then PR Review, Visions, Mill, PostHog and Usage each landed as a tab, and each tab is now a long form of numbers whose ranges live only in server cores. Three concrete costs:

- Discoverability. A tab strip stops working past about seven entries; the strip already scrolls with a hidden scrollbar. Nothing is searchable, nothing is linkable, and the dashboard cannot point at a setting from where its effect shows (a Mill delivery row, a usage budget alert, a PR lane error).
- Scope confusion. Machine-wide keys (`repoRoots`, `port`), lane keys (`prReview`, `visions`, `posthog`), per-project keys (packs, `codexBypassHookTrust`, `agent`) and per-viewer preferences (theme, sound) sit in one dialog with one Save, while per-project settings actually live in the Mill view and the Add Session dialog.
- Invisible config. About twenty keys are config-file only (`detectBackgroundAgents`, `worktreeAutoRebase`, `branchGc`, `postTurnChecks`, `remote`, ingest ring sizes) with no place in the UI that even names them, so an operator cannot tell "not a setting" from "not surfaced".

`DESIGN.md` already says: "Don't reach for a modal when an inline or progressive disclosure will do."

## Inspiration: PostHog settings

Fetched from `frontend/src/scenes/settings/` at `master` (SettingsMap.tsx, types.ts, Settings.tsx, settingsSceneLogic.ts, flagGating.ts, urls.ts). The patterns that matter, in the order they pay off:

1. One declarative map. `SettingsMap.tsx` is 55 sections and 173 settings; navigation, search index, URL routing, deep links and gating all derive from it. Setting and section ids are string-literal unions, so a typo is a compile error.
2. Sidebar plus long scrolling page, never tabs. Selecting a section renders all of its settings stacked with an `id` anchor per heading; the URL is `/settings/<section-id>#<setting-id>`, and every heading has a copy-link button.
3. Search lives in the sidebar header and replaces the nav tree while typing. The index is weighted title > keywords > section > description at a strict threshold. 167 settings carry a `keywords` array of synonyms the title omits; this is the cheapest recall win in the file.
4. Levels. Every section has a level (environment, project, organization, account); the level prefixes the section id and the nav groups by it.
5. Declarative gating: `flag`, `hideOn` (cloud vs self-host), `hideFromNavigation`, `hideWhenNoSection`, `accessControl`. No conditionals in the renderer.
6. "Configured elsewhere" sections carry `to:` instead of settings and render in the nav with an external icon, so a thing still shows up in search even when it lives on another screen.
7. Danger zone is a section per level, forced last in the nav regardless of map order. GitHub adds typed confirmation on each irreversible action.
8. Each setting renders inside its own error boundary; one broken control cannot blank the page.
9. An alias map redirects renamed sections and never-valid-but-intuitive ids with `replace`, so old links never die.

Also noted: Vercel splits scope owner (team vs project) into separate URL trees and treats a version-controlled file as co-author of the dashboard, which is the closest analogue to Glissa's `config.json`. Grafana mirrors `grafana.ini` only partially and says so.

## Proposal

### 1. Settings becomes a primary view, not a modal

Add `#view-settings` as a seventh view in the header tab strip (`public/index.html:151`, `activateView` at `public/app.js:545`) and a "Settings" destination in the phone More sheet (`public/phone/phone-shell.js:35`). It follows the house shape: `public/settings-panel.js` (DOM, control WS) over `public/settings-view-core.mjs` (pure, headless tests), exactly like `mill-panel.js` over `mill-view-core.mjs`.

The header menu `#btn-settings` and the `?` button keep working: they call `activateView('settings', { section })`. The modal (`createSettingsDialog`) is deleted once the view ships, not kept as a second surface.

Phone: the view is re-parented whole via `adoptElement`, like every other panel; the sidebar collapses to a section picker at the top (a select or a horizontal chip row) with the same anchored scroll underneath.

### 2. One declarative settings map

`public/settings-map.mjs` is the single source. Shape, kept to what Glissa needs:

```js
{
  id: 'lanes-pr-review',
  level: 'lanes',
  title: 'PR review',
  description: 'Reviews your own open pull requests with a headless session and merges only behind a hard gate.',
  settings: [
    {
      id: 'pr-review-enabled',
      path: 'prReview.enabled',
      title: 'Enable PR auto-review',
      description: 'Inert until Telegram is also configured.',
      control: 'toggle',
      keywords: ['github', 'pull request', 'merge', 'auto merge'],
      danger: true,
    },
    { id: 'pr-review-poll', path: 'prReview.pollIntervalMinutes', control: 'number', range: 'PR_REVIEW_POLL_RANGE' },
  ],
}
```

Everything else derives from it: the sidebar, the search index, the anchor ids, the `get-settings` hydration (walk `path`), the `update-settings` payload (only dirty paths, grouped by top-level block), and the file-only listing. `tests/frontend-settings-map.test.js` pins that every `path` exists in `DEFAULT_CONFIG` or the Mill allow-list, that no two settings share an id, and that every number control names a range.

Ranges stop being duplicated as HTML `min`/`max`. The numeric ranges the server clamps with (`MEMORY_RETAIN_DAY_RANGE`, `INTERVAL_MINUTES_RANGE`, `PR review` bounds, usage bounds) move to `shared/settings-ranges.js`, the CJS plus ESM dual-loaded home that `shared/notification-states.js` already uses, so the wire bound and the rendered bound are one constant. `tests/settings-mill-core.test.js` already asserts "wire bounds match the resolver clamps"; that assertion extends to the shared file.

### 3. Levels

Four levels, in nav order:

| Level | Sections | Persisted where |
|---|---|---|
| This browser | Appearance (theme, sound, desktop notifications), Terminal (cursor blink), Shortcuts | `ui-prefs` in localStorage; no WS write |
| Machine | General (auto-resume, updates, debug), Detection and sessions (file-only rows named), Repositories, Notifications (Telegram), Usage | `config.json` top-level keys via `update-settings` |
| Lanes | PR review, Visions, PostHog, Mill (packs, distiller, memory, ingest) | `config.json` blocks via `update-settings` |
| Projects | One page per configured project: packs (the existing `set-project-packs` delta), agent, default permission mode, `codexBypassHookTrust` (read-only, file-only) | `set-project-packs`; the rest read-only until a control message exists |

The level tag renders beside every section title, PostHog style, so the operator always sees whether a change is per browser, per machine, per lane or per project.

### 4. File-only keys become visible, not editable

A setting with `fileOnly: true` renders as a read-only row: title, description, the `config.json` key path in mono, and a "Configured in config.json" caption. It is in the search index and in the nav. This is PostHog's `to:` pattern pointed at a file instead of a route.

Boundaries that stay exactly as they are:

- `remote` is never listed, never echoed, never named in the map (`tests/control-settings-remote.test.js`).
- Memory paths, record contents and lane log lines never cross the control WS; the read-only row shows the key NAME from the static map and no value (`tests/memory-delivery-negative.test.js`). The map holds only key names, which are already public in `DEFAULT_CONFIG`.
- The Mill allow-list (`server/core/settings-mill-core.js`) stays the write gate; the map cannot add a writable path the server refuses, and the test in section 2 makes that a build failure rather than a runtime `settings-error`.

### 5. Search

Search box at the top of the sidebar. Typing replaces the nav with a flat result list grouped by section with the level in parens, Enter jumps to the setting anchor and flashes the row. Scoring is a pure function in `settings-view-core.mjs`: exact title token match > keyword match > section title > description, no fuzzy library (no new dependencies). Every setting in the map carries `keywords`; the map test refuses a setting with fewer than two.

### 6. Deep links

`#settings/<section-id>/<setting-id>` in the location hash, mirroring how the active view is already persisted. Each setting heading gets a copy-link button. Consumers that should link in from day one:

- The Mill view delivery rows (link to `lanes-mill#packs-auto-rebuild`).
- The usage budget alert (link to `machine-usage#daily-budget`).
- A lane's disabled banner ("PR review is off", link to its enable toggle).
- `glissa doctor` output can print the same ids.

A small alias table maps the old tab names (`telegram`, `posthog`, `mill`) to section ids so any bookmark or doc written against the tabs keeps resolving.

### 7. Save model

Keep the wire contract (`get-settings`, `update-settings`, `settings-updated`, `settings-error`) untouched; every existing test in `tests/control-settings*.test.js` keeps passing without edits.

Change the client from "one Save for the whole dialog" to a sticky per-section footer that appears only when that section is dirty, sends only the dirty top-level blocks, and clears on `settings-updated`. This drops the "send every boolean" behaviour that `isUnchosenLaunchDefault` (`server/config-store.js:524`) exists to defend against, and it lets an `settings-error` land on the section that caused it instead of a shared footer.

Browser-level settings save immediately with no footer, since they never leave the tab.

### 8. Danger zone

One "Unattended actions" section, forced last in the Lanes level, holding the settings that let code act without a carbon unit in the loop: PR auto-merge (`prReview.enabled` plus merge method), Visions tier-1 fixes (`visions.autoFix`), PostHog fixes (`posthog.autoFix`), rtk self-install. Each is a toggle with an amber full-border warning block (the existing warning hint style) stating the consequence in one sentence, and enabling one requires typing the project or lane name, GitHub style. The section renders under the same anchors so the toggles are not duplicated; the lane page shows a read-only "enabled in Unattended actions" line with a link.

### 9. Status where the setting is

Read-only status next to the control it explains: Telegram gets a "Send test message" button and the last outbox result, Usage keeps its last-report block, rtk shows availability and install state, Mill shows last distill and last memory run. These already exist as scattered payload fields (`rtkAvailable`, `rtkInstall`, `#settings-usage-status`); the map gives each a `status` slot rendered from the `settings` payload.

## What stays out

- No autosave on machine or lane keys; a mistyped bot token or a half-typed repo root must not persist mid-keystroke.
- No permission mode toggle for a running session; it stays a spawn-time choice in Add Session.
- No `remote` editing from the dashboard, ever.
- No new dependencies (search is hand-rolled).

## Phasing

1. Map and core. `settings-map.mjs`, `settings-view-core.mjs` (search scoring, dirty tracking, hydrate and diff by path), `shared/settings-ranges.js`, tests. The old dialog keeps rendering from its HTML during this phase.
2. View. `settings-panel.js`, `#view-settings`, sidebar, anchored sections, per-section save, phone re-parenting. Header menu and `?` route into it. Delete `settings-dialog.html` and `createSettingsDialog`.
3. Search, deep links, alias table, copy-link buttons; convert the Mill and usage callers to link in.
4. Levels polish: Projects level, file-only rows, Unattended actions with typed confirmation, inline status slots.

Each phase lands green on `npm test` with `tests/control-settings*.test.js` untouched.
