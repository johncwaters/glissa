"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { spawnSync } = require("node:child_process");

const { Session } = require("../session/sessions");
const { HookRouter } = require("../detection/hook-source");
const hookRelay = require("../session/hook-relay");
const adapters = require("../session/adapters");
const grok = require("../session/adapters/grok");
const {
  runAgentSetupCli,
  inspectGrokAgentSetup,
  ensureWritableHooksDirectory,
  replaceFileAtomically,
} = require("../server/agent-setup-cli");
const { renderGrokHooksFile, classifyGrokHooksFile } = require("../session/core/grok-hooks-file-core");

const GROK_SESSION_ID = "0198f4f7-53d7-7d9b-a610-e0633d7c9061";

function fakePty() {
  return { pid: 2147483645, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
}

function renderedHooks(relayPath = grok.RELAY_PATH) {
  return renderGrokHooksFile({ relayPath, events: grok.HOOK_EVENTS });
}

function writeHooks(grokHome, contents = renderedHooks()) {
  const hooksDirectory = path.join(grokHome, "hooks");
  fs.mkdirSync(hooksDirectory, { recursive: true });
  fs.writeFileSync(path.join(hooksDirectory, "glissa.json"), contents, "utf8");
}

function makeGrokSession(options = {}) {
  const calls = [];
  const session = new Session({
    id: options.id || "grok-session",
    name: options.name || "grok",
    path: process.cwd(),
    agent: "grok",
    spawnCommand: { path: "/opt/grok/bin/grok-1.0.5", kind: "exe" },
    ptySpawn: (file, args, spawnOptions) => {
      calls.push({ file, args, env: spawnOptions.env });
      return fakePty();
    },
    ...options,
  });
  return { session, calls };
}

function loadGrokHookFixture() {
  const fixturePath = path.join(__dirname, "fixtures", "v2-grok-background-subagent.jsonl");
  return fs.readFileSync(fixturePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((record) => record.type === "hook");
}

async function withGrokHome(run) {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "glissa-grok-test-"));
  const grokHome = path.join(tempDirectory, ".grok");
  const previousHome = process.env.GROK_HOME;
  process.env.GROK_HOME = grokHome;
  try {
    return await run(grokHome, tempDirectory);
  } finally {
    if (previousHome == null) delete process.env.GROK_HOME;
    if (previousHome != null) process.env.GROK_HOME = previousHome;
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

test("the registry exposes the Grok adapter with the honest capability set", () => {
  assert.equal(adapters.isKnownAgentId("grok"), true);
  assert.equal(adapters.getAdapter("grok"), grok);
  assert.equal(grok.usageVendor, "grok");
  assert.deepEqual(grok.capabilities, {
    hooks: true,
    awaitingInput: true,
    backgroundAgents: true,
    resume: true,
    packs: true,
    packNotice: true,
    statusLine: false,
    rtk: false,
    antiSlop: false,
    compactQuiet: false,
    skipPermissionsFlag: true,
    headless: true,
  });
});

test("the native binary resolver and spawn builder never select a shim", () => {
  const resolved = grok.resolveCommand({
    platform: "win32",
    env: { GROK_HOME: "C:\\Carbon\\.grok" },
    existsSync: () => true,
    realpathSync: (candidate) => `native:${candidate}`,
  });
  assert.deepEqual(resolved, { path: "native:C:\\Carbon\\.grok\\bin\\grok.exe", kind: "exe" });
  assert.deepEqual(
    grok.buildSpawnCommand({ resolved, settingsArgs: ["a"], packArgs: ["b"], agentArgs: ["c"] }),
    { file: resolved.path, args: ["a", "b", "c"] },
  );
  assert.throws(() => grok.buildSpawnCommand({ resolved: { path: null, kind: "unresolved" } }), /native grok binary/);
});

test("spawn args disable updates, map approval bypass, resume by id, and keep the prompt last", () => {
  assert.deepEqual(grok.buildArgs(), ["--no-auto-update"]);
  assert.deepEqual(grok.buildArgs({
    dangerouslySkipPermissions: true,
    resumeSessionId: GROK_SESSION_ID,
    extraArgs: ["--model", "grok-build"],
    initialPrompt: "THE PROMPT",
  }), [
    "--no-auto-update",
    "--always-approve",
    "-r",
    GROK_SESSION_ID,
    "--model",
    "grok-build",
    "THE PROMPT",
  ]);
  const env = grok.buildEnv({ PATH: "/bin", GROK_CLAUDE_HOOKS_ENABLED: "true" }, null, {});
  assert.equal(grok.CLAUDE_COMPAT_HOOKS_ENV, "GROK_CLAUDE_HOOKS_ENABLED");
  assert.equal(env.GROK_CLAUDE_HOOKS_ENABLED, "false");
});

test("pack delivery uses one --rules token with ordered index pointers", () => {
  assert.deepEqual(grok.renderPackArgs([
    { name: "alpha", dir: "/packs/alpha/current" },
    { name: "memory-project", dir: "/packs/memory-project/current" },
  ], "/packs"), [
    "--rules",
    `${grok.PACK_DIRECTIVE}; alpha: /packs/alpha/current/CLAUDE.md; memory-project: /packs/memory-project/current/CLAUDE.md`,
  ]);
  assert.deepEqual(grok.renderPackArgs([]), []);
  assert.equal(grok.renderPackArgs([{ name: "alpha", dir: "relative/current" }], "/packs"), null);
  assert.equal(grok.renderPackArgs([{ name: "alpha", dir: "/other/alpha/current" }], "/packs"), null);
});

test("the hook vocabulary maps turn outcomes without trusting nested sessions", () => {
  assert.equal(grok.mapHookToSignal("SessionStart", {}), "session-start");
  assert.equal(grok.mapHookToSignal("SessionEnd", {}), "session-end");
  assert.equal(grok.mapHookToSignal("UserPromptSubmit", {}), "resume");
  assert.equal(grok.mapHookToSignal("Stop", { reason: "end_turn" }), "ready");
  assert.equal(grok.mapHookToSignal("Stop", { reason: "shutdown" }), null);
  assert.equal(grok.mapHookToSignal("StopFailure", { error: "rate_limit" }), "ready");
  assert.equal(grok.mapHookToSignal("StopCancelled", { reason: "user_interrupt" }), "ready");
  assert.equal(grok.mapHookToSignal("Notification", { notificationType: "permission_prompt" }), "awaiting-input");
  assert.equal(grok.mapHookToSignal("Notification", { notificationType: "approval_required" }), "awaiting-input");
  assert.equal(grok.mapHookPromptKind("Notification", { notificationType: "permission_prompt" }), "permission");
  assert.equal(grok.mapHookToSignal("Notification", { notificationType: "idle_prompt" }), "ready");
  assert.equal(grok.mapHookConfidence("Notification", { notificationType: "idle_prompt" }), "low");
  assert.equal(grok.mapHookToSignal("SubagentStart", { subagentType: "general-purpose" }), "subagent-start");
  assert.equal(grok.mapHookToSignal("SubagentStop", { subagentType: "general-purpose" }), "subagent-stop");
  assert.equal(grok.mapHookToSignal("StopFailure", { subagentType: "explore" }), null);
  assert.equal(grok.mapHookToSignal("StopFailure", { subagent_type: "explore" }), null);
});

test("camelCase background fields map into the shared tracker vocabulary", () => {
  const payload = grok.mapHookPayload("Stop", {
    subagentId: "child-1",
    subagentType: "general-purpose",
    backgroundTasks: [{
      id: "child-1",
      type: "subagent",
      status: "running",
      agentType: "general-purpose",
    }],
  });
  assert.equal(payload.agent_id, "child-1");
  assert.equal(payload.agent_type, "general-purpose");
  assert.deepEqual(payload.background_tasks, [{
    id: "child-1",
    type: "subagent",
    status: "running",
    agentType: "general-purpose",
    agent_type: "general-purpose",
  }]);
  assert.equal(payload.backgroundTasks[0].agentType, "general-purpose");
});

test("the live background-subagent fixture gates until a later Stop declares the drain", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const records = loadGrokHookFixture();
  const hookRouter = new HookRouter();
  const { session } = makeGrokSession({
    hookRouter,
    statusConflictMs: 20,
    statusDedupMs: 10,
    gateReleaseSettleMs: 30,
  });
  session.state = "RUNNING";
  hookRouter.register("grok-session", {
    token: "fixture-token",
    hooks: grok.hooks,
    onSignal: (signal) => session.ingestHookSignal(signal),
  });

  const dispatch = (record) => hookRouter.handle({
    glissaId: "grok-session",
    token: "fixture-token",
    event: record.event,
    payload: record.payload,
  });
  dispatch(records[0]);
  assert.equal(session.toSnapshot().activeAgents, 1);
  dispatch(records[1]);
  t.mock.timers.tick(40);
  assert.equal(session.state, "RUNNING");
  assert.equal(session.toSnapshot().activeAgents, 1);
  dispatch(records[2]);
  assert.equal(session.toSnapshot().activeAgents, 1);
  dispatch(records[3]);
  t.mock.timers.tick(40);
  assert.equal(session.state, "COMPLETE");
  assert.equal(session.toSnapshot().activeAgents, 0);
  session.destroy();
});

test("the live fixture holds a notice-carrying Stop and completes once on the follow-up Stop", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const records = loadGrokHookFixture();
  const hookRouter = new HookRouter();
  const { session } = makeGrokSession({ hookRouter, statusConflictMs: 20, statusDedupMs: 10 });
  session.state = "RUNNING";
  session._packDelivery.replaceDelivered([{ name: "alpha", version: "v1" }]);
  assert.equal(session.notePackUpdate("alpha", "v2"), true);
  const completes = [];
  session.on("state-change", (event) => {
    if (event.to === "COMPLETE") completes.push(event);
  });
  hookRouter.register("grok-session", {
    token: "fixture-token",
    hooks: grok.hooks,
    onSignal: (signal) => session.ingestHookSignal(signal),
  });
  const dispatch = (record) => hookRouter.handle({
    glissaId: "grok-session",
    token: "fixture-token",
    event: record.event,
    payload: record.payload,
  });

  dispatch(records[3]);
  t.mock.timers.tick(40);
  assert.equal(session.state, "RUNNING");
  assert.equal(completes.length, 0);
  assert.match(session.takePackNoticeContext(), /Context pack updated/);
  dispatch(records[4]);
  t.mock.timers.tick(40);
  assert.equal(session.state, "COMPLETE");
  assert.equal(completes.length, 1);
  session.destroy();
});

test("the live fixture completes a notice-less Stop immediately", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const records = loadGrokHookFixture();
  const hookRouter = new HookRouter();
  const { session } = makeGrokSession({ hookRouter, statusConflictMs: 20, statusDedupMs: 10 });
  session.state = "RUNNING";
  hookRouter.register("grok-session", {
    token: "fixture-token",
    hooks: grok.hooks,
    onSignal: (signal) => session.ingestHookSignal(signal),
  });

  hookRouter.handle({
    glissaId: "grok-session",
    token: "fixture-token",
    event: records[3].event,
    payload: records[3].payload,
  });
  t.mock.timers.tick(40);
  assert.equal(session.state, "COMPLETE");
  session.destroy();
});

test("Claude compatibility settings that can carry hooks are detected conservatively", () => {
  assert.deepEqual(grok.PROJECT_CONFIG_CANDIDATES, [
    { relPath: ".claude/settings.json", presenceIsHit: false },
    { relPath: ".claude/settings.local.json", presenceIsHit: false },
  ]);
  assert.equal(grok.mayContributeHooks('{"hooks":{}}'), true);
  assert.equal(grok.mayContributeHooks('{"permissions":{}}'), false);
  assert.equal(grok.mayContributeHooks("not json"), true);
});

test("the title tier recognizes only captured markers and never guesses ready", () => {
  assert.equal(grok.classifyTitle(`${String.fromCodePoint(0x283b)} session`), "working");
  assert.equal(grok.classifyTitle(`${grok.ACTION_REQUIRED_MARKER} Action required`), "awaiting-input");
  assert.equal(grok.classifyTitle("generated session name"), "unknown");
  assert.equal(grok.classifyTitle("npm test"), "unknown");
  assert.equal(grok.classifyTitle("C:\\Windows\\system32\\cmd.exe"), "ignore");
});

test("the setup core renders seven env-inert hooks and distinguishes managed and foreign files", () => {
  const rendered = renderedHooks("/opt/glissa/session/hook-relay.js");
  const parsed = JSON.parse(rendered);
  assert.deepEqual(Object.keys(parsed.hooks), grok.HOOK_EVENTS);
  assert.equal(rendered.includes("GLISSA_HOOK_URL"), false);
  assert.equal(/[?&]t=/.test(rendered), false);
  assert.equal(classifyGrokHooksFile(rendered, {
    relayPath: "/opt/glissa/session/hook-relay.js",
    events: grok.HOOK_EVENTS,
  }), "current");
  assert.equal(classifyGrokHooksFile(rendered, {
    relayPath: "/new/glissa/session/hook-relay.js",
    events: grok.HOOK_EVENTS,
  }), "managed-stale");
  const priorManaged = renderGrokHooksFile({
    relayPath: "/opt/glissa/session/hook-relay.js",
    events: grok.MANAGED_HOOK_EVENT_SETS[0],
  });
  assert.equal(classifyGrokHooksFile(priorManaged, {
    relayPath: "/opt/glissa/session/hook-relay.js",
    events: grok.HOOK_EVENTS,
    managedEventSets: grok.MANAGED_HOOK_EVENT_SETS,
  }), "managed-stale");
  assert.equal(classifyGrokHooksFile('{"hooks":{"Stop":[]}}', {
    relayPath: "/opt/glissa/session/hook-relay.js",
    events: grok.HOOK_EVENTS,
  }), "foreign");
  const hostile = rendered.replace("node /opt/glissa/session/hook-relay.js Stop", "node /opt/glissa/session/hook-relay.js;touch /tmp/x Stop");
  assert.equal(classifyGrokHooksFile(hostile, {
    relayPath: "/opt/glissa/session/hook-relay.js",
    events: grok.HOOK_EVENTS,
  }), "foreign");
});

test("the setup command installs, refreshes managed bytes, and refuses a foreign file", async () => {
  await withGrokHome(async (grokHome) => {
    const output = [];
    const errors = [];
    const deps = { env: process.env, log: (line) => output.push(line), error: (line) => errors.push(line) };
    assert.equal(runAgentSetupCli(["setup", "grok"], deps), 0);
    assert.equal(inspectGrokAgentSetup({ env: process.env }).classification, "current");
    assert.equal(runAgentSetupCli(["setup", "grok"], deps), 0);
    assert.equal(output.some((line) => line.includes("already current")), true);
    const target = path.join(grokHome, "hooks", "glissa.json");
    fs.writeFileSync(target, renderGrokHooksFile({
      relayPath: grok.RELAY_PATH,
      events: grok.MANAGED_HOOK_EVENT_SETS[0],
    }), "utf8");
    assert.equal(runAgentSetupCli(["setup", "grok"], deps), 0);
    assert.equal(inspectGrokAgentSetup({ env: process.env }).classification, "current");
    fs.writeFileSync(target, '{"hooks":{"Stop":[]}}', "utf8");
    assert.equal(runAgentSetupCli(["setup", "grok"], deps), 1);
    assert.equal(fs.readFileSync(target, "utf8"), '{"hooks":{"Stop":[]}}');
    assert.equal(errors.some((line) => line.includes("Refusing to replace")), true);
  });
});

test("the setup command refuses symlinked Grok ancestors", async () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "glissa-grok-symlink-test-"));
  try {
    const realGrokHome = path.join(tempDirectory, "real-grok-home");
    const linkedGrokHome = path.join(tempDirectory, "linked-grok-home");
    fs.mkdirSync(realGrokHome);
    fs.symlinkSync(realGrokHome, linkedGrokHome, "dir");
    assert.throws(
      () => ensureWritableHooksDirectory(path.join(linkedGrokHome, "hooks"), fs),
      /is not a real directory/,
    );
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test("atomic hook replacement creates a private sibling before rename", () => {
  const calls = [];
  const fileSystem = {
    writeFileSync(filePath, contents, options) {
      calls.push({ operation: "write", filePath, contents, options });
    },
    renameSync(source, target) {
      calls.push({ operation: "rename", source, target });
    },
    chmodSync(filePath, mode) {
      calls.push({ operation: "chmod", filePath, mode });
    },
    rmSync() {
      assert.fail("successful replacement must not clean up the temporary file");
    },
  };
  replaceFileAtomically("/safe/hooks/glissa.json", "managed", fileSystem);
  assert.equal(calls[0].operation, "write");
  assert.match(calls[0].filePath, /^\/safe\/hooks\/glissa\.json\.[^.]+\.[0-9a-f]+\.tmp$/);
  assert.deepEqual(calls[0].options, { encoding: "utf8", mode: 0o600, flag: "wx" });
  assert.deepEqual(calls[1], {
    operation: "rename",
    source: calls[0].filePath,
    target: "/safe/hooks/glissa.json",
  });
  assert.deepEqual(calls[2], { operation: "chmod", filePath: "/safe/hooks/glissa.json", mode: 0o600 });
});

test("the live Grok probe keeps recordings only behind the explicit flag", () => {
  const help = spawnSync(process.execPath, [path.join(__dirname, "..", "test", "probe-grok-session.js"), "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /\[--keep\]/);
  assert.match(help.stdout, /full authenticated PTY transcript/);
});

test("every installed relay command exits inert without the supervised spawn environment", async () => {
  const parsed = JSON.parse(renderedHooks());
  let socketCalls = 0;
  const originalRequest = http.request;
  http.request = (...requestArgs) => {
    socketCalls += 1;
    return originalRequest(...requestArgs);
  };
  try {
    for (const event of grok.HOOK_EVENTS) {
      const command = parsed.hooks[event][0].hooks[0].command;
      const spawned = spawnSync(command, {
        shell: true,
        input: JSON.stringify({ hookEventName: event, sessionId: GROK_SESSION_ID }),
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      });
      assert.equal(spawned.status, 0, `${event}: ${spawned.stderr}`);
      const relayResult = await hookRelay.main(
        [event],
        Readable.from(["{}"]),
        {},
        { write() {} },
      );
      assert.deepEqual(relayResult, { code: 0, reason: "no-hook-url" });
    }
  } finally {
    http.request = originalRequest;
  }
  assert.equal(socketCalls, 0);
});

test("a validated home hook file mints a token and camelCase payloads capture the stable id", async () => {
  await withGrokHome(async (grokHome, homeDirectory) => {
    writeHooks(grokHome);
    const projectDirectory = path.join(homeDirectory, "project");
    fs.mkdirSync(projectDirectory);
    const hookRouter = new HookRouter();
    const { session, calls } = makeGrokSession({ path: projectDirectory, hookRouter, getHookPort: () => 4321 });
    await session.start();
    assert.equal(calls[0].file, "/opt/grok/bin/grok-1.0.5");
    assert.deepEqual(calls[0].args, ["--no-auto-update"]);
    assert.equal(calls[0].env.GROK_CLAUDE_HOOKS_ENABLED, "false");
    assert.match(calls[0].env.GLISSA_HOOK_URL, /^http:\/\/127\.0\.0\.1:4321\/hook\/grok-session\?t=[0-9a-f]{64}$/);
    assert.equal(calls[0].args.some((arg) => arg.includes(session._hooks.token())), false);
    const token = session._hooks.token();
    assert.equal(hookRouter.handle({
      glissaId: "grok-session",
      event: "userpromptsubmit",
      token,
      payload: { sessionId: GROK_SESSION_ID },
    }).signal, "resume");
    assert.equal(session._resumeSessionId, GROK_SESSION_ID);
    session.destroy();
  });
});

test("Claude home settings refuse relay hooks only when they could contribute hooks", async () => {
  await withGrokHome(async (grokHome, homeDirectory) => {
    writeHooks(grokHome);
    const projectDirectory = path.join(homeDirectory, "projects", "app");
    const claudeDirectory = path.join(homeDirectory, ".claude");
    fs.mkdirSync(projectDirectory, { recursive: true });
    fs.mkdirSync(claudeDirectory);

    for (const settingsName of ["settings.json", "settings.local.json"]) {
      const settingsPath = path.join(claudeDirectory, settingsName);
      fs.writeFileSync(settingsPath, '{"hooks":{"Stop":[]}}', "utf8");
      const refused = makeGrokSession({
        id: `grok-home-hooks-${settingsName}`,
        path: projectDirectory,
        hookRouter: new HookRouter(),
        getHookPort: () => 4321,
      });
      await refused.session.start();
      assert.equal(refused.session._hooks.token(), null);
      assert.equal(refused.calls[0].env.GLISSA_HOOK_URL, undefined);
      const refusal = refused.session.getDebugState().decisions.find((decision) => decision.decision === "injection-refused");
      assert.equal(refusal.reason, "Claude compatibility settings could contribute hooks");
      assert.equal(refusal.agent, "grok");
      refused.session.destroy();
      fs.rmSync(settingsPath);
    }

    fs.writeFileSync(path.join(claudeDirectory, "settings.json"), '{"permissions":{}}', "utf8");
    const allowed = makeGrokSession({
      id: "grok-home-benign",
      path: projectDirectory,
      hookRouter: new HookRouter(),
      getHookPort: () => 4321,
    });
    await allowed.session.start();
    assert.match(allowed.calls[0].env.GLISSA_HOOK_URL, /^http:\/\/127\.0\.0\.1:4321\/hook\/grok-home-benign\?t=[0-9a-f]{64}$/);
    assert.notEqual(allowed.session._hooks.token(), null);
    allowed.session.destroy();
  });
});

test("a missing or foreign home hook file never mints a token", async () => {
  await withGrokHome(async (grokHome, homeDirectory) => {
    const projectDirectory = path.join(homeDirectory, "project");
    fs.mkdirSync(projectDirectory);
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...parts) => warnings.push(parts.join(" "));
    try {
      const missing = makeGrokSession({ id: "grok-missing", path: projectDirectory, hookRouter: new HookRouter(), getHookPort: () => 4321 });
      await missing.session.start();
      assert.equal(missing.session._hooks.token(), null);
      assert.equal(missing.calls[0].env.GLISSA_HOOK_URL, undefined);
      missing.session.destroy();
      writeHooks(grokHome, '{"hooks":{"Stop":[]}}');
      const foreign = makeGrokSession({ id: "grok-foreign", path: projectDirectory, hookRouter: new HookRouter(), getHookPort: () => 4321 });
      await foreign.session.start();
      assert.equal(foreign.session._hooks.token(), null);
      assert.equal(foreign.calls[0].env.GLISSA_HOOK_URL, undefined);
      foreign.session.destroy();
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.filter((warning) => warning.includes("glissa agent setup grok")).length, 2);
  });
});
