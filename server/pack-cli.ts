// `glissa pack` - build and inspect context packs.
//
// Lives in server/ for the same reason server/pair-cli.ts does: package.json "files" whitelists bin
// entries one by one but ships server/ wholesale, so a new bin/ module would be missing from the
// published tarball and scripts/check-package-files.js would fail.

import path from 'node:path';

import { DEFAULT_AGENT_ID, commandFor } from '../session/adapters/index.ts';
import { loadConfigFile, resolveConfigPath } from './config-store.ts';
import { packVariantProjects } from './core/pack-core.ts';
import {
  buildPacks, defaultBuiltRoot, defaultSpecsDir, describePackSpec, listPackSpecs, readBuiltManifest,
} from './pack-builder.ts';
import type { BuildReport } from './pack-builder.ts';
import { createPackDistiller } from './pack-distiller.ts';
import type { PackDistiller } from './pack-distiller.ts';
import { formatTimestamp, shortVersion } from './text-format.ts';

const USAGE = [
  'Usage: glissa pack <command>',
  '',
  'Commands:',
  '  build [name]     Build one pack, or every spec when no name is given',
  '  list             Show every spec and the version currently built from it',
  '  distill [name]   Regenerate derived pack sources whose sources drifted',
  '                   --dry-run reports what would be distilled and spawns nothing',
].join('\n');

function reportLine(report: BuildReport): string {
  const name = report.name.padEnd(24);
  if (!report.ok) return `${name}FAILED`;
  return `${name}ok    version ${shortVersion(report.version)}  files ${report.fileCount}  tokens ${report.tokenEstimate}/${report.budgetTokens}`;
}

/*
 * The projects a group spec derives its per-project variants from. Best effort: an install with no
 * config yet still builds every plain pack, and every group's base, which is what a manual build is for.
 */
function variantProjects() {
  try {
    return packVariantProjects(loadConfigFile(resolveConfigPath(), { exitOnError: false }).config);
  } catch {
    return [];
  }
}

async function runBuild(name: string | null): Promise<number> {
  const reports = await buildPacks({ name, projects: variantProjects() });
  if (reports.length === 0) {
    console.log(`No pack specs in ${defaultSpecsDir()}.`);
    return 0;
  }
  let failed = 0;
  for (const report of reports) {
    console.log(reportLine(report));
    if (report.ok) continue;
    failed += 1;
    for (const error of report.errors) console.error(`  ${error}`);
  }
  if (failed > 0) {
    console.error(`\n${failed} pack(s) failed to build. Nothing was written for those.`);
    return 1;
  }
  console.log(`\nBuilt into ${defaultBuiltRoot()}`);
  return 0;
}

async function runList(): Promise<number> {
  const specs = await listPackSpecs();
  const first = specs[0];
  if (specs.length === 0 || !first) {
    console.log(`No pack specs in ${defaultSpecsDir()}.`);
    return 0;
  }
  console.log(`${'NAME'.padEnd(24)}${'SOURCES'.padEnd(9)}${'BUDGET'.padEnd(9)}${'BUILT VERSION'.padEnd(15)}BUILT AT`);
  for (const spec of specs) {
    const described = await describePackSpec(spec.specPath);
    const manifest = await readBuiltManifest(spec.name);
    const version = described.valid ? shortVersion(manifest ? manifest.version : null) : 'INVALID SPEC';
    console.log(
      spec.name.padEnd(24)
      + String(described.sourceCount).padEnd(9)
      + String(described.budgetTokens === null ? '-' : described.budgetTokens).padEnd(9)
      + version.padEnd(15)
      + formatTimestamp(manifest ? manifest.builtAt : null),
    );
  }
  console.log(`\nSpecs: ${path.dirname(first.specPath)}\nBuilt: ${defaultBuiltRoot()}`);
  return 0;
}

const DISTILL_STATUS_LABEL: Record<string, string | undefined> = {
  current: 'current',
  stale: 'STALE (dry run, nothing spawned)',
  distilled: 'distilled',
  error: 'ERROR',
};

// The manual trigger, always allowed: config.packDistiller.enabled gates the scheduled lane only, and
// an operator running this command IS the authorization. `claude` must be resolvable for a real run;
// a dry run only reads and hashes, so it works on a machine without it.
async function runDistill(
  name: string | null,
  { dryRun }: { dryRun: boolean },
  makeDistiller: () => PackDistiller,
): Promise<number> {
  if (!dryRun) {
    const resolved = commandFor(DEFAULT_AGENT_ID);
    if (!resolved || !resolved.path) {
      console.error("Cannot distill: 'claude' is not resolvable on PATH. Install Claude Code, or use --dry-run.");
      return 1;
    }
  }

  const distiller = makeDistiller();
  const reports = await distiller.runOnce({ name, dryRun });
  await distiller.stop();

  if (reports.length === 0) {
    console.log(name ? `No distill entries in a spec named "${name}".` : 'No pack spec declares a distill entry.');
    return 0;
  }
  let failed = 0;
  for (const report of reports) {
    const label = DISTILL_STATUS_LABEL[report.status] || report.status;
    console.log(`${String(report.pack).padEnd(24)}${label}  ${report.output || ''}`.trimEnd());
    if (report.reason) console.log(`  ${report.reason}`);
    if (report.summary) console.log(`  ${report.summary}`);
    if (report.status === 'error') failed += 1;
  }
  if (failed > 0) {
    console.error(`\n${failed} distill entr(y/ies) failed. Nothing was accepted for those.`);
    return 1;
  }
  return 0;
}

/** `args` is argv after the `pack` subcommand; the return value is the process exit code. */
async function runPackCli(
  args: string[],
  deps: { makeDistiller?: () => PackDistiller } = {},
): Promise<number> {
  const { makeDistiller = () => createPackDistiller({ enabled: true }) } = deps;
  const command = args[0];
  const rest = args.slice(1).filter((arg) => arg !== '--dry-run');
  if (command === 'build') return runBuild(rest[0] || null);
  if (command === 'list') return runList();
  if (command === 'distill') {
    return runDistill(rest[0] || null, { dryRun: args.includes('--dry-run') }, makeDistiller);
  }
  console.error(USAGE);
  return 1;
}

export { USAGE, runPackCli };
