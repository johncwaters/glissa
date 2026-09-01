'use strict';

// queryTag throws when a selector no longer matches its tag, which is the point: a renamed id used to
// surface as an undefined read somewhere downstream. The trade is that a selector typo now hard-fails a
// dialog at wiring time, and no browser runs in this suite. This pins each selector against the markup
// that has to satisfy it: the component HTML plus the innerHTML literals the JS builds its rows from.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');

const CALL_PATTERN = /queryTag\([^,]+,\s*'([^']+)'\s*,\s*'([^']+)'\)/g;

function filesUnder(dir, extensions) {
  const found = [];
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

function markupCorpus() {
  const html = filesUnder(publicDir, ['.html']).map((file) => fs.readFileSync(file, 'utf8'));
  const scripts = filesUnder(publicDir, ['.js', '.mjs', '.ts']).map((file) => fs.readFileSync(file, 'utf8'));
  return [...html, ...scripts].join('\n');
}

// Elements reach the DOM two ways here: written as markup (component HTML, innerHTML literals) and
// built by dom-helpers el(tag, className). Both count as a declaration of the element this selector
// expects to find.
function elementsMatching(corpus, tag) {
  const written = [...corpus.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))].map((match) => match[0]);
  const built = [...corpus.matchAll(new RegExp(`\\bel\\('${tag}',\\s*'([^']*)'`, 'g'))]
    .map((match) => `<${tag} class="${match[1]}">`);
  return [...written, ...built];
}

function satisfies(openTag, selector) {
  if (selector.startsWith('#')) return openTag.includes(`id="${selector.slice(1)}"`);
  const wanted = selector.slice(1);
  const classAttribute = /class="([^"]*)"/.exec(openTag);
  return !!classAttribute && classAttribute[1].split(/\s+/).includes(wanted);
}

test('every queryTag selector matches an element of that tag in the shipped markup', () => {
  const corpus = markupCorpus();
  const seen = new Set();
  const unmatched = [];
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
