'use strict';

// `glissa pack` - build and inspect context packs.
//
// Lives in server/ for the same reason server/pair-cli.js does: package.json "files" whitelists bin
// entries one by one but ships server/ wholesale, so a new bin/ module would be missing from the
// published tarball and scripts/check-package-files.js would fail.

const path = require('node:path');

const { buildPacks, defaultBuiltRoot, defaultSpecsDir, describePackSpec, listPackSpecs, readBuiltManifest } = require('./pack-builder');

const USAGE = [
  'Usage: glissa pack <command>',
  '',
  'Commands:',
  '  build [name]     Build one pack, or every spec when no name is given',
  '  list             Show every spec and the version currently built from it',
].join('\n');

function shortVersion(version) {
  return typeof version === 'string' ? version.slice(0, 12) : '-';
}

function formatTimestamp(iso) {
  if (typeof iso !== 'string') return '-';
  return iso.replace('T', ' ').slice(0, 19);
}

function reportLine(report) {
  const name = report.name.padEnd(24);
  if (!report.ok) return `${name}FAILED`;
  return `${name}ok    version ${shortVersion(report.version)}  files ${report.fileCount}  tokens ${report.tokenEstimate}/${report.budgetTokens}`;
}

async function runBuild(name) {
  const reports = await buildPacks({ name });
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

async function runList() {
  const specs = await listPackSpecs();
  if (specs.length === 0) {
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
      + formatTimestamp(manifest ? manifest.builtAt : null)
    );
  }
  console.log(`\nSpecs: ${path.dirname(specs[0].specPath)}\nBuilt: ${defaultBuiltRoot()}`);
  return 0;
}

/**
 * @param {string[]} args argv after the `pack` subcommand
 * @returns {Promise<number>} process exit code
 */
async function runPackCli(args) {
  const command = args[0];
  if (command === 'build') return runBuild(args[1] || null);
  if (command === 'list') return runList();
  console.error(USAGE);
  return 1;
}

module.exports = { runPackCli, USAGE };
