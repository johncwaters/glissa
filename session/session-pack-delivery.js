"use strict";

const { decidePackDelivery, normalizePackNames, variantPackName } = require("../server/core/pack-core.ts");
const { DEFAULT_PACKS_DIR, defaultBuiltRoot, resolveBuiltPack } = require("../server/pack-builder");
const { buildPackNotice, listStalePacks } = require("./core/pack-notice.ts");

/**
 * @typedef {{ name: string, version: string, dir?: string, tokenEstimate?: number | null }} DeliveredPack
 * @typedef {{ name?: string, version?: string, dir?: string, reason?: string, manifest?: Record<string, unknown>, perProjectVariants?: boolean }} PackResolution
 * @typedef {object} SessionPackDeliveryOptions
 * @property {unknown} configuredPacks
 * @property {string | null | (() => string | null)} builtRoot
 * @property {string | null} variantSlug
 * @property {string} projectPath
 * @property {string} sessionName
 * @property {string} agentId
 * @property {() => boolean} canDeliver
 * @property {() => boolean} canNotify
 * @property {(packs: DeliveredPack[], builtRoot: string) => string[] | null} renderArgs
 * @property {(entry: Record<string, unknown>) => void} recordDecision
 * @property {(name: string, options: { builtRoot: string }) => Promise<PackResolution>} [resolvePack]
 */

/** @param {SessionPackDeliveryOptions} options */
function createSessionPackDelivery(options) {
  const normalized = normalizePackNames(options.configuredPacks);
  for (const warning of normalized.warnings) console.warn(`[session:${options.sessionName}] ${warning}`);
  const names = normalized.names;
  const latestVersions = new Map();
  const resolvePack = options.resolvePack || resolveBuiltPack;
  let delivered = [];
  let isNoticePending = false;

  function clearNotice() {
    latestVersions.clear();
    isNoticePending = false;
  }

  /** @param {DeliveredPack[]} packs */
  function replaceDelivered(packs) {
    delivered = packs;
  }

  /** @param {string} name @param {string} version */
  function noteUpdate(name, version) {
    if (!options.canNotify()) return false;
    if (typeof name !== "string" || typeof version !== "string" || version.length === 0) return false;
    const deliveredPack = delivered.find((pack) => pack.name === name);
    if (!deliveredPack) return false;
    if (latestVersions.get(name) === version) return false;
    latestVersions.set(name, version);
    if (deliveredPack.version === version) return false;
    isNoticePending = true;
    return true;
  }

  function takeNotice() {
    if (!options.canNotify() || !isNoticePending) return null;
    isNoticePending = false;
    const notice = buildPackNotice(delivered, latestVersions);
    if (!notice) return null;
    const staleNames = listStalePacks(delivered, latestVersions).map((pack) => pack.name);
    options.recordDecision({ kind: "pack", ts: Date.now(), decision: "notice", names: staleNames });
    return notice;
  }

  /** @param {string} name @param {string} builtRoot */
  async function resolveVariant(name, builtRoot) {
    const base = await resolvePack(name, { builtRoot });
    if (!options.variantSlug || !base.perProjectVariants) return base;
    const variantName = variantPackName(name, options.variantSlug);
    const variant = variantName ? await resolvePack(variantName, { builtRoot }) : null;
    if (variant?.dir) return variant;
    options.recordDecision({
      kind: "pack",
      ts: Date.now(),
      name,
      decision: "variant-fallback",
      reason: variant ? variant.reason : "no valid variant name for this project",
    });
    return base;
  }

  async function resolve() {
    clearNotice();
    if (names.length === 0) {
      delivered = [];
      return { args: [], packs: [] };
    }
    if (!options.canDeliver()) {
      const ts = Date.now();
      for (const name of names) {
        options.recordDecision({ kind: "pack", ts, name, decision: "unsupported", reason: `agent ${options.agentId} does not deliver context packs` });
      }
      delivered = [];
      return { args: [], packs: [] };
    }
    const configuredBuiltRoot = typeof options.builtRoot === "function"
      ? options.builtRoot()
      : options.builtRoot;
    const builtRoot = configuredBuiltRoot || defaultBuiltRoot();
    const nextDelivered = [];
    for (const name of names) {
      const resolved = await resolveVariant(name, builtRoot);
      const ts = Date.now();
      if (!resolved.dir) {
        console.warn(`[session:${options.sessionName}] context pack "${name}" skipped: ${resolved.reason}`);
        options.recordDecision({ kind: "pack", ts, name, decision: "skipped", reason: resolved.reason });
        continue;
      }
      const verdict = decidePackDelivery({ manifest: resolved.manifest, projectPath: options.projectPath, packsDir: DEFAULT_PACKS_DIR });
      if (!verdict.deliver) {
        console.warn(`[session:${options.sessionName}] context pack "${name}" skipped: ${verdict.reason}, ${verdict.detail}`);
        options.recordDecision({ kind: "pack", ts, name, decision: "skipped", reason: verdict.reason, detail: verdict.detail });
        continue;
      }
      nextDelivered.push({
        name: resolved.name,
        version: resolved.version,
        dir: resolved.dir,
        tokenEstimate: typeof resolved.manifest?.tokenEstimate === "number"
          && Number.isFinite(resolved.manifest.tokenEstimate)
          ? resolved.manifest.tokenEstimate
          : null,
      });
    }
    const args = options.renderArgs(nextDelivered, builtRoot);
    if (!args) {
      const ts = Date.now();
      for (const pack of nextDelivered) {
        options.recordDecision({ kind: "pack", ts, name: pack.name, decision: "skipped", reason: `agent ${options.agentId} refused the pack carrier path` });
      }
      delivered = [];
      return { args: [], packs: [] };
    }
    delivered = nextDelivered;
    const ts = Date.now();
    for (const pack of nextDelivered) {
      options.recordDecision({ kind: "pack", ts, name: pack.name, decision: "delivered", version: pack.version });
    }
    return { args, packs: nextDelivered };
  }

  return {
    names: () => [...names],
    delivered: () => delivered.map(({ name, version }) => ({ name, version })),
    deliveredWithDirs: () => delivered.map(({ name, version, dir, tokenEstimate }) => ({
      name, version, dir, tokenEstimate: tokenEstimate ?? null,
    })),
    replaceDelivered,
    clearNotice,
    hasPendingNotice: () => isNoticePending,
    noteUpdate,
    takeNotice,
    resolve,
  };
}

module.exports = { createSessionPackDelivery };
