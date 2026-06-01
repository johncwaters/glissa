# Teams

Glissa owns the **agents** (the pipeline roles); each project owns its **pack** (the specifics). A team
runs against any repo: point it at a project, and on the first run glissa scaffolds a pack into that
repo and halts until you fill it.

## A team definition (glissa-owned)

```
teams/_shared/
  agents/<role>.md     # reusable brand-neutral role prompts (researcher, strategist, writer, editor, publisher)
  pack-templates/<f>   # reusable pack scaffolds copied into a project on first run
teams/<id>/
  team.json            # id, outputPath, schedule, permissions.deny, pack.required, stages
  agents/<stage>.md    # OPTIONAL per-team override of a role prompt (else the shared role is used)
  pack-templates/<f>   # OPTIONAL per-team pack scaffolds (else the shared ones are used)
```

New teams are built from the **shared blocks**, not from scratch: name a stage after a shared role and it
reuses `teams/_shared/agents/<id>.md` automatically. A team usually needs only its own `team.json` plus
its project pack.

`team.json` fields:

- `outputPath` everything glissa writes in a target repo, conventionally `.glissa/teams/<id>`.
- `pack.required` the pack files a run needs (defaults to the five content files if omitted).
- `stages[]` ordered roles. Each: `id`, `model`, `produces`, optional `reads`, `requiredSections`,
  `verdict`, `runIfVerdict`, `haltSignal`, `agent`, `reviseReads`, `revise`.
  - `agent` reuse a shared role prompt by name. Resolution order: explicit `agent`
    (`_shared/agents/<agent>.md`) > team-local `agents/<id>.md` > shared `_shared/agents/<id>.md`.
  - `reviseReads` extra handoff files this stage reads only on a FIX revision re-run (round >= 1),
    unioned with `reads`.
  - `revise` `{ onVerdict, stages, maxRounds }` on a verdict stage: when the verdict equals `onVerdict`
    (e.g. `FIX`), re-run the listed earlier `stages` then re-audit, up to `maxRounds` times.

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
4. FIX revision loop: on a `FIX` verdict the writer is re-run with the editor's FIX list (its `review.md`)
   plus its prior `drafts.md`, then the editor re-audits, up to `revise.maxRounds` times. Each round's
   prior `drafts.md`/`review.md` are archived under `runs/<id>/rounds/r<n>-*`. The loop stops on `SHIP`
   (the publisher then runs), `BLOCK`, no measurable progress, or the round budget. The publisher still
   runs ONLY on a final `SHIP`.
5. The run is committed and fast-forwarded back to the base branch (kept on its own branch if the base
   moved); a cancelled run's worktree is discarded.
