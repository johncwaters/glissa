import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const publicDir = path.join(import.meta.dirname, '..', 'public');

const CALL_PATTERN = /queryTag\([^,]+,\s*'([^']+)'\s*,\s*'([^']+)'\)/g;

function filesUnder(dir: string, extensions: string[]): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...filesUnder(full, extensions));
      continue;
    }
    if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(full);
  }
  return found;
}

function markupCorpus(): string {
  const html = filesUnder(publicDir, ['.html']).map((file) => fs.readFileSync(file, 'utf8'));
  const scripts = filesUnder(publicDir, ['.js', '.mjs', '.ts']).map((file) => fs.readFileSync(file, 'utf8'));
  return [...html, ...scripts].join('\n');
}

function elementsMatching(corpus: string, tag: string): string[] {
  const written = [...corpus.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))].map((match) => match[0]);
  const built = [...corpus.matchAll(new RegExp(`\\bel\\('${tag}',\\s*'([^']*)'`, 'g'))]
    .map((match) => `<${tag} class="${match[1]}">`);
  return [...written, ...built];
}

function satisfies(openTag: string, selector: string): boolean {
  if (selector.startsWith('#')) return openTag.includes(`id="${selector.slice(1)}"`);
  const wanted = selector.slice(1);
  const classAttribute = /class="([^"]*)"/.exec(openTag);
  return !!classAttribute && classAttribute[1].split(/\s+/).includes(wanted);
}

test('every queryTag selector matches an element of that tag in the shipped markup', () => {
  const corpus = markupCorpus();
  const seen = new Set<string>();
  const unmatched: string[] = [];
  for (const file of filesUnder(publicDir, ['.js', '.mjs', '.ts'])) {
    for (const [, selector, tag] of fs.readFileSync(file, 'utf8').matchAll(CALL_PATTERN)) {
      const key = `${selector}|${tag}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (elementsMatching(corpus, tag).some((openTag) => satisfies(openTag, selector))) continue;
      unmatched.push(`${selector} has no <${tag}> in public/`);
    }
  }
  assert.deepEqual(unmatched, []);
});
