export const PHONE_MAX_WIDTH_PX = 768;

export const PHONE_NARROW_QUERY = `(max-width: ${PHONE_MAX_WIDTH_PX}px)`;
export const COARSE_POINTER_QUERY = '(pointer: coarse)';

export function decideLayout({ coarse, narrowWidth }: { coarse?: unknown; narrowWidth?: unknown } = {}) {
  if (coarse === true && narrowWidth === true) return 'phone';
  return 'desktop';
}
