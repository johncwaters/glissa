const RESUME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

interface AutoResumeProject {
  id: string;
  wasActive?: boolean;
  resumeSessionId?: string | null;
}

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
