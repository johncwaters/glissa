import { needsAttention } from './focus-view/attention-core.mjs';

export type FaviconVariant = 'idle' | 'complete' | 'waiting';

const TRIANGLE_COLORS: Readonly<Record<FaviconVariant, string>> = Object.freeze({
  idle: '#c084fc',
  complete: '#4ade80',
  waiting: '#fbbf24',
});

export function decideFaviconVariant(sessions: unknown): FaviconVariant {
  const rows: { state?: string }[] = Array.isArray(sessions) ? sessions : [];

  for (const session of rows) {
    if (needsAttention({ state: session?.state })) return 'waiting';
  }

  for (const session of rows) {
    if (session?.state === 'COMPLETE') return 'complete';
  }

  return 'idle';
}

export function renderFaviconSvg(variant: FaviconVariant) {
  const triangleColor = TRIANGLE_COLORS[variant] || TRIANGLE_COLORS.idle;
  const completeBadge = variant === 'complete' ? '<circle cx="25" cy="7" r="3" fill="#4ade80"/>' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0a0810"/><rect x="1" y="1" width="30" height="30" rx="5" fill="none" stroke="#2a2440" stroke-width="1"/><path d="M10 8 L22 16 L10 24Z" fill="${triangleColor}"/>${completeBadge}</svg>`;
}
