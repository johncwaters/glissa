"use strict";

const path = require("node:path");

const { SAFE_PATH_RE } = require("./hook-command-core");
const { PACK_NAME_RE } = require("../../server/core/pack-core");

const PACK_DIRECTIVE = "Glissa context packs are available at these index files. Read each relevant CLAUDE.md before working";
const CURRENT_POINTER_DIRECTORY = "current";
const CURRENT_POINTER_FILE = "version";
const VERSIONS_DIRECTORY = "versions";
const PACK_VERSION_RE = /^[a-f0-9]{64}$/;

function parsePackPointer(contents) {
  if (typeof contents !== "string") return null;
  const match = contents.match(/^([a-f0-9]{64})\r?\n?$/);
  return match ? match[1] : null;
}

function renderPackPointer(version) {
  if (typeof version !== "string" || !PACK_VERSION_RE.test(version)) return null;
  return `${version}\n`;
}

function packVersionDirectory(packDirectory, version) {
  if (typeof packDirectory !== "string" || !PACK_VERSION_RE.test(version)) return null;
  return path.join(packDirectory, VERSIONS_DIRECTORY, version);
}

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

module.exports = {
  CURRENT_POINTER_DIRECTORY,
  CURRENT_POINTER_FILE,
  PACK_DIRECTIVE,
  PACK_VERSION_RE,
  VERSIONS_DIRECTORY,
  packVersionDirectory,
  parsePackPointer,
  renderPackPointer,
  renderPackPointerText,
};
