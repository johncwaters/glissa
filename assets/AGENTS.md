<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-15 -->

# assets/ — Source Media Files

## Purpose

Source audio files and screenshots for the project. Audio files are copied to `public/audio/` for serving. Screenshots are used in documentation (README).

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `audio/` | Source alert sound files (`.ogg`) — copied to `public/audio/` for browser playback |
| `pictures/` | Project screenshots for README and documentation |

## Key Files

| File | Description |
|------|-------------|
| `audio/Coins_jingle_(4).wav.ogg` | Coins notification sound |
| `audio/Tears_of_Guthix_(minigame)_blue_tears.ogg` | Tears of Guthix notification sound |
| `pictures/glissa-screenshot.png` | Dashboard screenshot used in README |

## For AI Agents

### Working In This Directory

- These are static media assets, not code
- Audio files here are the sources; the served copies live in `public/audio/`
- When adding new sounds, also update `public/alert-sound.js` SOUND_OPTIONS array and copy the file to `public/audio/`

<!-- MANUAL: -->
