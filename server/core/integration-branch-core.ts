export function configuredIntegrationBranch(config: { integrationBranch?: unknown } | null | undefined): string | null {
  const configuredBranch = config?.integrationBranch;
  if (typeof configuredBranch !== 'string') return null;
  return configuredBranch || null;
}

export const DEFAULT_BRANCH_FALLBACKS = ['main', 'master'] as const;

const REMOTE_HEAD_PREFIX = 'origin/';

export function defaultBranchFromRemoteHead(remoteHead: string): string | null {
  if (!remoteHead.startsWith(REMOTE_HEAD_PREFIX)) return null;
  return remoteHead.slice(REMOTE_HEAD_PREFIX.length) || null;
}

export interface MarkerBaseDecision {
  base: string | null;
  migrateTo: string | null;
  measureRef: string | null;
}

export interface MarkerProbes {
  detectedDefaultBranch: string | null;
  resolvedMarkerRef: string | null;
  isMarkerRefResolvable: boolean | null;
  isMarkerAbsorbedByDefault: boolean | null;
}

export interface MarkerRefCandidate {
  ref: string;
  argv: string[];
}

export interface MarkerProbePlan {
  markerRefCandidates: MarkerRefCandidate[];
  absorbedByDefault: (resolvedMarkerRef: string) => string[];
}

export function markerProbeCommands({ marker, detectedDefaultBranch }: { marker: string | null; detectedDefaultBranch: string | null }): MarkerProbePlan | null {
  if (!marker || !detectedDefaultBranch || detectedDefaultBranch === marker) return null;
  const markerRefsNearestFirst = [`refs/heads/${marker}`, `refs/remotes/origin/${marker}`];
  return {
    markerRefCandidates: markerRefsNearestFirst.map((ref) => ({ ref, argv: ['rev-parse', '--verify', '--quiet', ref] })),
    absorbedByDefault: (resolvedMarkerRef: string) => ['merge-base', '--is-ancestor', resolvedMarkerRef, detectedDefaultBranch],
  };
}

export function decideMarkerBase({
  marker,
  fallbackBase,
  configuredIntegrationBranch,
  detectedDefaultBranch,
  resolvedMarkerRef,
  isMarkerRefResolvable,
  isMarkerAbsorbedByDefault,
}: MarkerProbes & {
  marker: string | null;
  fallbackBase?: string | null;
  configuredIntegrationBranch?: string | null;
}): MarkerBaseDecision {
  if (!marker) return { base: configuredIntegrationBranch || fallbackBase || null, migrateTo: null, measureRef: null };
  if (configuredIntegrationBranch) return { base: marker, migrateTo: null, measureRef: null };
  if (!detectedDefaultBranch || detectedDefaultBranch === marker) return { base: marker, migrateTo: null, measureRef: null };
  const isStale = isMarkerRefResolvable === false || isMarkerAbsorbedByDefault === true;
  if (!isStale) return { base: marker, migrateTo: null, measureRef: resolvedMarkerRef };
  return { base: detectedDefaultBranch, migrateTo: detectedDefaultBranch, measureRef: null };
}
