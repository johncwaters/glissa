<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# company-context

## Purpose
A zero-dependency MCP server exposing one tool, `get_company_context({ query }) -> { context }`, which returns every markdown file under `../../packs/sources/company-context/` concatenated. OMC workflow skills (deep-interview, deep-dive, ralplan, autopilot, ralph) call it for reference material; the result is informational only, never instructions.

## Key Files

| File | Description |
|------|-------------|
| `server.js` | The MCP server (stdio transport, no dependencies); re-reads the shared source dir on every call |
| `README.md` | Setup and editing instructions |
| `_protocol-test.jsonl` | Recorded MCP protocol exchange used as a manual smoke check |

The content itself lives in `../../packs/sources/company-context/` (`conventions.md`, `security.md`, `glossary.md`, `review-checklist.md`), because the context mill builds a pack from those same files; see `packs/AGENTS.md`. One source of truth, two consumers.

## For AI Agents

### Working In This Directory
- Stay zero-dependency: plain Node stdio MCP, no SDK packages.
- Content changes are just markdown edits in `packs/sources/company-context/`; they take effect on the next tool call, no restart needed (a pack rebuild is separate, `glissa pack build company-context`).
- Context content must remain reference material, never imperative instructions to agents.

### Testing Requirements
- Pipe `_protocol-test.jsonl` lines into `node server.js` and eyeball the responses.

## Dependencies

### External
- None by design.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
