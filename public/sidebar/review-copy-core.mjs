export function baseLabel(effectiveBase) {
  return effectiveBase || 'base';
}

export function mergeActionTitle(effectiveBase) {
  return `Merge into ${baseLabel(effectiveBase)}, push it, and rebase this worktree, then keep working (alt+m)`;
}

export function mergeTargetText(effectiveBase) {
  return `merges into ${baseLabel(effectiveBase)}`;
}

export function parkedStatusText(reason) {
  if (reason === 'base-diverged') return 'Resync the base branch by hand, then Merge again.';
  return 'Needs manual merge';
}

export function decideMergeAction(status, mergeReason, isMergeable) {
  const isBaseDiverged = status === 'parked' && mergeReason === 'base-diverged';
  const isRendered = status !== 'parked' || isBaseDiverged;
  return {
    isRendered,
    isEnabled: isRendered && status !== 'merging' && isMergeable,
  };
}

export function mergeDisabledReason({ status, mergeReason, fetched, hasCommits, live, state }) {
  if (status === 'merging') return null;
  if (!fetched) return 'Checking for changes...';
  if (!hasCommits) return null;
  if (!live) return 'Session ended.';
  if (status === 'parked' && mergeReason === 'base-diverged') {
    return 'Resync the base branch by hand before merging.';
  }
  if (status === 'parked') return 'Resolve the conflict, then merge.';
  if (state === 'INITIALIZING' || state === 'STARTING') {
    return 'Starting up. Mergeable once the session is live.';
  }
  return null;
}
