'use strict';

// Pure boot-time selection: which projects should auto-spawn at startup with their prior
// Claude conversation resumed. See .omc/plans/graceful-shutdown-auto-resume.md design C.
// No IO, no Session import (matches the other session/core modules).

// Shape Claude Code assigns its session ids in. Shared with the manual Resume dialog's
// validation (server/control-handlers.js RESUME_ID_RE) so a captured id and an
// operator-typed id are held to the same bar.
const RESUME_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

// wasActive: the project had a live PTY when Glissa last shut down (crash or graceful).
// resumeSessionId: the Claude conversation to resume; absent means no auto-spawn (no silent
// --continue fallback - ambiguity beats resuming the wrong conversation). autoResume: false
// is the top-level kill switch.
function pickAutoResume(projects, config) {
  if (!Array.isArray(projects)) return [];
  if (config && config.autoResume === false) return [];
  const picked = [];
  for (const project of projects) {
    if (!project || !project.wasActive) continue;
    if (!project.resumeSessionId) continue;
    picked.push(project.id);
  }
  return picked;
}

module.exports = { pickAutoResume, RESUME_ID_RE };
