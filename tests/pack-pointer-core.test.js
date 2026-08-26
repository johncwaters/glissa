"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  PACK_DIRECTIVE,
  packVersionDirectory,
  parsePackPointer,
  renderPackPointer,
  renderPackPointerText,
} = require("../session/core/pack-pointer-core");

const isPackName = (name) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);

test("the current pointer accepts only a content hash and resolves under versions", () => {
  const version = "a".repeat(64);
  assert.equal(renderPackPointer(version), `${version}\n`);
  assert.equal(parsePackPointer(`${version}\n`), version);
  assert.equal(packVersionDirectory("/packs/alpha", version), path.join("/packs/alpha", "versions", version));
  for (const invalid of ["v1", "A".repeat(64), `${version} extra`, "../escape"]) {
    assert.equal(renderPackPointer(invalid), null);
    assert.equal(parsePackPointer(invalid), null);
  }
});

test("pack pointer text preserves order and carries index paths only", () => {
  const builtRoot = "/packs";
  assert.equal(renderPackPointerText([
    { name: "alpha", dir: "/packs/alpha/current" },
    { name: "memory-project", dir: "/packs/memory-project/current" },
  ], builtRoot, isPackName), `${PACK_DIRECTIVE}; alpha: /packs/alpha/current/CLAUDE.md; memory-project: /packs/memory-project/current/CLAUDE.md`);
  assert.equal(renderPackPointerText([]), "");
});

test("pack pointer text refuses unsafe names and paths", () => {
  const builtRoot = "/packs";
  assert.equal(renderPackPointerText([{ name: "alpha'", dir: "/packs/alpha/current" }], builtRoot, isPackName), null);
  assert.equal(renderPackPointerText([{ name: "alpha", dir: "relative/current" }], builtRoot, isPackName), null);
  assert.equal(renderPackPointerText([{ name: "alpha", dir: "/packs/alpha;touch/current" }], builtRoot, isPackName), null);
});

test("pack pointer text refuses a directory outside the built root", () => {
  const builtRoot = "/packs/built";
  assert.equal(renderPackPointerText([{ name: "alpha", dir: "/packs/built/alpha/current" }], builtRoot, isPackName), `${PACK_DIRECTIVE}; alpha: /packs/built/alpha/current/CLAUDE.md`);
  assert.equal(renderPackPointerText([{ name: "alpha", dir: "/packs/other/alpha/current" }], builtRoot, isPackName), null);
  assert.equal(renderPackPointerText([{ name: "alpha", dir: "/packs/built-other/alpha/current" }], builtRoot, isPackName), null);
});
