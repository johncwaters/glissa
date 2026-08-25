"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { PACK_DIRECTIVE, renderPackPointerText } = require("../session/core/pack-pointer-core");

test("pack pointer text preserves order and carries index paths only", () => {
  const builtRoot = "/packs";
  assert.equal(renderPackPointerText([
    { name: "alpha", dir: "/packs/alpha/current" },
    { name: "memory-project", dir: "/packs/memory-project/current" },
  ], builtRoot), `${PACK_DIRECTIVE}; alpha: /packs/alpha/current/CLAUDE.md; memory-project: /packs/memory-project/current/CLAUDE.md`);
  assert.equal(renderPackPointerText([]), "");
});

test("pack pointer text refuses unsafe names and paths", () => {
  const builtRoot = "/packs";
  assert.equal(renderPackPointerText([{ name: "alpha'", dir: "/packs/alpha/current" }], builtRoot), null);
  assert.equal(renderPackPointerText([{ name: "alpha", dir: "relative/current" }], builtRoot), null);
  assert.equal(renderPackPointerText([{ name: "alpha", dir: "/packs/alpha;touch/current" }], builtRoot), null);
});

test("pack pointer text refuses a directory outside the built root", () => {
  const builtRoot = "/packs/built";
  assert.equal(renderPackPointerText([{ name: "alpha", dir: "/packs/built/alpha/current" }], builtRoot), `${PACK_DIRECTIVE}; alpha: /packs/built/alpha/current/CLAUDE.md`);
  assert.equal(renderPackPointerText([{ name: "alpha", dir: "/packs/other/alpha/current" }], builtRoot), null);
  assert.equal(renderPackPointerText([{ name: "alpha", dir: "/packs/built-other/alpha/current" }], builtRoot), null);
});
