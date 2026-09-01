// Pure boot-time selection: which projects should auto-spawn at startup with their prior
// Claude conversation resumed. See .omc/plans/graceful-shutdown-auto-resume.md design C.
// No IO, no Session import (matches the other session/core modules).

// THE session-id shape, for every agent and every entry point: the ids captured from hook payloads,
// the ids the manual Resume dialog accepts, and the ids persisted to config.json. One definition, and
// server/control-handlers.js imports it rather than restating it, because a hole patched in one copy
// of a validator is a hole.
//
// The leading character MUST be alphanumeric. A captured id becomes a positional argument on the next
// spawn (`--resume <id>` for Claude Code, `resume <id>` for codex), so an id that may start with `-`
// is an argv-injection sink: a session that can reach its own hook ingress (GLISSA_HOOK_URL is in its
// env by design) could POST a forged payload whose session_id is a FLAG, have it persisted, and get it
// spawned as a flag on the next start. `--dangerously-bypass-approvals-and-sandbox` is 47 characters
// of this charset. The rest of the charset is what keeps a path separator, a dot or whitespace out.
const RESUME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

// wasActive: the project had a live PTY when Glissa last shut down (crash or graceful).
// resumeSessionId: the Claude conversation to resume; absent means no auto-spawn (no silent
// --continue fallback - ambiguity beats resuming the wrong conversation). autoResume: false
// is the top-level kill switch.
interface AutoResumeProject {
  id: string;
  wasActive?: boolean;
  resumeSessionId?: string | null;
}

// The index signature keeps a caller's fuller config record assignable to a shape that reads one flag.
interface AutoResumeConfig {
  autoResume?: boolean;
  [key: string]: unknown;
}

function pickAutoResume(
  projects: readonly AutoResumeProject[] | null | undefined,
  config?: AutoResumeConfig | null,
): string[] {
  if (!Array.isArray(projects)) return [];
  if (config && config.autoResume === false) return [];
  const picked: string[] = [];
  for (const project of projects) {
    if (!project || !project.wasActive) continue;
    if (!project.resumeSessionId) continue;
    picked.push(project.id);
  }
  return picked;
}

export { pickAutoResume, RESUME_ID_RE };
export type { AutoResumeConfig, AutoResumeProject };
