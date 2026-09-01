export const ANIMALS = [
  { sprite: 'is-cat', trail: 'is-rainbow' },
  { sprite: 'is-unicorn', trail: 'is-sparkles' },
  { sprite: 'is-dragon', trail: 'is-embers' },
  { sprite: 'is-pig', trail: 'is-hearts' },
  { sprite: 'is-whale', trail: 'is-bubbles' },
  { sprite: 'is-fox', trail: 'is-paws' },
  { sprite: 'is-frog', trail: 'is-dust' },
  { sprite: 'is-penguin', trail: 'is-snow' },
  { sprite: 'is-bee', trail: 'is-honey' },
  { sprite: 'is-owl', trail: 'is-stars' },
  { sprite: 'is-cow', trail: 'is-daisies' },
  { sprite: 'is-panda', trail: 'is-bamboo' },
  { sprite: 'is-red-panda', trail: 'is-leaves' },
  { sprite: 'is-deer', trail: 'is-acorns' },
  { sprite: 'is-horse', trail: 'is-clover' },
  { sprite: 'is-sheep', trail: 'is-clouds' },
  { sprite: 'is-hamster', trail: 'is-seeds' },
  { sprite: 'is-giraffe', trail: 'is-acacia' },
];

export function pickAnimalIndex(rng: () => number = Math.random, prevIndex = -1): number {
  const n = ANIMALS.length;
  const isValidPrev = prevIndex >= 0 && prevIndex < n;
  if (!isValidPrev) return Math.floor(rng() * n);
  const pick = Math.floor(rng() * (n - 1));
  return pick >= prevIndex ? pick + 1 : pick;
}
