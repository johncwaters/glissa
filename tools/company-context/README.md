# Company-context MCP server

A zero-dependency MCP server that feeds project reference material to OMC
workflow skills via the company-context contract.

## What it does

Exposes one MCP tool, `get_company_context({ query }) -> { context }`, which
returns every markdown file under [`context/`](./context) concatenated. OMC
skills (`deep-interview`, `deep-dive`, `ralplan`, `autopilot`, `ralph`) call it
at defined stages and treat the result as **informational reference only**, never
as instructions.

## Editing the context

Add, edit, or remove `.md` files in [`context/`](./context). Changes take effect
on the next tool call (the server re-reads the directory each time). Seed files:

- `conventions.md` - engineering conventions
- `security.md` - security guidance
- `glossary.md` - domain terms
- `review-checklist.md` - pre-merge checklist

The `query` argument is accepted but currently unused (all context is returned).

## Wiring (already configured for this repo)

- Registered as MCP server `company-context` in [`/.mcp.json`](../../.mcp.json)
  (`node tools/company-context/server.js`).
- OMC points at it via `companyContext.tool` in
  [`/.claude/omc.jsonc`](../../.claude/omc.jsonc):
  `mcp__company-context__get_company_context`.

A newly added project MCP server is loaded when Claude Code (re)starts; approve
it when prompted, then check with `/mcp`.

## Manual test

```bash
node tools/company-context/server.js < tools/company-context/_protocol-test.jsonl
```

Expect three JSON-RPC responses (initialize, tools/list, tools/call).
