import { startNyanCat, stopNyanCat } from './nyan-cat.ts';

export function applyFlyingAnimals(flyingAnimalsEnabled: boolean) {
  const root = document.documentElement;
  if (flyingAnimalsEnabled) {
    root.dataset.flyingAnimals = 'true';
    startNyanCat();
    return;
  }
  delete root.dataset.flyingAnimals;
  stopNyanCat();
}
