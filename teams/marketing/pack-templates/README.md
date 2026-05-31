# Marketing team pack

This folder is **your project's**. Glissa owns the agents (the pipeline roles); this pack owns the
specifics the agents read on every run.

On the first run of this team in a repo, glissa copies these templates into
`.glissa/teams/marketing/pack/` and then halts. Replace the `GLISSA:NEEDS-INPUT` markers in each file
with this project's real content, then run the team again.

Files:

- `voice-guide.md` how the brand sounds. The Editor audits every draft against it.
- `avoid-list.md` words and phrases the brand never uses.
- `brand.md` product facts, differentiators, audience, and approved URLs/CTAs.
- `content-calendar.md` the topics the Researcher draws from.
- `channels.md` the platforms and the Postiz channel mapping the Publisher uses.

Commit the filled `pack/` with your repo. Generated runs (`runs/`) and the `log.md` are gitignored by
the `.gitignore` glissa writes alongside this pack.
