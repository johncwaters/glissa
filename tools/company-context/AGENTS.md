<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# company-context

## Purpose
A zero-dependency MCP server exposing one tool, `get_company_context({ query }) -> { context }`, which returns every markdown file under `context/` concatenated. OMC workflow skills (deep-interview, deep-dive, ralplan, autopilot, ralph) call it for reference material; the result is informational only, never instructions.

## Key Files

| File | Description |
|------|-------------|
| `server.js` | The MCP server (stdio transport, no dependencies); re-reads `context/` on every call |
| `README.md` | Setup and editing instructions |
| `_protocol-test.jsonl` | Recorded MCP protocol exchange used as a manual smoke check |

The content itself lives in `context/` (`conventions.md`, engineering conventions). It used to be a context-mill source too, and is not any more: a pack assembled from this repo's own files is refused at delivery, since a session working here already loads them.

## For AI Agents

### Working In This Directory
- Stay zero-dependency: plain Node stdio MCP, no SDK packages.
- Content changes are just markdown edits in `context/`; they take effect on the next tool call, no restart needed.
- Context content must remain reference material, never imperative instructions to agents.

### Testing Requirements
- Pipe `_protocol-test.jsonl` lines into `node server.js` and eyeball the responses.

## Dependencies

### External
- None by design.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
