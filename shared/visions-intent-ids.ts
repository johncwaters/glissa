// The Visions intent thread id shape, unanchored so every check can frame it: `t-` plus 8 hex, short
// enough that the memory screen's entropy check can never read one as a secret.
// Server-side: import from '../shared/visions-intent-ids.ts' (re-exported by server/core/visions-intent-core).
// Browser-side: import from '#shared/visions-intent-ids.ts'. Keep this a string, not a RegExp, so every
// consumer can frame it with its own anchors.
export const VISIONS_THREAD_ID_PATTERN = 't-[0-9a-f]{8}';
