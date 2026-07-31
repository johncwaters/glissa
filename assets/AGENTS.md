<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# assets

## Purpose
Repo-level static assets for documentation and source media. Runtime-served audio lives in `public/audio/` (these are the source copies).

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `audio/` | Source notification sound files (OGG); copies served at runtime live in `public/audio/` |
| `pictures/` | Screenshots for README/docs (`glissa-screenshot.png` Focus view hero, `glissa-teams.png` Teams tab) |

## For AI Agents

### Working In This Directory
- Adding a notification sound: place the file in BOTH `assets/audio/` and `public/audio/`, then register it in `public/alert-sound.js` `SOUND_OPTIONS`.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
