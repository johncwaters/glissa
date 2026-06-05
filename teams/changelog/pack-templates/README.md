# Changelog team pack

This folder is your project's. Glissa owns the agents (the pipeline roles); this pack owns the specifics the
agents read on every run.

On the first run of this team in a repo, glissa copies these templates into
`.glissa/teams/changelog/pack/` and then halts. Replace the `GLISSA:NEEDS-INPUT` markers in each file with
this project's real content, then run the team again.

Files:

- `changelog-config.md` where the changelog file is, its format and section convention, the versioning and
  ordering rules, the range to reconcile, and what counts as user-facing.
- `style-guide.md` how entries should read and the words the project never uses. The Auditor audits every
  edited changelog against it.
- `announce-config.md` the release title and tag convention, the announcement channel(s), the announcement
  voice, and an avoid-list. The Announcer reads it on a SHIP to draft a release announcement from the
  curated changelog. A "GitHub release body only" default makes it quick to fill.

Commit the filled `pack/` with your repo. Each run's output under `runs/` and the run log `log.md` are
written and, in a git repo, committed back automatically by the run, which executes in an isolated worktree
that fast-forwards into your branch. On a SHIP verdict the run also commits the edited changelog file itself,
bounded by the team's writeScope.
