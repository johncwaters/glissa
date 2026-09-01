import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

import grok from "../session/adapters/grok.ts";
import { renderGrokHooksFile, classifyGrokHooksFile } from "../session/core/grok-hooks-file-core.ts";

const USAGE = "Usage: glissa agent setup grok";

type SetupFileSystem = Pick<
  typeof fs,
  "readFileSync" | "lstatSync" | "mkdirSync" | "chmodSync" | "writeFileSync" | "renameSync" | "rmSync" | "existsSync"
>;
type DirectoryFileSystem = Pick<typeof fs, "lstatSync" | "mkdirSync" | "chmodSync">;
// Structural rather than a Pick of node:fs, so a test can hand it a string-path double.
interface AtomicWriteFileSystem {
  writeFileSync(filePath: string, contents: string, options: { encoding: BufferEncoding; mode: number; flag: string }): void;
  renameSync(source: string, target: string): void;
  chmodSync(filePath: string, mode: number): void;
  rmSync(filePath: string, options: { force: boolean }): void;
}
type ReadTextFile = (filePath: string, encoding: "utf8") => string;

interface GrokSetupInspection {
  filePath: string;
  classification: string;
  reason?: string;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setupInputs(env: NodeJS.ProcessEnv = process.env) {
  return {
    filePath: grok.hooksFilePath(env),
    relayPath: grok.RELAY_PATH,
    events: grok.HOOK_EVENTS,
    managedEventSets: grok.MANAGED_HOOK_EVENT_SETS,
  };
}

function inspectGrokAgentSetup({ env = process.env, readFileSync = fs.readFileSync }: {
  env?: NodeJS.ProcessEnv;
  readFileSync?: ReadTextFile;
} = {}): GrokSetupInspection {
  const inputs = setupInputs(env);
  let contents: string | null = null;
  try {
    contents = readFileSync(inputs.filePath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { filePath: inputs.filePath, classification: "absent" };
    return { filePath: inputs.filePath, classification: "unreadable", reason: errorMessage(error) };
  }
  return {
    filePath: inputs.filePath,
    classification: classifyGrokHooksFile(contents, inputs),
  };
}

function assertRealDirectory(directory: string, fileSystem: DirectoryFileSystem, requireOwnership = true): void {
  const directoryStat = fileSystem.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`refusing to write Grok hooks: ${directory} is not a real directory`);
  }
  if (requireOwnership && typeof process.getuid === "function" && directoryStat.uid !== process.getuid()) {
    throw new Error(`refusing to write Grok hooks: ${directory} is owned by another account`);
  }
}

function ensureWritableHooksDirectory(directory: string, fileSystem: DirectoryFileSystem): void {
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
      if (errorCode(directoryError) !== "ENOENT") throw directoryError;
    }
    fileSystem.mkdirSync(currentDirectory, { mode: 0o700 });
    assertRealDirectory(currentDirectory, fileSystem);
  }
  try {
    fileSystem.chmodSync(directory, 0o700);
  } catch {}
}

function replaceFileAtomically(filePath: string, contents: string, fileSystem: AtomicWriteFileSystem): void {
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

interface AgentSetupDeps {
  env?: NodeJS.ProcessEnv;
  fileSystem?: SetupFileSystem;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

function runGrokSetup({ env, fileSystem, log, error }: Required<AgentSetupDeps>): number {
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
    error(`Could not write ${inputs.filePath}: ${errorMessage(writeError)}`);
    return 1;
  }
  log(`Installed Grok hooks at ${inputs.filePath}`);
  return 0;
}

function runAgentSetupCli(args: string[], deps: AgentSetupDeps = {}): number {
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

export {
  USAGE,
  runAgentSetupCli,
  inspectGrokAgentSetup,
  setupInputs,
  ensureWritableHooksDirectory,
  replaceFileAtomically,
};
type GrokSetupInputs = ReturnType<typeof setupInputs>;

export type { AgentSetupDeps, AtomicWriteFileSystem, DirectoryFileSystem, GrokSetupInputs, GrokSetupInspection, SetupFileSystem };
