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
