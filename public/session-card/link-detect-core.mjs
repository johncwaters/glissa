// Pure URL detection over one logical terminal line: string in, character
// offsets out. No xterm types, no DOM. The IO shell (terminal-links.js) maps
// offsets back to buffer cells.

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const PLAIN_TRAILING_PUNCT = new Set(['.', ',', ';', ':', '!', '?', "'", '"']);
const CLOSERS = { ')': '(', ']': '[', '}': '{' };

function countChar(text, wanted) {
  let count = 0;
  for (const ch of text) {
    if (ch === wanted) count++;
  }
  return count;
}

// Terminal output wraps URLs in prose punctuation the URL does not own:
// "see https://x.dev/a." or "(https://x.dev/a)". Strip trailing punctuation,
// but keep a closer that is balanced by an opener inside the URL itself
// (https://en.wikipedia.org/wiki/Foo_(bar) keeps its final paren).
export function trimTrailingPunctuation(url) {
  for (;;) {
    const last = url[url.length - 1];
    if (last === undefined) return url;
    if (PLAIN_TRAILING_PUNCT.has(last)) {
      url = url.slice(0, -1);
      continue;
    }
    const opener = CLOSERS[last];
    if (opener && countChar(url, opener) < countChar(url, last)) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

export function isHttpUrl(text) {
  return /^https?:\/\//i.test(text);
}

// -> [{ start, end, url }] with end exclusive, offsets into `text`.
export function findUrls(text) {
  const found = [];
  for (const match of text.matchAll(URL_RE)) {
    const url = trimTrailingPunctuation(match[0]);
    // A bare scheme ("https://") is prose, not a link.
    if (url.length <= 'https://'.length) continue;
    found.push({ start: match.index, end: match.index + url.length, url });
  }
  return found;
}
