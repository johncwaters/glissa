# Teams

Glissa owns the **agents** (the pipeline roles); each project owns its **pack** (the specifics). A team
runs against any repo: point it at a project, and on the first run glissa scaffolds a pack into that
repo and halts until you fill it.

## A team definition (glissa-owned)

```
teams/<id>/
  team.json            # id, outputPath, schedule, permissions.deny, pack.required, stages
  agents/<stage>.md    # one generic role prompt per stage (brand-neutral)
  pack-templates/<f>   # the files copied into a project's pack on first run
```

`team.json` fields:

- `outputPath` everything glissa writes in a target repo, conventionally `.glissa/teams/<id>`.
- `pack.required` the pack files a run needs (defaults to the five content files if omitted).
- `stages[]` ordered roles. Each: `id`, `model`, `produces`, optional `reads`, `requiredSections`,
  `verdict`, `runIfVerdict`, `haltSignal`.

Agent prompts are **project-agnostic**: they read this project's specifics from the pack at run time.
Do not put one project's brand, URLs, or voice in an agent prompt.

## A project pack (project-owned)

On the first run in a repo, glissa copies `pack-templates/` into
`<repo>/<outputPath>/pack/` and halts (`team-run-needs-setup`). Fill each file in one of two ways:

- **Guided (recommended):** click **"Set up automatically"** on the team's setup banner. Glissa opens
  an interactive Claude session (a terminal card) that reads the repo, interviews you for the
  subjective fields, and writes every pack file, removing the `GLISSA:NEEDS-INPUT` markers. When the
  session exits, glissa re-checks the pack (`team-pack-updated`) and the banner clears.
- **By hand:** open each scaffolded file under `<repo>/<outputPath>/pack/` in your editor and replace
  its `GLISSA:NEEDS-INPUT` markers with that project's real content. The banner's status (the list of
  unfilled files) reflects your edits on the next check.

Then run again. Commit the filled pack with the repo. Runs execute in an isolated git worktree and are
committed back to the run history; the pack is copied into the worktree so the agents can read it.

## How a run flows

1. Setup gate (main repo): scaffold the pack, halt if any required file is unfilled. Fill it with
   "Set up automatically" (a guided interview session) or by hand, then re-run.
2. Isolated worktree created from HEAD; the pack is copied in.
3. Stages run in order as headless `claude -p` sessions, each gated on its handoff file's required
   sections; the editor emits a `SHIP` / `FIX` / `BLOCK` verdict.
4. The run is committed and fast-forwarded back to the base branch (kept on its own branch if the base
   moved); a cancelled run's worktree is discarded.
