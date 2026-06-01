## Glissa Teams: Marketing Pipeline Design

A four-agent marketing pipeline that researches, plans, writes, and edits Milepost marketing content on a schedule. Built as a reusable "team" inside Glissa. The shape borrows from the Planner, Coder, Tester, Reviewer pattern used in agentic coding, adapted for marketing, where success criteria are softer and topic choice matters as much as execution.

---

### Architecture: capability in Glissa, data in the project

Glissa opens Claude Code projects in terminals and manages them in one place: one project across several terminals, or several projects at once. This feature adds premade **teams** that Glissa can spawn automatically and run on a schedule.

The design separates two concerns:

- **Team definitions live in Glissa.** The agent roster, prompts, orchestration logic, and schedule are owned by Glissa and reusable across any project it opens. A team is a portable unit Glissa knows how to spawn.
- **Team output writes to the target project.** When a team runs against the Milepost project, it writes working state and outputs into that project's `./team/` folder.

Glissa knows *how* to run a team; the project supplies *what* the brand sounds like and stores *what* was produced. The same marketing team can therefore be pointed at any project: run it against Milepost and it writes to Milepost's `./team/marketing/`; the same definition could later run against a different product and write there instead.

#### Glissa side: the reusable team

```
glissa/
  teams/
    marketing/
      team.json           # roster, schedule, model assignments, output path
      agents/
        researcher.md
        strategist.md
        writer.md          # or a reference to the project's existing writer skill
        editor.md
      orchestrator.md      # the run sequence
```

`team.json` declares which agents run, in what order, on what schedule, with which models, and where in the target project to write output.

#### Project side: the output

```
milepost/
  team/
    marketing/
      runs/
        2026-05-20-tuesday/
          brief.md
          plan.md
          drafts.md
          review.md
      config/
        voice-guide.md
        avoid-list.md
        content-calendar.md
      log.md               # append-only run history
```

Each run gets a dated folder so history is preserved and auditable. `log.md` is the lightweight append-only record for scanning recent activity. The `config/` folder holds project-specific rules the team reads at runtime (voice guide, avoid list, content calendar), populated from the existing Notion docs.

---

### Pipeline shape

```
Researcher -> Strategist -> Writer -> Editor -> (optional) Postiz queueing
```

Each agent reads the previous agent's output file from `./team/marketing/runs/<date>/` and writes the next. Glissa's orchestrator runs the chain. Approved output lands in Postiz as drafts for morning review, not auto-published.

A `FIX` verdict is not a dead end: the orchestrator runs a bounded revision loop (default two rounds). On `FIX` the Writer is re-run with the Editor's FIX list plus its prior drafts, then the Editor re-audits, until the verdict is `SHIP` (the publisher then runs), `BLOCK`, the drafts stop changing, or the round budget is spent. The publisher still runs only on a final `SHIP`.

---

### Why this shape

One agent doing everything fills its context with research, planning, writing, and voice audits until quality drops. Four specialists keep narrow contexts, and the handoff file is the mechanism: each agent writes where the next one reads.

Two differences from the coding pipeline that inspired this:

- **Topic selection outweighs execution.** A weak topic in good voice still flops; a strong topic in slightly-off voice still works. The Researcher sets the quality ceiling, the Editor sets the floor.
- **No objective pass/fail.** The Editor enforces voice and trust with explicit checklists (em-dash check, avoid-list word check, urgency-trope check), not a vague "is this good?" prompt.

---

### The four agents

#### Agent 1: Researcher (Opus)

Picks the topic. Reads:

- `config/content-calendar.md` (the 14-day content calendar)
- Recent `/explore` trips published
- Product changes worth promoting (Plus launch, new sample trip, and similar)
- Recent `log.md` entries, to avoid repeating recent topics

Writes `brief.md` to the current run folder:

- Topic
- Angle (the actual hook)
- Audience segment (first-time RVer, occasional, Western trip planner, and similar)
- Milepost differentiator it ties to (paste-to-populate, mobile-first, `/explore`, and similar)
- Source links and reference material
- Sensitivities (for example, do not name competitors)

#### Agent 2: Strategist (Sonnet)

Decides platform mix and message shape. Reads `brief.md`. Writes `plan.md`:

- Platforms (blog, X, Facebook Page, LinkedIn, or combinations)
- Per-platform angle (X thread vs. LinkedIn long-form vs. casual Facebook)
- CTA per platform (link to `/explore`, to milepostplanner.com, or no CTA)
- Approximate length per platform
- Posting-time recommendation

#### Agent 3: Writer (Sonnet)

Uses the project's existing writer skills. Reads `brief.md` plus `plan.md`:

- **Blog writer skill** when the plan calls for a blog post
- **Post writer skill** when the plan calls for social posts (outputs X, Facebook, and LinkedIn in one pass)

Writes `drafts.md` with every variant in one file, labeled by platform.

#### Agent 4: Editor (Opus)

The voice and trust gate. Reads all prior outputs plus `config/voice-guide.md` and `config/avoid-list.md`. Runs an explicit checklist:

- Voice guide compliance (plainspoken, calm, no marketing speak)
- No emojis
- No em dashes
- No urgency tropes ("don't miss out", "act now", "hurry", "limited time")
- No fabricated claims (no invented stats, testimonials, or user counts)
- Platform-appropriate length
- Working CTAs (link targets exist, `/explore` URLs resolve)
- No competitor names

Writes `review.md` ending in `VERDICT: SHIP | FIX | BLOCK`. For FIX, lists the exact changes per draft. For BLOCK, explains why.

#### Optional stage 5: Postiz queueing

After a SHIP verdict, push approved drafts to Postiz as drafts (not scheduled). The user reviews in the morning and schedules manually.

---

### The orchestrator

Glissa runs the team on schedule. Sequence:

1. Create the dated run folder under the target project's `./team/marketing/runs/`.
2. Delegate to Researcher. Wait for `brief.md`.
3. If the brief flags `INSUFFICIENT_TOPICS`, stop and surface it.
4. Delegate to Strategist. Wait for `plan.md`.
5. Delegate to Writer (blog or post skill, per the plan). Wait for `drafts.md`.
6. Delegate to Editor. Read `review.md`.
7. On SHIP, optionally push to Postiz drafts.
8. Append a one-line entry to `log.md`: date, topic, platforms, verdict.
9. Report the final verdict and any Postiz draft URLs.

Each stage confirms the previous handoff file exists and has its expected sections before starting.

---

### What exists vs. what to build

**Already available:**

- Glissa (the orchestration tool, extensible and user-owned)
- Blog writer skill
- Post writer skill (X, Facebook, LinkedIn in one skill)
- Postiz Cloud subscription
- Voice guide doc
- 14-day content topic list

**To build:**

- Glissa "team" abstraction (the reusable unit: roster, schedule, orchestrator, output path)
- Researcher agent/skill
- Strategist agent/skill
- Editor agent/skill
- Orchestrator sequence in Glissa
- `./team/` folder convention, written into the target project at runtime
- Postiz draft-queueing integration (optional, v2)

---

### Scheduling

Glissa triggers the team on a schedule, replacing local cron. Start at three runs per week (Tuesday, Thursday, Saturday, early morning MT), so drafts are waiting in Postiz by morning review. Three per week builds the habit without flooding accounts before the voice is validated.

---

### Build order

1. **Glissa team abstraction.** Define a team: roster, orchestrator sequence, schedule, target output path. Everything else plugs into this.
2. **`./team/` folder convention.** Glissa writes this structure into whatever project the team runs against. Config files are populated from the existing Notion docs.
3. **Editor skill.** Immediate value, no new dependencies; it audits output from the existing writer skills.
4. **Researcher skill.** The topic engine. Makes the pipeline autonomous instead of prompt-fed.
5. **Strategist skill.** Refinement. The Researcher can cover this initially; split it out when needed.
6. **Orchestrator sequence.** Chains the agents inside Glissa.
7. **Schedule wiring.** Tuesday, Thursday, Saturday, early AM MT.
8. **Postiz draft queueing.** Final polish. The pipeline is useful before this; drafts can be copy-pasted manually until the integration ships.

---

### Risks and mitigations

- **Topic drift.** Without guidance, the Researcher gravitates to easy, repetitive topics. *Mitigation:* pass the content calendar as a constraint, require it to surface what it considered and rejected, and have it check recent `log.md` entries.
- **Voice erosion.** Output drifts slightly each run and loses the brand voice over weeks. *Mitigation:* the Editor loads the voice guide fresh from `config/` every run; the user spot-checks weekly and tunes the checklist when drift appears.
- **Hallucinated facts.** The Writer invents a statistic or feature. *Mitigation:* the Editor blocks any numeric claim without a source link in the brief; uncited "most RVers..." claims get rewritten or removed.
- **Post fatigue.** Three posts a week start to read as automated. *Mitigation:* start at three per week rather than daily; the user adjusts cadence by judgment at the weekly review.
- **Mid-run failure.** A skill errors at stage 2 and the orchestrator continues on empty input. *Mitigation:* each stage checks the prior handoff file exists with expected sections, and stops on missing input.
- **Over-engineered abstraction.** Building generic team scaffolding before a second team exists. *Mitigation:* keep the abstraction thin, just enough for marketing; generalize when a real second use case (outreach, listening, support) arrives to validate against.

---

### Acceptance criteria

#### Build (definition of done per component)

- **Team abstraction:** a valid `team.json` loads and Glissa can list its roster, ordered stages, schedule, and output path; an invalid `team.json` is rejected with a specific error naming the missing or malformed field.
- **`./team/` convention:** running the team against a project with no `./team/` folder creates the full structure shown above; a second run reuses existing `config/` and prior `runs/` folders without overwriting them, and adds only the new dated run folder.
- **Editor skill:** against a fixture of 10 seeded drafts containing known violations (em dash, emoji, urgency trope, uncited numeric claim, competitor name), the Editor flags 100% of seeded violations and emits exactly one `VERDICT:` line per run.
- **Researcher skill:** every `brief.md` populates all six required sections, and the chosen topic does not duplicate any topic in the last 5 `log.md` entries.
- **Strategist skill:** every `plan.md` names at least one platform, a per-platform angle, a CTA decision (including "none"), an approximate length, and a posting time.
- **Orchestrator:** on a forced stage-2 error, the run halts before stage 3, writes no `drafts.md`, and records a failure line in `log.md`. On success, `log.md` gains exactly one entry per run.
- **Postiz queueing (v2):** a SHIP verdict produces one Postiz draft per platform in the plan, all in draft (not scheduled) state, with the run's draft URLs reported back.

#### Operation (measured over the first 30 days of supervised runs)

- 12 to 15 posts published across platforms (about 13 expected at three runs per week).
- Across the user's weekly review of all published posts, 0 contain em dashes, emojis, or urgency tropes from the avoid list.
- 0 published posts contain a numeric or factual claim that lacks a source link in its brief.
- Median user time per published post is under 5 minutes (review and schedule, not write), timed by the user across the review sessions.
- At least 80% of scheduled runs complete through an Editor verdict with no manual intervention during the run.

If these hold after 30 days, loosen to auto-publish with a morning notification instead of morning approval.

---

### What this enables later

The team abstraction generalizes. Once marketing works, the same four-stage shape handles new teams pointed at any project:

- **Outreach:** Researcher (find prospects) -> Strategist (pitch angle) -> Writer (email draft) -> Editor (voice and politeness) -> Gmail drafts
- **Listening:** Researcher (pull Reddit mentions) -> Strategist (classify relevance) -> Writer (draft reply when worth engaging) -> Editor (tone) -> Notion queue
- **Support:** Researcher (read user email and account context) -> Strategist (categorize: feature request, bug, refund) -> Writer (draft reply) -> Editor (voice and accuracy) -> Gmail drafts

Each is the same shape with different agents and a different output target. Building marketing well is the investment that pays off across all of them, and because teams live in Glissa and write to the target project, one team can serve multiple products.

---

### Open questions before building

1. **Team schema scope.** Does `team.json` carry only roster, schedule, and output path, or also model assignments, retry policy, and notification settings? Start minimal and expand.
2. **Spawn model.** Does a scheduled run open a fresh Claude Code terminal in the target project and issue the orchestrator command, or run headless? This determines how the orchestrator is invoked.
3. **Postiz integration boundary.** Build queueing into the orchestrator, or as a separate post-pipeline step? Likely separate: the orchestrator finishes at the Editor verdict, and queueing is a discrete next action.
4. **Writer skill reach.** Confirm the existing post-writer skill is installed where a Glissa-spawned session in the Milepost project can invoke it.
