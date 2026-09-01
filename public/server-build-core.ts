// Pure rule for the connect snapshot's server build stamp (2026-08 review, section 1).
//
// The dashboard is served by the same process as the backend, so version skew is rare: the case is a
// tab left open across a server update, reconnecting to a backend whose frames its bundle may predate.
// Reloading is cheap insurance against a silently half-broken dashboard.
//
// Two rules keep it from being a nuisance: the FIRST snapshot only records the build (a fresh page
// load must never reload itself), and a snapshot with no build at all changes nothing (an older
// backend, or a caller that declares none, is not evidence of a new one).

export function decideReloadOnBuild(knownBuild: string | null | undefined, incomingBuild: unknown): { knownBuild: string | null | undefined; reload: boolean } {
  if (typeof incomingBuild !== 'string' || incomingBuild === '') return { knownBuild, reload: false };
  if (knownBuild === null || knownBuild === undefined) return { knownBuild: incomingBuild, reload: false };
  if (knownBuild === incomingBuild) return { knownBuild, reload: false };
  return { knownBuild: incomingBuild, reload: true };
}
