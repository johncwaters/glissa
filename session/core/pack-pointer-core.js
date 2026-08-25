"use strict";

const path = require("node:path");

const { SAFE_PATH_RE } = require("./hook-command-core");
const { PACK_NAME_RE } = require("../../server/core/pack-core");

const PACK_DIRECTIVE = "Glissa context packs are available at these index files. Read each relevant CLAUDE.md before working";

function isInsideBuiltRoot(packDirectory, builtRoot) {
  if (builtRoot == null) return true;
  if (typeof builtRoot !== "string" || !path.isAbsolute(builtRoot)) return false;
  const builtRootPrefix = `${path.resolve(builtRoot)}${path.sep}`;
  return path.resolve(packDirectory).startsWith(builtRootPrefix);
}

function renderPackPointerText(deliveries, builtRoot) {
  if (!Array.isArray(deliveries) || deliveries.length === 0) return "";
  const pointers = [];
  for (const delivery of deliveries) {
    if (!delivery || !PACK_NAME_RE.test(delivery.name)) return null;
    const packDirectory = String(delivery.dir || "");
    const indexPath = path.join(packDirectory, "CLAUDE.md");
    const isAbsolute = path.isAbsolute(packDirectory) || path.win32.isAbsolute(packDirectory);
    if (!isAbsolute || !SAFE_PATH_RE.test(indexPath) || !isInsideBuiltRoot(packDirectory, builtRoot)) return null;
    pointers.push(`${delivery.name}: ${indexPath}`);
  }
  return [PACK_DIRECTIVE, ...pointers].join("; ");
}

module.exports = { PACK_DIRECTIVE, renderPackPointerText };
