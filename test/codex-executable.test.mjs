import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveCodexExecutable } from "../shared/codex-executable.mjs";
import { codexInvocation } from "../shared/codex-invocation.mjs";

test("Windows resolves the native npm vendor binary instead of the extensionless shim", () => {
  const appData = "C:\\Users\\fixture\\AppData\\Roaming";
  const vendor = `${appData}\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`;
  const resolved = resolveCodexExecutable({
    env: { APPDATA: appData, PATH: "C:\\Users\\fixture\\AppData\\Roaming\\npm" },
    platform: "win32",
    arch: "x64",
    fileExists: (candidate) => candidate === vendor,
  });
  assert.equal(resolved, vendor);
});

test("Windows runs an extensionless shebang Codex fixture through Node", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-invocation-"));
  const script = path.join(directory, "fake-codex");
  try {
    await writeFile(script, "#!/usr/bin/env node\n");
    const invocation = codexInvocation(script, ["app-server"], "win32");
    assert.equal(invocation.command, process.execPath);
    assert.deepEqual(invocation.args, [script, "app-server"]);
    assert.equal((await readFile(script, "utf8")).startsWith("#!"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows runs an extensionless shell Codex fixture through Bash", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-invocation-"));
  const script = path.join(directory, "fake-codex");
  try {
    await writeFile(script, "#!/bin/sh\n");
    const invocation = codexInvocation(script, ["mcp", "list"], "win32");
    assert.match(invocation.command, /(?:^|[\\/])bash(?:\.exe)?$/i);
    assert.deepEqual(invocation.args, [script, "mcp", "list"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows invokes a native executable directly without inspecting its contents", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-invocation-"));
  const executable = path.join(directory, "fake-codex.exe");
  try {
    await writeFile(executable, "#!/usr/bin/env node\n");
    const invocation = codexInvocation(executable, ["app-server"], "win32");
    assert.equal(invocation.command, executable);
    assert.deepEqual(invocation.args, ["app-server"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
