import { decidePackDelivery, normalizePackNames, variantPackName } from "../server/core/pack-core.ts";
import { DEFAULT_PACKS_DIR, defaultBuiltRoot, resolveBuiltPack } from "../server/pack-builder.ts";
import { buildPackNotice, listStalePacks } from "./core/pack-notice.ts";
import type { DecisionEntry } from "./core/decision-log.ts";

interface DeliveredPack {
  name: string;
  version: string;
  dir?: string;
  tokenEstimate?: number | null;
}

interface ResolvedDelivery {
  name: string;
  version: string;
  dir: string;
  tokenEstimate: number | null;
}

interface PackResolution {
  name?: string;
  version?: string | null;
  dir?: string | null;
  reason?: string | null;
  manifest?: Record<string, unknown> | null;
  perProjectVariants?: boolean;
}

interface SessionPackDeliveryOptions {
  configuredPacks: () => unknown;
  builtRoot: string | null | (() => string | null);
  variantSlug: string | null;
  projectPath: string;
  sessionName: string;
  agentId: string;
  canDeliver: () => boolean;
  canNotify: () => boolean;
  renderArgs: (packs: ResolvedDelivery[], builtRoot: string) => string[] | null;
  recordDecision: (entry: DecisionEntry) => void;
  resolvePack?: (name: string, options: { builtRoot: string }) => Promise<PackResolution>;
}

interface PackDeliveryResult {
  args: string[];
  packs: ResolvedDelivery[];
}

interface SessionPackDelivery {
  names(): string[];
  delivered(): { name: string; version: string }[];
  deliveredWithDirs(): ResolvedDelivery[];
  replaceDelivered(packs: DeliveredPack[]): void;
  clearNotice(): void;
  hasPendingNotice(): boolean;
  noteUpdate(name: string, version: string): boolean;
  takeNotice(): string | null;
  resolve(): Promise<PackDeliveryResult>;
}

function createSessionPackDelivery(options: SessionPackDeliveryOptions): SessionPackDelivery {
  function readConfiguredNames(): string[] {
    const normalized = normalizePackNames(options.configuredPacks());
    for (const warning of normalized.warnings) console.warn(`[session:${options.sessionName}] ${warning}`);
    return normalized.names;
  }

  let configuredNames = readConfiguredNames();
  const latestVersions = new Map<string, string>();
  const resolvePack = options.resolvePack || resolveBuiltPack;
  let delivered: DeliveredPack[] = [];
  let isNoticePending = false;

  function clearNotice(): void {
    latestVersions.clear();
    isNoticePending = false;
  }

  function replaceDelivered(packs: DeliveredPack[]): void {
    delivered = packs;
  }

  function noteUpdate(name: string, version: string): boolean {
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

  function takeNotice(): string | null {
    if (!options.canNotify() || !isNoticePending) return null;
    isNoticePending = false;
    const notice = buildPackNotice(delivered, latestVersions);
    if (!notice) return null;
    const staleNames = listStalePacks(delivered, latestVersions).map((pack) => pack.name);
    options.recordDecision({ kind: "pack", ts: Date.now(), decision: "notice", names: staleNames });
    return notice;
  }

  async function resolveVariant(name: string, builtRoot: string): Promise<PackResolution> {
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

  async function resolve(): Promise<PackDeliveryResult> {
    clearNotice();
    const names = readConfiguredNames();
    configuredNames = names;
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
    const nextDelivered: ResolvedDelivery[] = [];
    for (const name of names) {
      const resolved = await resolveVariant(name, builtRoot);
      const ts = Date.now();
      if (!resolved.dir) {
        console.warn(`[session:${options.sessionName}] context pack "${name}" skipped: ${resolved.reason}`);
        options.recordDecision({ kind: "pack", ts, name, decision: "skipped", reason: resolved.reason });
        continue;
      }
      const verdict = decidePackDelivery({ manifest: resolved.manifest ?? undefined, projectPath: options.projectPath, packsDir: DEFAULT_PACKS_DIR });
      if (!verdict.deliver) {
        console.warn(`[session:${options.sessionName}] context pack "${name}" skipped: ${verdict.reason}, ${verdict.detail}`);
        options.recordDecision({ kind: "pack", ts, name, decision: "skipped", reason: verdict.reason, detail: verdict.detail });
        continue;
      }
      const manifestTokenEstimate = resolved.manifest?.tokenEstimate;
      nextDelivered.push({
        name: resolved.name ?? name,
        version: resolved.version ?? "",
        dir: resolved.dir,
        tokenEstimate: typeof manifestTokenEstimate === "number" && Number.isFinite(manifestTokenEstimate)
          ? manifestTokenEstimate
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
    names: () => [...configuredNames],
    delivered: () => delivered.map(({ name, version }) => ({ name, version })),
    deliveredWithDirs: () => delivered.flatMap(({ name, version, dir, tokenEstimate }) => (
      dir ? [{ name, version, dir, tokenEstimate: tokenEstimate ?? null }] : []
    )),
    replaceDelivered,
    clearNotice,
    hasPendingNotice: () => isNoticePending,
    noteUpdate,
    takeNotice,
    resolve,
  };
}

export { createSessionPackDelivery };
export type { DeliveredPack, PackResolution, ResolvedDelivery, SessionPackDelivery, SessionPackDeliveryOptions };
