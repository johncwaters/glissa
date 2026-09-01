// Session display-name helpers backed by the live session list. The pure
// algorithms live in naming-core.mjs; these wrap them with the current display
// names from the card registry.
//
// Must NOT import dialogs.js: dialogs.js imports countSessionsByName /
// suggestSessionName from here, so keeping this edge one-way avoids the cycle the
// confirm prompt's home in session-card/modal.js also exists to avoid.

import { sessionUIs } from './card-registry.ts';
import { countAutoNames, nextSuggestedName } from './naming-core.ts';

function currentSessionNames() {
  const names: string[] = [];
  for (const [, ui] of sessionUIs) names.push(ui.card.dataset.session ?? '');
  return names;
}

/** Count sessions whose display name is `baseName` or `baseName (N)`. */
export function countSessionsByName(baseName: string) {
  return countAutoNames(baseName, currentSessionNames());
}

/**
 * Return the first free name in the sequence `baseName`, `baseName (2)`,
 * `baseName (3)`, ... so users can spawn multiple terminals on one project.
 * Bounded by 999 to keep the suffix within the 64-char server name limit.
 */
export function suggestSessionName(baseName: string | null | undefined) {
  return nextSuggestedName(baseName ?? '', currentSessionNames());
}
