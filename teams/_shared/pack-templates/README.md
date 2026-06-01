# Marketing team pack

This folder is **your project's**. Glissa owns the agents (the pipeline roles); this pack owns the
specifics the agents read on every run.

On the first run of this team in a repo, glissa copies these templates into
`.glissa/teams/marketing/pack/` and then halts. Replace the needs-input placeholder markers in each file
with this project's real content, then run the team again.

Files:

- `voice-guide.md` how the brand sounds. The Editor audits every draft against it.
- `avoid-list.md` words and phrases the brand never uses.
- `brand.md` product facts, differentiators, audience, and approved URLs/CTAs.
- `content-calendar.md` the topics the Researcher draws from.
- `channels.md` the platforms and the Postiz channel mapping the Publisher uses.

Commit the filled `pack/` with your repo. Each run's output under `runs/` and the run log `log.md` are
written and, in a git repo, committed back automatically by the run (it executes in an isolated
worktree that fast-forwards into your branch), so you do not manage them by hand.
