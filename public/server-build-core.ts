export function decideReloadOnBuild(knownBuild: string | null | undefined, incomingBuild: unknown): { knownBuild: string | null | undefined; reload: boolean } {
  if (typeof incomingBuild !== 'string' || incomingBuild === '') return { knownBuild, reload: false };
  if (knownBuild === null || knownBuild === undefined) return { knownBuild: incomingBuild, reload: false };
  if (knownBuild === incomingBuild) return { knownBuild, reload: false };
  return { knownBuild: incomingBuild, reload: true };
}
