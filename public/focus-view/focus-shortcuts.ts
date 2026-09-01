export function isFocusAltShortcut(key: string) {
  if (key === 'w' || key === 'W') return true;
  if (key === 'm' || key === 'M') return true;
  if (key === 'r' || key === 'R') return true;
  if (key === 'ArrowUp' || key === 'ArrowDown') return true;
  return key.length === 1 && key >= '0' && key <= '9';
}
