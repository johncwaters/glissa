// THE predicate choosing between the dashboard's two first-class layouts (see AGENTS.md, Two
// First-Class Layouts).

// Below this the rail + resizer + sidebar minimums (567px) leave no terminal column at all.
export const PHONE_MAX_WIDTH_PX = 768;

export const PHONE_NARROW_QUERY = `(max-width: ${PHONE_MAX_WIDTH_PX}px)`;
export const COARSE_POINTER_QUERY = '(pointer: coarse)';

// AND, not OR: a narrowed desktop window can be widened back and keeps the docked IA, and a coarse
// tablet above the threshold has room for all three panels. Non-boolean input reads as false, so an
// engine without matchMedia lands on 'desktop' rather than guessing.
export function decideLayout({ coarse, narrowWidth } = {}) {
  if (coarse === true && narrowWidth === true) return 'phone';
  return 'desktop';
}
