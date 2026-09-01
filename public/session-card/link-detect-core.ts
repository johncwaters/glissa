const URL_RE = /https?:\/\/[^\s<>"']+/g;
const PLAIN_TRAILING_PUNCT = new Set(['.', ',', ';', ':', '!', '?', "'", '"']);
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function countChar(text: string, wanted: string) {
  let count = 0;
  for (const ch of text) {
    if (ch === wanted) count++;
  }
  return count;
}

export function trimTrailingPunctuation(url: string) {
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

export interface DetectedUrl {
  start: number;
  end: number;
  url: string;
}

export function findUrls(text: string): DetectedUrl[] {
  const found: DetectedUrl[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const url = trimTrailingPunctuation(match[0]);

    if (url.length <= 'https://'.length) continue;
    found.push({ start: match.index, end: match.index + url.length, url });
  }
  return found;
}
