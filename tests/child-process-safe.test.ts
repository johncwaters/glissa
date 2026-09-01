import { test } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import type { ExecException } from "node:child_process";

import * as safe from "../server/child-process-safe.ts";
import type { ExecFileCallback } from "../server/child-process-safe.ts";

const childProcessModule: Record<string, unknown> = createRequire(import.meta.url)("node:child_process");

type Spy = (...args: never[]) => unknown;

interface Capture {
  file?: string;
  command?: string;
  args?: readonly string[];
  options?: Record<string, unknown>;
  hasCallback?: boolean;
}

function withSpy<T>(name: string, impl: Spy, run: () => T): T {
  const original = childProcessModule[name];
  childProcessModule[name] = impl;
  try {
    return run();
  } finally {
    childProcessModule[name] = original;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

test("hide() forces windowsHide:true, merged last, preserving other options", () => {
  assert.deepEqual(safe.hide(undefined), { windowsHide: true });
  assert.deepEqual(safe.hide({ cwd: "x", timeout: 5 }), { cwd: "x", timeout: 5, windowsHide: true });

  assert.equal(safe.hide({ windowsHide: false }).windowsHide, true);
});

test("execFileSync injects windowsHide and forwards file/args/options + return value", () => {
  const capture: Capture = {};
  const out = withSpy(
    "execFileSync",
    (file: string, args: readonly string[], options: Record<string, unknown>) => {
      Object.assign(capture, { file, args, options });
      return "OUT";
    },
    () => safe.execFileSync("git", ["status", "--porcelain"], { cwd: "d", encoding: "utf8" }),
  );
  assert.equal(out, "OUT");
  assert.equal(capture.file, "git");
  assert.deepEqual(capture.args, ["status", "--porcelain"]);
  assert.equal(capture.options?.cwd, "d");
  assert.equal(capture.options?.windowsHide, true);
});

test("execFileSync with no args still injects windowsHide (2-arg form)", () => {
  const capture: Capture = {};
  withSpy(
    "execFileSync",
    (file: string, options: Record<string, unknown>) => {
      Object.assign(capture, { file, options });
      return "";
    },
    () => safe.execFileSync("where"),
  );
  assert.equal(capture.file, "where");
  assert.equal(capture.options?.windowsHide, true);
});

test("execFile (callback form) injects windowsHide and forwards the callback", () => {
  const capture: Capture = {};
  let wasCallbackCalled = false;
  withSpy(
    "execFile",
    (file: string, args: readonly string[], options: Record<string, unknown>, callback: ExecFileCallback) => {
      Object.assign(capture, { file, args, options, hasCallback: typeof callback === "function" });
      callback(null, "stdout", "stderr");
    },
    () => safe.execFile("git", ["diff"], { cwd: "w" }, () => { wasCallbackCalled = true; }),
  );
  assert.equal(capture.file, "git");
  assert.deepEqual(capture.args, ["diff"]);
  assert.equal(capture.options?.cwd, "w");
  assert.equal(capture.options?.windowsHide, true);
  assert.equal(capture.hasCallback, true);
  assert.equal(wasCallbackCalled, true);
});

test("taskkill-style execFile (args + options + callback) injects windowsHide", () => {
  const capture: Capture = {};
  withSpy(
    "execFile",
    (file: string, args: readonly string[], options: Record<string, unknown>, callback: ExecFileCallback) => {
      Object.assign(capture, { file, args, options });
      callback(null, "", "");
    },
    () => safe.execFile("taskkill", ["/PID", "123", "/T", "/F"], {}, () => {}),
  );
  assert.equal(capture.file, "taskkill");
  assert.deepEqual(capture.args, ["/PID", "123", "/T", "/F"]);
  assert.equal(capture.options?.windowsHide, true);
});

test("execSync injects windowsHide and returns the underlying result", () => {
  const capture: Capture = {};
  const out = withSpy(
    "execSync",
    (command: string, options: Record<string, unknown>) => {
      Object.assign(capture, { command, options });
      return "RESULT";
    },
    () => safe.execSync("where claude", { encoding: "utf8", timeout: 2000 }),
  );
  assert.equal(out, "RESULT");
  assert.equal(capture.command, "where claude");
  assert.equal(capture.options?.timeout, 2000);
  assert.equal(capture.options?.windowsHide, true);
});

test("spawn injects windowsHide (args form) and returns the child", () => {
  const capture: Capture = {};
  const child = withSpy(
    "spawn",
    (file: string, args: readonly string[], options: Record<string, unknown>) => {
      Object.assign(capture, { file, args, options });
      return { pid: 7 };
    },
    () => safe.spawn("cmd", ["/c", "start"], { detached: true, stdio: "ignore" }),
  );
  assert.deepEqual(child, { pid: 7 });
  assert.deepEqual(capture.args, ["/c", "start"]);
  assert.equal(capture.options?.detached, true);
  assert.equal(capture.options?.windowsHide, true);
});

test("spawn injects windowsHide (file + options form, no args)", () => {
  const capture: Capture = {};
  withSpy(
    "spawn",
    (file: string, options: Record<string, unknown>) => {
      Object.assign(capture, { file, options });
      return {};
    },
    () => safe.spawn("code .", { shell: true, detached: true }),
  );
  assert.equal(capture.file, "code .");
  assert.equal(capture.options?.shell, true);
  assert.equal(capture.options?.windowsHide, true);
});

test("promisify(execFile) resolves {stdout,stderr} AND injects windowsHide", async () => {
  const capture: Capture = {};
  const execFileAsync = promisify(safe.execFile);
  const result = await withSpy(
    "execFile",
    (_file: string, _args: readonly string[], options: Record<string, unknown>, callback: ExecFileCallback) => {
      Object.assign(capture, { options });
      callback(null, "the-stdout", "the-stderr");
    },
    () => execFileAsync("git", ["rev-parse", "HEAD"], { cwd: "d", encoding: "utf8" }),
  );
  assert.deepEqual(result, { stdout: "the-stdout", stderr: "the-stderr" });
  assert.equal(capture.options?.windowsHide, true);
});

test("promisify(execFile) rejects with stdout/stderr attached (git-workspace's catch contract)", async () => {
  const execFileAsync = promisify(safe.execFile);
  const failure: ExecException = Object.assign(new Error("git failed"), { cmd: "git merge" });
  await assert.rejects(
    () =>
      withSpy(
        "execFile",
        (_file: string, _args: readonly string[], _options: Record<string, unknown>, callback: ExecFileCallback) =>
          callback(failure, "partial-out", "the-err"),
        () => execFileAsync("git", ["merge"], {}),
      ),
    (thrown: unknown) => {
      assert.ok(isRecord(thrown));
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
