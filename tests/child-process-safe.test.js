"use strict";

// Unit tests for the child-process-safe wrapper: every spawn form must inject
// windowsHide:true (the burst-of-CMD-windows fix) while preserving the file,
// args, options, callback, return value, and the promisified {stdout,stderr}
// contract that teamlib/team-git.js depends on.
//
// The wrapper calls cp.<fn>(...) at CALL TIME on the shared node:child_process
// module object, so swapping a property on that object captures exactly what the
// wrapper forwards to the real implementation. Each spy is restored in finally.

const { test } = require("node:test");
const assert = require("node:assert");
const cp = require("node:child_process");
const { promisify } = require("node:util");
const safe = require("../server/child-process-safe");

function withSpy(name, impl, fn) {
  const orig = cp[name];
  cp[name] = impl;
  try {
    return fn();
  } finally {
    cp[name] = orig;
  }
}

test("hide() forces windowsHide:true, merged last, preserving other options", () => {
  assert.deepEqual(safe.hide(), { windowsHide: true });
  assert.deepEqual(safe.hide(undefined), { windowsHide: true });
  assert.deepEqual(safe.hide({ cwd: "x", timeout: 5 }), { cwd: "x", timeout: 5, windowsHide: true });
  // A caller cannot opt out: windowsHide is forced on even if explicitly false.
  assert.equal(safe.hide({ windowsHide: false }).windowsHide, true);
});

test("execFileSync injects windowsHide and forwards file/args/options + return value", () => {
  let cap;
  const out = withSpy(
    "execFileSync",
    (file, args, options) => {
      cap = { file, args, options };
      return "OUT";
    },
    () => safe.execFileSync("git", ["status", "--porcelain"], { cwd: "d", encoding: "utf8" }),
  );
  assert.equal(out, "OUT");
  assert.equal(cap.file, "git");
  assert.deepEqual(cap.args, ["status", "--porcelain"]);
  assert.equal(cap.options.cwd, "d");
  assert.equal(cap.options.windowsHide, true);
});

test("execFileSync with no args still injects windowsHide (2-arg form)", () => {
  let cap;
  withSpy(
    "execFileSync",
    (file, options) => {
      cap = { file, options };
      return "";
    },
    () => safe.execFileSync("where"),
  );
  assert.equal(cap.file, "where");
  assert.equal(cap.options.windowsHide, true);
});

test("execFile (callback form) injects windowsHide and forwards the callback", () => {
  let cap;
  let cbCalled = false;
  withSpy(
    "execFile",
    (file, args, options, callback) => {
      cap = { file, args, options, hasCb: typeof callback === "function" };
      callback(null, "stdout", "stderr");
    },
    () => safe.execFile("git", ["diff"], { cwd: "w" }, () => { cbCalled = true; }),
  );
  assert.equal(cap.file, "git");
  assert.deepEqual(cap.args, ["diff"]);
  assert.equal(cap.options.cwd, "w");
  assert.equal(cap.options.windowsHide, true);
  assert.equal(cap.hasCb, true);
  assert.equal(cbCalled, true);
});

test("taskkill-style execFile (args + options + callback) injects windowsHide", () => {
  let cap;
  withSpy(
    "execFile",
    (file, args, options, callback) => {
      cap = { file, args, options };
      callback(null, "", "");
    },
    () => safe.execFile("taskkill", ["/PID", "123", "/T", "/F"], {}, () => {}),
  );
  assert.equal(cap.file, "taskkill");
  assert.deepEqual(cap.args, ["/PID", "123", "/T", "/F"]);
  assert.equal(cap.options.windowsHide, true);
});

test("execSync injects windowsHide and returns the underlying result", () => {
  let cap;
  const out = withSpy(
    "execSync",
    (command, options) => {
      cap = { command, options };
      return "RESULT";
    },
    () => safe.execSync("where claude", { encoding: "utf8", timeout: 2000 }),
  );
  assert.equal(out, "RESULT");
  assert.equal(cap.command, "where claude");
  assert.equal(cap.options.timeout, 2000);
  assert.equal(cap.options.windowsHide, true);
});

test("spawn injects windowsHide (args form) and returns the child", () => {
  let cap;
  const child = withSpy(
    "spawn",
    (file, args, options) => {
      cap = { file, args, options };
      return { pid: 7 };
    },
    () => safe.spawn("cmd", ["/c", "start"], { detached: true, stdio: "ignore" }),
  );
  assert.deepEqual(child, { pid: 7 });
  assert.deepEqual(cap.args, ["/c", "start"]);
  assert.equal(cap.options.detached, true);
  assert.equal(cap.options.windowsHide, true);
});

test("spawn injects windowsHide (file + options form, no args)", () => {
  let cap;
  withSpy(
    "spawn",
    (file, options) => {
      cap = { file, options };
      return {};
    },
    () => safe.spawn("code .", { shell: true, detached: true }),
  );
  assert.equal(cap.file, "code .");
  assert.equal(cap.options.shell, true);
  assert.equal(cap.options.windowsHide, true);
});

test("promisify(execFile) resolves {stdout,stderr} AND injects windowsHide", async () => {
  let cap;
  const execFileP = promisify(safe.execFile);
  const r = await withSpy(
    "execFile",
    (_file, _args, options, callback) => {
      cap = options;
      callback(null, "the-stdout", "the-stderr");
    },
    () => execFileP("git", ["rev-parse", "HEAD"], { cwd: "d", encoding: "utf8" }),
  );
  assert.deepEqual(r, { stdout: "the-stdout", stderr: "the-stderr" });
  assert.equal(cap.windowsHide, true);
});

test("promisify(execFile) rejects with stdout/stderr attached (team-git's catch contract)", async () => {
  const execFileP = promisify(safe.execFile);
  const err = new Error("git failed");
  await assert.rejects(
    () =>
      withSpy(
        "execFile",
        (_file, _args, _options, callback) => callback(err, "partial-out", "the-err"),
        () => execFileP("git", ["merge"], {}),
      ),
    (thrown) => {
      assert.equal(thrown.stdout, "partial-out");
      assert.equal(thrown.stderr, "the-err");
      return true;
    },
  );
});

test("real end-to-end: execFileSync runs node and returns its stdout (no window)", () => {
  const out = safe
    .execFileSync(process.execPath, ["-e", "process.stdout.write('hello')"], { encoding: "utf8" })
    .trim();
  assert.equal(out, "hello");
});
