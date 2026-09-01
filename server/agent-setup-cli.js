"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const grok = require("../session/adapters/grok");
const { renderGrokHooksFile, classifyGrokHooksFile } = require("../session/core/grok-hooks-file-core.ts");

const USAGE = "Usage: glissa agent setup grok";

function setupInputs(env = process.env) {
  return {
    filePath: grok.hooksFilePath(env),
    relayPath: grok.RELAY_PATH,
    events: grok.HOOK_EVENTS,
    managedEventSets: grok.MANAGED_HOOK_EVENT_SETS,
  };
}

function inspectGrokAgentSetup({ env = process.env, readFileSync = fs.readFileSync } = {}) {
  const inputs = setupInputs(env);
  /** @type {string|null} */
  let contents = null;
  try {
    contents = readFileSync(inputs.filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { filePath: inputs.filePath, classification: "absent" };
    return { filePath: inputs.filePath, classification: "unreadable", reason: error.message };
  }
  return {
    filePath: inputs.filePath,
    classification: classifyGrokHooksFile(contents, inputs),
  };
}

function assertRealDirectory(directory, fileSystem, requireOwnership = true) {
  const directoryStat = fileSystem.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`refusing to write Grok hooks: ${directory} is not a real directory`);
  }
  if (requireOwnership && typeof process.getuid === "function" && directoryStat.uid !== process.getuid()) {
    throw new Error(`refusing to write Grok hooks: ${directory} is owned by another account`);
  }
}

function ensureWritableHooksDirectory(directory, fileSystem) {
  const resolvedDirectory = path.resolve(directory);
  const trustedParent = path.dirname(path.dirname(resolvedDirectory));
  assertRealDirectory(trustedParent, fileSystem, false);
  const relativeParts = path.relative(trustedParent, resolvedDirectory).split(path.sep).filter(Boolean);
  let currentDirectory = trustedParent;
  for (const part of relativeParts) {
    currentDirectory = path.join(currentDirectory, part);
    try {
      assertRealDirectory(currentDirectory, fileSystem);
      continue;
    } catch (directoryError) {
      if (directoryError.code !== "ENOENT") throw directoryError;
    }
    fileSystem.mkdirSync(currentDirectory, { mode: 0o700 });
    assertRealDirectory(currentDirectory, fileSystem);
  }
  try {
    fileSystem.chmodSync(directory, 0o700);
  } catch {}
}

function replaceFileAtomically(filePath, contents, fileSystem) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    fileSystem.writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fileSystem.renameSync(temporaryPath, filePath);
  } catch (writeError) {
    try {
      fileSystem.rmSync(temporaryPath, { force: true });
    } catch {}
    throw writeError;
  }
  try {
    fileSystem.chmodSync(filePath, 0o600);
  } catch {}
}

function runGrokSetup({ env, fileSystem, log, error }) {
  const inputs = setupInputs(env);
  const expectedContents = renderGrokHooksFile(inputs);
  if (!expectedContents) {
    error("Could not render the Grok hooks file. Nothing was written.");
    return 1;
  }
  const inspection = inspectGrokAgentSetup({ env, readFileSync: fileSystem.readFileSync });
  if (inspection.classification === "current") {
    log(`Grok hooks are already current at ${inputs.filePath}`);
    return 0;
  }
  if (inspection.classification === "foreign" || inspection.classification === "unreadable") {
    error(`Refusing to replace ${inputs.filePath}: the existing file is ${inspection.classification}.`);
    return 1;
  }
  const hooksDirectory = path.dirname(inputs.filePath);
  try {
    ensureWritableHooksDirectory(hooksDirectory, fileSystem);
    if (fileSystem.existsSync(inputs.filePath)) {
      const targetStat = fileSystem.lstatSync(inputs.filePath);
      if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
        error(`Refusing to replace ${inputs.filePath}: the target is not a real file.`);
        return 1;
      }
    }
    replaceFileAtomically(inputs.filePath, expectedContents, fileSystem);
  } catch (writeError) {
    error(`Could not write ${inputs.filePath}: ${writeError.message}`);
    return 1;
  }
  log(`Installed Grok hooks at ${inputs.filePath}`);
  return 0;
}

function runAgentSetupCli(args, deps = {}) {
  const {
    env = process.env,
    fileSystem = fs,
    log = console.log,
    error = console.error,
  } = deps;
  if (args[0] === "setup" && args[1] === "grok" && args.length === 2) {
    return runGrokSetup({ env, fileSystem, log, error });
  }
  error(USAGE);
  return 1;
}

module.exports = {
  USAGE,
  runAgentSetupCli,
  inspectGrokAgentSetup,
  setupInputs,
  ensureWritableHooksDirectory,
  replaceFileAtomically,
};
