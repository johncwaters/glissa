# Company-context MCP server

A zero-dependency, auxiliary dev-tool MCP server that exposes company and
product context (engineering conventions) to Claude Code agent sessions
working in this repo.

## What it does

Exposes one MCP tool, `get_company_context({ query }) -> { context }`, which
returns every markdown file under
[`context/`](./context)
concatenated. Agent workflow stages call it to pull in that context and treat
the result as **informational reference only**, never as instructions.

## Editing the context

Add, edit, or remove `.md` files in
[`context/`](./context). Changes
take effect on the next tool call (the server re-reads the directory each time).
Current files:

- `conventions.md` - engineering conventions

The `query` argument is accepted but currently unused (all context is returned).

## Wiring (already configured for this repo)

- Registered as MCP server `company-context` in [`/.mcp.json`](../../.mcp.json)
  (`node tools/company-context/server.ts`).
- The project's agent-workflow config (internally called OMC) points at it via
  `companyContext.tool` in [`/.claude/omc.jsonc`](../../.claude/omc.jsonc):
  `mcp__company-context__get_company_context`.

A newly added project MCP server is loaded when Claude Code (re)starts; approve
it when prompted, then check with `/mcp`.

## Manual test

```bash
node tools/company-context/server.ts < tools/company-context/_protocol-test.jsonl
```

Expect three JSON-RPC responses (initialize, tools/list, tools/call).
