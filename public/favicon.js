import { decideFaviconVariant, renderFaviconSvg } from './favicon-core.mjs';

function getFaviconElement() {
  const existingFavicon = document.querySelector('link[rel="icon"]');
  if (existingFavicon) return existingFavicon;

  const faviconElement = document.createElement('link');
  faviconElement.rel = 'icon';
  faviconElement.type = 'image/svg+xml';
  document.head.append(faviconElement);
  return faviconElement;
}

const faviconElement = getFaviconElement();
let currentFaviconVariant = 'idle';

export function refreshFavicon(sessionRegistry) {
  const sessions = [...sessionRegistry.values()].map(({ currentState }) => ({ state: currentState }));
  const faviconVariant = decideFaviconVariant(sessions);
  if (faviconVariant === currentFaviconVariant) return;

  currentFaviconVariant = faviconVariant;
  faviconElement.href = `data:image/svg+xml,${encodeURIComponent(renderFaviconSvg(faviconVariant))}`;
}
