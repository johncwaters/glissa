import { getKeptProjects, setKeptProjects } from './ui-prefs.js';

export const knownProjectPaths = new Set(getKeptProjects());

function persistKnownProjectPaths() {
  setKeptProjects([...knownProjectPaths]);
}

export function noteKnownProjectPath(path) {
  if (!path) return;
  const projectPath = String(path);
  if (knownProjectPaths.has(projectPath)) return;
  knownProjectPaths.add(projectPath);
  persistKnownProjectPaths();
}

export function emptyProjectKeys(orderedRows, pathOf) {
  const liveProjectPaths = new Set();
  for (const row of orderedRows || []) {
    const path = pathOf(row);
    if (!path) continue;
    const projectPath = String(path);
    liveProjectPaths.add(projectPath);
    noteKnownProjectPath(projectPath);
  }
  return [...knownProjectPaths].filter((projectPath) => !liveProjectPaths.has(projectPath));
}

export function forgetProject(path) {
  if (!path) return false;
  const didForgetProject = knownProjectPaths.delete(String(path));
  if (!didForgetProject) return false;
  persistKnownProjectPaths();
  return true;
}
