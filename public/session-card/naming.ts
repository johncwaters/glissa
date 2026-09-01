import { sessionUIs } from './card-registry.ts';
import { countAutoNames, nextSuggestedName } from './naming-core.ts';

function currentSessionNames() {
  const names: string[] = [];
  for (const [, ui] of sessionUIs) names.push(ui.card.dataset.session ?? '');
  return names;
}

export function countSessionsByName(baseName: string) {
  return countAutoNames(baseName, currentSessionNames());
}

export function suggestSessionName(baseName: string | null | undefined) {
  return nextSuggestedName(baseName ?? '', currentSessionNames());
}
