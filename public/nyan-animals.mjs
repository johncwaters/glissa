// Pure roster + picker for the flying nyan easter egg's animal menagerie.
// No DOM access: public/nyan-cat.js applies the sprite/trail classes.

export const ANIMALS = [
  { sprite: 'is-cat', trail: 'is-rainbow' },
  { sprite: 'is-unicorn', trail: 'is-sparkles' },
  { sprite: 'is-dragon', trail: 'is-embers' },
  { sprite: 'is-pig', trail: 'is-hearts' },
  { sprite: 'is-whale', trail: 'is-bubbles' },
  { sprite: 'is-corgi', trail: 'is-paws' },
  { sprite: 'is-frog', trail: 'is-dust' },
  { sprite: 'is-penguin', trail: 'is-snow' },
  { sprite: 'is-bee', trail: 'is-honey' },
  { sprite: 'is-owl', trail: 'is-stars' },
];

/**
 * Pick a uniformly random animal index, excluding prevIndex so the same
 * animal never flies twice in a row. prevIndex < 0 (or out of range) means
 * any index is eligible.
 * @param {() => number} rng
 * @param {number} prevIndex
 * @returns {number}
 */
export function pickAnimalIndex(rng = Math.random, prevIndex = -1) {
  const n = ANIMALS.length;
  const isValidPrev = prevIndex >= 0 && prevIndex < n;
  if (!isValidPrev) return Math.floor(rng() * n);
  const pick = Math.floor(rng() * (n - 1));
  return pick >= prevIndex ? pick + 1 : pick;
}
