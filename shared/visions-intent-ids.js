'use strict';

// The Visions intent thread id shape, unanchored so every check can frame it: `t-` plus 8 hex, short
// enough that the memory screen's entropy check can never read one as a secret.
// Server-side: require('../shared/visions-intent-ids') (re-exported by server/core/visions-intent-core).
// Browser-side: /shared/visions-intent-ids.mjs, GENERATED from these exports by server/browser-modules.js,
// which backs both the Vite plugin and the no-build route. Constants only: the generator serializes with
// JSON.stringify, so a RegExp here would reach the browser as an empty object.
const VISIONS_THREAD_ID_PATTERN = 't-[0-9a-f]{8}';

module.exports = { VISIONS_THREAD_ID_PATTERN };
