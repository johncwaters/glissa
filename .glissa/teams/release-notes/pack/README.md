# Release-notes team pack

This folder is your project's. Glissa owns the agents (the pipeline roles); this pack owns the specifics
the agents read on every run.

On the first run of this team in a repo, glissa copies these templates into
`.glissa/teams/release-notes/pack/` and then halts. Replace the `GLISSA:NEEDS-INPUT` markers in each file
with this project's real content, then run the team again.

Files:

- `release-config.md` how to find a release and the range, what counts as user-facing, the audience, and
  the publisher's repo / release-title / announcement-channel settings.
- `voice-guide.md` how the release notes should sound. The Editor audits every document against it.
- `avoid-list.md` words and phrases the project never uses.

Commit the filled `pack/` with your repo. Each run's output under `runs/` and the run log `log.md` are
written and, in a git repo, committed back automatically by the run (it executes in an isolated worktree
that fast-forwards into your branch), so you do not manage them by hand.
