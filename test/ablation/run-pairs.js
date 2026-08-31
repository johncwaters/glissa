'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { execSync } = require('../../server/child-process-safe');
const {
  awaitBackendShutdown,
  closeServer,
  connectControl,
  findFreeHighPort,
  listen,
  makeClaudeConfig,
  removeHarnessTempDirectory,
  safeTextTail,
} = require('../support/backend-harness');
const {
  armOutcome,
  classifyObservedPrompts,
  pairArmOrder,
  promptCount,
  summariseAblation,
  turnBudget,
} = require('./ablation-core');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const REPOSITORY_NODE_MODULES = path.join(REPOSITORY_ROOT, 'node_modules');
const DEFAULT_TASKS_PATH = path.join(__dirname, 'tasks.json');
const PACK_NAME = 'glissa-ablation-house-rules';
const PACK_VERSION = 'glissa-ablation-v1';
const SESSION_TIMEOUT_MS = 180000;
const CHECK_TIMEOUT_MS = 30000;
const METRICS_TIMEOUT_MS = 10000;

function usage() {
  return [
    'Usage: node test/ablation/run-pairs.js [flags]',
    '',
    '  --tasks <path>  Task JSON file',
    '  --only <id>     Run one task id',
    '  --seeds <n>     Replicates per task, default 1',
    '  --model <id>    Claude model, default haiku',
    '  --out <path>    JSONL output path',
  ].join('\n');
}

function requiredFlagValue(argumentsList, index, flag) {
  const value = argumentsList[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function defaultOutputPath() {
  const timestamp = new Date().toISOString().replace(/[:]/g, '-');
  return path.join(__dirname, 'results', `${timestamp}.jsonl`);
}

function parseArguments(argumentsList) {
  const options = {
    tasksPath: DEFAULT_TASKS_PATH,
    only: null,
    seeds: 1,
    model: 'haiku',
    outputPath: defaultOutputPath(),
    help: false,
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const flag = argumentsList[index];
    if (flag === '--help' || flag === '-h') {
      options.help = true;
      continue;
    }
    if (flag === '--tasks') {
      options.tasksPath = path.resolve(requiredFlagValue(argumentsList, index, flag));
      index += 1;
      continue;
    }
    if (flag === '--only') {
      options.only = requiredFlagValue(argumentsList, index, flag);
      index += 1;
      continue;
    }
    if (flag === '--seeds') {
      options.seeds = Number(requiredFlagValue(argumentsList, index, flag));
      index += 1;
      continue;
    }
    if (flag === '--model') {
      options.model = requiredFlagValue(argumentsList, index, flag);
      index += 1;
      continue;
    }
    if (flag === '--out') {
      options.outputPath = path.resolve(requiredFlagValue(argumentsList, index, flag));
      index += 1;
      continue;
    }
    throw new Error(`unknown flag ${flag}`);
  }
  if (!Number.isInteger(options.seeds) || options.seeds < 1) {
    throw new Error('--seeds must be a positive integer');
  }
  return options;
}

function readTasks(tasksPath, onlyTaskId) {
  const parsedTasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
  if (!Array.isArray(parsedTasks)) throw new Error('tasks file must contain an array');
  const taskIds = new Set();
  const indexedTasks = parsedTasks.map((task, taskIndex) => {
    if (!task || typeof task !== 'object') throw new Error(`task ${taskIndex + 1} must be an object`);
    if (!/^[a-z0-9-]+$/.test(task.id)) throw new Error(`task ${taskIndex + 1} has an invalid id`);
    if (taskIds.has(task.id)) throw new Error(`duplicate task id ${task.id}`);
    if (typeof task.prompt !== 'string' || !task.prompt.trim()) throw new Error(`task ${task.id} has no prompt`);
    if (typeof task.checkCommand !== 'string' || !task.checkCommand.trim()) throw new Error(`task ${task.id} has no checkCommand`);
    if (!Number.isInteger(task.maxTurns) || task.maxTurns < 1) throw new Error(`task ${task.id} has invalid maxTurns`);
    taskIds.add(task.id);
    return { ...task, taskIndex };
  });
  if (!onlyTaskId) return indexedTasks;
  const selectedTasks = indexedTasks.filter((task) => task.id === onlyTaskId);
  if (selectedTasks.length === 0) throw new Error(`unknown task id ${onlyTaskId}`);
  return selectedTasks;
}

function delay(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function extractSection(markdown, heading) {
  const marker = `## ${heading}`;
  const sectionStart = markdown.indexOf(marker);
  if (sectionStart < 0) throw new Error(`AGENTS.md is missing ${marker}`);
  const nextSection = markdown.indexOf('\n## ', sectionStart + marker.length);
  if (nextSection < 0) return markdown.slice(sectionStart).trim();
  return markdown.slice(sectionStart, nextSection).trim();
}

function makeAblationPack(tempDirectory) {
  const agentsMarkdown = fs.readFileSync(path.join(REPOSITORY_ROOT, 'AGENTS.md'), 'utf8');
  const selectedRules = [
    extractSection(agentsMarkdown, 'For AI Agents'),
    extractSection(agentsMarkdown, 'Coding Style'),
  ].join('\n\n');
  const builtRoot = path.join(tempDirectory, 'packs', 'built');
  const currentDirectory = path.join(builtRoot, PACK_NAME, 'current');
  const rulesDirectory = path.join(currentDirectory, 'data');
  const rulesPath = path.join(rulesDirectory, 'house-rules.md');
  fs.mkdirSync(rulesDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(currentDirectory, 'CLAUDE.md'),
    `# Glissa ablation pack\n\nBefore working, use the Read tool to read \`${rulesPath}\` and follow it.\n`,
    'utf8',
  );
  fs.writeFileSync(rulesPath, `# Glissa house rules\n\n${selectedRules}\n`, 'utf8');
  fs.writeFileSync(
    path.join(currentDirectory, 'manifest.json'),
    `${JSON.stringify({ name: PACK_NAME, version: PACK_VERSION, tokenEstimate: 1200 }, null, 2)}\n`,
    'utf8',
  );
  return { builtRoot, packDirectory: currentDirectory };
}

function seedProject(projectDirectory) {
  fs.mkdirSync(projectDirectory, { recursive: true });
  const packageDocument = {
    name: 'glissa-ablation-task',
    private: true,
    type: 'commonjs',
    dependencies: {
      'node-pty': '^1.1.0',
      zod: '^4.4.3',
    },
  };
  fs.writeFileSync(
    path.join(projectDirectory, 'package.json'),
    `${JSON.stringify(packageDocument, null, 2)}\n`,
    'utf8',
  );
}

function buildPairs(tasks, seeds, tempDirectory) {
  const pairs = [];
  for (const task of tasks) {
    for (let seed = 1; seed <= seeds; seed += 1) {
      const pairSlug = `${task.id}-seed-${seed}`;
      const order = pairArmOrder(task.taskIndex, seed);
      const arms = {};
      for (const armName of ['on', 'off']) {
        const sessionId = `ablation-${pairSlug}-${armName}`;
        const projectDirectory = path.join(tempDirectory, 'projects', sessionId);
        seedProject(projectDirectory);
        arms[armName] = { armName, sessionId, projectDirectory };
      }
      pairs.push({ task, seed, order, arms });
    }
  }
  return pairs;
}

function writeAblationConfig(configPath, pairs, port) {
  const projects = [];
  for (const pair of pairs) {
    for (const armName of ['on', 'off']) {
      const arm = pair.arms[armName];
      projects.push({
        id: arm.sessionId,
        name: `${pair.task.id} ${pair.seed} ${armName}`,
        path: arm.projectDirectory,
        agent: 'claude-code',
        dangerouslySkipPermissions: true,
        packs: armName === 'on' ? [PACK_NAME] : [],
      });
    }
  }
  const configDocument = {
    port,
    projects,
    teams: [],
    repoRoots: [],
    packsAutoRebuild: false,
    autoResume: false,
    worktreeAutoRebase: false,
    worktreeSyncOnStart: false,
    branchGc: { enabled: false },
    usage: { enabled: false },
    capture: { enabled: false },
    recordSignals: false,
    postTurnChecks: { enabled: false },
    packDistiller: { enabled: false },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(configDocument, null, 2)}\n`, 'utf8');
}

function runCheckCommand(checkCommand, projectDirectory) {
  try {
    const output = execSync(checkCommand, {
      cwd: projectDirectory,
      encoding: 'utf8',
      timeout: CHECK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        NODE_PATH: REPOSITORY_NODE_MODULES,
      },
    });
    return { passed: true, output: safeTextTail(output) };
  } catch (error) {
    return {
      passed: false,
      exitCode: Number.isInteger(error?.status) ? error.status : null,
      output: safeTextTail(error?.stdout),
      error: safeTextTail(error?.stderr || error?.message),
    };
  }
}

function readMetricRecords(recordsPath) {
  if (!fs.existsSync(recordsPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(recordsPath, 'utf8'));
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}

async function waitForMetricRecord(recordsPath, sessionId) {
  const deadline = Date.now() + METRICS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const record = readMetricRecords(recordsPath).find((candidate) => candidate.sessionId === sessionId);
    if (record) return record;
    await delay(100);
  }
  return null;
}

function waitForSessionExit(session, controlSocket) {
  return new Promise((resolve) => {
    let isSettled = false;
    const settle = (outcome) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timeoutHandle);
      session.off('exit', onExit);
      session.off('error', onError);
      resolve(outcome);
    };
    const onExit = (payload) => settle({ timedOut: false, exit: payload, error: null });
    const onError = (error) => {
      try { session.kill(); } catch {}
      settle({ timedOut: false, exit: null, error: error.message });
    };
    const timeoutHandle = setTimeout(() => {
      try { session.kill(); } catch {}
      settle({ timedOut: true, exit: null, error: `session timeout after ${SESSION_TIMEOUT_MS}ms` });
    }, SESSION_TIMEOUT_MS);
    session.once('exit', onExit);
    session.once('error', onError);
    controlSocket.send(JSON.stringify({ type: 'start-session', id: session.id }));
  });
}

async function waitForKillReap(session) {
  if (!session?._killReap) return;
  let timeoutHandle = null;
  const timeout = new Promise((resolve) => {
    timeoutHandle = setTimeout(resolve, 5000);
  });
  await Promise.race([session._killReap, timeout]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
}

function sawPromptHook(hookSignals) {
  return hookSignals.some((signal) => String(signal?.event || '').toLowerCase() === 'userpromptsubmit');
}

function packCarrierWasPresent(spawnCalls, packDirectory) {
  const args = spawnCalls[0]?.args || [];
  const addDirectoryIndex = args.indexOf('--add-dir');
  return addDirectoryIndex >= 0 && args[addDirectoryIndex + 1] === packDirectory;
}

function modelWasPresent(spawnCalls, model) {
  const args = spawnCalls[0]?.args || [];
  const modelIndex = args.indexOf('--model');
  return modelIndex >= 0 && args[modelIndex + 1] === model;
}

async function runArm({
  arm,
  task,
  model,
  builtRoot,
  packDirectory,
  claudeConfigDirectory,
  controlSocket,
  backend,
  recordsPath,
}) {
  const startedAt = Date.now();
  const session = backend.getSession(arm.sessionId);
  const hookSignals = [];
  const promptPayloads = [];
  const spawnCalls = [];
  let outputTail = '';
  let executionError = null;
  let executionOutcome = null;
  if (!session) {
    executionError = `configured session ${arm.sessionId} was not created`;
  }
  if (session) {
    session._packsBuiltRoot = builtRoot;
    session._extraClaudeArgs = ['-p', '--max-turns', String(turnBudget(arm.armName, task.maxTurns)), '--model', model];
    session._initialPrompt = task.prompt;
    session._spawnEnv = {
      ...(session._spawnEnv || {}),
      CLAUDE_CONFIG_DIR: claudeConfigDirectory,
      NODE_PATH: REPOSITORY_NODE_MODULES,
    };
    const spawnPty = session._ptySpawn;
    session._ptySpawn = (file, args, spawnOptions) => {
      spawnCalls.push({ file, args: [...args], cwd: spawnOptions.cwd });
      return spawnPty(file, args, spawnOptions);
    };
    const ingestHookSignal = session.ingestHookSignal.bind(session);
    session.ingestHookSignal = (rawSignal) => {
      hookSignals.push(rawSignal);
      return ingestHookSignal(rawSignal);
    };
    session.on('user-prompt', (payload) => promptPayloads.push(payload));
    session.on('data', (chunk) => {
      outputTail = `${outputTail}${String(chunk)}`.slice(-8192);
    });
    try {
      executionOutcome = await waitForSessionExit(session, controlSocket);
    } catch (error) {
      executionError = error.message;
    } finally {
      try { session.kill(); } catch {}
      await waitForKillReap(session);
    }
    if (!executionError && executionOutcome?.error) executionError = executionOutcome.error;
    if (!executionError && !sawPromptHook(hookSignals)) executionError = 'UserPromptSubmit hook was not observed';
    if (!executionError && !modelWasPresent(spawnCalls, model)) executionError = `spawn did not use model ${model}`;
    if (!executionError && arm.armName === 'on' && !packCarrierWasPresent(spawnCalls, packDirectory)) {
      executionError = 'ON spawn did not carry the ablation pack';
    }
    if (!executionError && arm.armName === 'off' && spawnCalls[0]?.args.includes('--add-dir')) {
      executionError = 'OFF spawn unexpectedly carried a pack';
    }
  }
  const metricRecord = arm.armName === 'on'
    ? await waitForMetricRecord(recordsPath, arm.sessionId)
    : null;
  if (!executionError && arm.armName === 'on' && !metricRecord) {
    executionError = 'ON funnel record was not persisted';
  }
  const packRecord = metricRecord?.packs?.find((pack) => pack.name === PACK_NAME) || null;
  const check = runCheckCommand(task.checkCommand, arm.projectDirectory);
  return {
    outcome: armOutcome(executionError, check.passed),
    wallMs: Date.now() - startedAt,
    funnel: {
      opened: packRecord?.opened === true,
      filesRead: Number.isInteger(packRecord?.filesRead) ? packRecord.filesRead : 0,
      prompts: classifyObservedPrompts(promptPayloads),
    },
    execution: {
      timedOut: executionOutcome?.timedOut === true,
      exitCode: Number.isInteger(executionOutcome?.exit?.exitCode) ? executionOutcome.exit.exitCode : null,
      hookDriven: sawPromptHook(hookSignals),
      error: executionError,
      outputTail: executionError ? safeTextTail(outputTail) : '',
    },
    check,
  };
}

function restoreEnvironmentVariable(name, previousValue) {
  if (previousValue === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previousValue;
}

function printArm(taskId, seed, armName, armResult) {
  const label = armName.toUpperCase();
  console.log(
    `  ${taskId} seed=${seed} ${label} ${armResult.outcome.toUpperCase()}`
      + ` opened=${armResult.funnel.opened}`
      + ` filesRead=${armResult.funnel.filesRead}`
      + ` prompts=${promptCount(armResult.funnel.prompts)}`
      + ` wallMs=${armResult.wallMs}`,
  );
  if (armResult.execution.error) console.log(`    execution: ${armResult.execution.error}`);
  if (!armResult.check.passed) console.log(`    check: ${armResult.check.error || 'failed'}`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const tasks = readTasks(options.tasksPath, options.only);
  const outputPath = path.resolve(options.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, '', { encoding: 'utf8', flag: 'wx' });

  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'glissa-ablation-'));
  const configPath = path.join(tempDirectory, 'config.json');
  const recordsPath = path.join(tempDirectory, 'mill-metrics.json');
  const previousConfigPath = process.env.GLISSA_CONFIG;
  const previousPort = process.env.GLISSA_PORT;
  let backend = null;
  let controlSocket = null;
  let server = null;
  let invalidPairs = 0;
  let cleanupRun = null;
  const cleanUp = () => {
    if (cleanupRun) return cleanupRun;
    cleanupRun = (async () => {
      try { controlSocket?.terminate(); } catch {}
      try { await awaitBackendShutdown(backend); } catch (error) {
        console.error(`backend cleanup failed: ${error.message}`);
      }
      try { await closeServer(server); } catch (error) {
        console.error(`server cleanup failed: ${error.message}`);
      }
      removeHarnessTempDirectory(tempDirectory);
      restoreEnvironmentVariable('GLISSA_CONFIG', previousConfigPath);
      restoreEnvironmentVariable('GLISSA_PORT', previousPort);
    })();
    return cleanupRun;
  };
  const cleanUpAndExit = async (signalName) => {
    console.error(`\nreceived ${signalName}, killing sessions and removing ${tempDirectory}`);
    try { await cleanUp(); } catch (error) {
      console.error(`signal cleanup failed: ${error.message}`);
    }
    process.exit(130);
  };
  const onSigint = () => { void cleanUpAndExit('SIGINT'); };
  const onSigterm = () => { void cleanUpAndExit('SIGTERM'); };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    const pairs = buildPairs(tasks, options.seeds, tempDirectory);
    const port = await findFreeHighPort();
    writeAblationConfig(configPath, pairs, port);
    const { builtRoot, packDirectory } = makeAblationPack(tempDirectory);
    const projectDirectories = pairs.flatMap((pair) => [
      pair.arms.on.projectDirectory,
      pair.arms.off.projectDirectory,
    ]);
    const claudeConfigDirectory = makeClaudeConfig(tempDirectory, projectDirectories);
    process.env.GLISSA_CONFIG = configPath;
    process.env.GLISSA_PORT = String(port);
    const { createBackend } = require('../../server/backend');
    server = http.createServer();
    backend = createBackend(server, { staticDir: null, checkForUpdate: null });
    server.on('request', backend.app);
    await listen(server, port);
    controlSocket = await connectControl(port);

    console.log(`Model: ${options.model}`);
    console.log(`Output: ${outputPath}`);
    const completedPairs = [];
    for (const pair of pairs) {
      const orderLabel = pair.order.map((armName) => armName.toUpperCase()).join('/');
      console.log(`\nPair ${pair.task.id} seed=${pair.seed} order=${orderLabel}`);
      const armResults = {};
      for (const armName of pair.order) {
        armResults[armName] = await runArm({
          arm: pair.arms[armName],
          task: pair.task,
          model: options.model,
          builtRoot,
          packDirectory,
          claudeConfigDirectory,
          controlSocket,
          backend,
          recordsPath,
        });
        printArm(pair.task.id, pair.seed, armName, armResults[armName]);
      }
      const pairRecord = {
        version: 1,
        taskId: pair.task.id,
        seed: pair.seed,
        model: options.model,
        order: pair.order,
        on: armResults.on,
        off: armResults.off,
      };
      fs.appendFileSync(outputPath, `${JSON.stringify(pairRecord)}\n`, 'utf8');
      if (armResults.on.outcome === 'invalid' || armResults.off.outcome === 'invalid') {
        invalidPairs += 1;
        continue;
      }
      completedPairs.push({ on: armResults.on.outcome, off: armResults.off.outcome });
    }
    console.log('\nAblation summary');
    console.log(`Invalid pairs excluded: ${invalidPairs}`);
    console.table([summariseAblation(completedPairs)]);
  } finally {
    await cleanUp();
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
