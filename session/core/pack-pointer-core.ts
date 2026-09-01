import path from "node:path";

import { SAFE_PATH_RE } from "./hook-command-core.ts";

const PACK_DIRECTIVE = "Glissa context packs are available at these index files. Read each relevant CLAUDE.md before working";
const CURRENT_POINTER_DIRECTORY = "current";
const CURRENT_POINTER_FILE = "version";
const VERSIONS_DIRECTORY = "versions";
const PACK_VERSION_RE = /^[a-f0-9]{64}$/;

interface PackDelivery {
  name: string;
  dir: string;
}

function parsePackPointer(contents: unknown): string | null {
  if (typeof contents !== "string") return null;
  const match = contents.match(/^([a-f0-9]{64})\r?\n?$/);
  return match ? match[1] : null;
}

function renderPackPointer(version: unknown): string | null {
  if (typeof version !== "string" || !PACK_VERSION_RE.test(version)) return null;
  return `${version}\n`;
}

function packVersionDirectory(packDirectory: unknown, version: string): string | null {
  if (typeof packDirectory !== "string" || !PACK_VERSION_RE.test(version)) return null;
  return path.join(packDirectory, VERSIONS_DIRECTORY, version);
}

function isInsideBuiltRoot(packDirectory: string, builtRoot: unknown): boolean {
  if (builtRoot == null) return true;
  if (typeof builtRoot !== "string" || !path.isAbsolute(builtRoot)) return false;
  const builtRootPrefix = `${path.resolve(builtRoot)}${path.sep}`;
  return path.resolve(packDirectory).startsWith(builtRootPrefix);
}

function renderPackPointerText(
  deliveries: readonly PackDelivery[] | null | undefined,
  builtRoot?: unknown,
  isPackName?: ((name: string) => boolean) | null,
): string | null {
  if (!Array.isArray(deliveries) || deliveries.length === 0) return "";
  if (typeof isPackName !== "function") return null;
  const pointers: string[] = [];
  for (const delivery of deliveries) {
    if (!delivery || !isPackName(delivery.name)) return null;
    const packDirectory = String(delivery.dir || "");
    const indexPath = path.join(packDirectory, "CLAUDE.md");
    const isAbsolute = path.isAbsolute(packDirectory) || path.win32.isAbsolute(packDirectory);
    if (!isAbsolute || !SAFE_PATH_RE.test(indexPath) || !isInsideBuiltRoot(packDirectory, builtRoot)) return null;
    pointers.push(`${delivery.name}: ${indexPath}`);
  }
  return [PACK_DIRECTIVE, ...pointers].join("; ");
}

export {
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
export type { PackDelivery };
