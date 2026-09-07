export type SessionCardFace = 'terminal' | 'plan';

export function preferredBorrowedFace({
  hasPlan,
  pendingPromptKind,
  hasOpenReview,
}: {
  hasPlan: boolean;
  pendingPromptKind: string | null;
  hasOpenReview: boolean;
}): SessionCardFace {
  if (hasPlan && (pendingPromptKind === 'plan' || hasOpenReview)) return 'plan';
  return 'terminal';
}
