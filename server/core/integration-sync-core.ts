export type IntegrationSyncOutcome =
  | 'updated'
  | 'up-to-date'
  | 'diverged'
  | 'checked-out'
  | 'no-remote'
  | 'fetch-failed'
  | 'update-failed'
  | 'missing';

export interface IntegrationSyncDecision {
  action: 'none' | 'update';
  outcome: IntegrationSyncOutcome;
}

function decideIntegrationSync({
  localSha,
  remoteSha,
  isAncestor,
  checkedOut,
}: {
  localSha: string | null;
  remoteSha: string | null;
  isAncestor: boolean | null | undefined;
  checkedOut: boolean;
}): IntegrationSyncDecision {
  if (!remoteSha) return { action: 'none', outcome: 'no-remote' };
  if (!localSha) return { action: 'none', outcome: 'missing' };
  if (localSha === remoteSha) return { action: 'none', outcome: 'up-to-date' };
  if (isAncestor === false) return { action: 'none', outcome: 'diverged' };
  if (isAncestor !== true) return { action: 'none', outcome: 'update-failed' };
  if (checkedOut) return { action: 'none', outcome: 'checked-out' };
  return { action: 'update', outcome: 'updated' };
}

function classifyRefusedIntegrationSync({
  currentSha,
  remoteSha,
  isAncestor,
  checkedOut,
}: {
  currentSha: string | null;
  remoteSha: string | null;
  isAncestor: boolean | null | undefined;
  checkedOut: boolean;
}): { outcome: IntegrationSyncOutcome } {
  if (currentSha && currentSha === remoteSha) return { outcome: 'up-to-date' };
  if (isAncestor === false) return { outcome: 'diverged' };
  if (checkedOut) return { outcome: 'checked-out' };
  return { outcome: 'update-failed' };
}

export { decideIntegrationSync, classifyRefusedIntegrationSync };
