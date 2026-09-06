import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runLocalAutoCut } from "../server/autocut-local-runner.mjs";

async function waitForJson(filename, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(filename, "utf8"));
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for '${filename}'`);
}

async function fixture(scriptBody) {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-autocut-runner-"));
  const localAppData = path.join(root, "localappdata");
  const workspacePath = path.join(root, "Auto-Cut Lite workspace");
  const runtimeRoot = path.join(root, "installed runtime");
  const script = path.join(runtimeRoot, "scripts", "jy_wrapper.py");
  await Promise.all([
    mkdir(path.dirname(script), { recursive: true }),
    mkdir(workspacePath, { recursive: true }),
    mkdir(path.join(localAppData, "Auto-Cut", "auto-cut-lite"), { recursive: true }),
  ]);
  await writeFile(script, scriptBody, "utf8");
  await writeFile(
    path.join(localAppData, "Auto-Cut", "auto-cut-lite", "deployment-report.json"),
    JSON.stringify({
      deployment_status: "installed",
      workspace_root: workspacePath,
      runtime_root: runtimeRoot,
      components: { python: { runtime_path: process.execPath } },
    }),
    "utf8",
  );
  const jobRoot = path.join(root, "job");
  const outputRoot = path.join(root, "output");
  const run = {
    taskId: "task-fixed",
    runId: "run-fixed",
    subjectKey: "base:table",
    configVersion: 7,
    stageId: "initial",
    eventId: "event-fixed",
    manifestPath: path.join(jobRoot, "source manifest.json"),
    manifestSha256: "a".repeat(64),
    executionInputPath: path.join(jobRoot, "execution input.json"),
    draftsRoot: path.join(jobRoot, "drafts"),
    resultPath: path.join(jobRoot, "result.json"),
    packageZipPath: path.join(outputRoot, "course & exact.zip"),
  };
  return {
    root,
    localAppData,
    runtimeRoot,
    workspacePath,
    run,
    packageConfig: { workspacePath },
  };
}

test("launches the installed Auto-Cut runtime with only the bound run paths", async () => {
  const capturePath = path.join(os.tmpdir(), `taskboard-runner-capture-${process.pid}-${Date.now()}.json`);
  const current = await fixture(`
const { writeFileSync } = require("node:fs");
const keys = Object.keys(process.env).filter((key) => key.startsWith("CODEX_AUTOCUT_"));
writeFileSync(process.env.RUNNER_CAPTURE_PATH, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  env: Object.fromEntries(keys.map((key) => [key, process.env[key]])),
}));
process.stdout.write("fixture complete");
`);
  try {
    const result = await runLocalAutoCut({
      run: current.run,
      packageConfig: current.packageConfig,
      environment: {
        ...process.env,
        LOCALAPPDATA: current.localAppData,
        RUNNER_CAPTURE_PATH: capturePath,
        CODEX_AUTOCUT_UNTRUSTED: "must-not-reach-the-runtime",
      },
    });
    const capture = await waitForJson(capturePath);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(capture.args, [
      "review-document-run",
      "--source-manifest", current.run.manifestPath,
      "--execution-input", current.run.executionInputPath,
      "--job-root", path.dirname(current.run.manifestPath),
      "--drafts-root", current.run.draftsRoot,
      "--package-zip", current.run.packageZipPath,
      "--result-path", current.run.resultPath,
      "--json",
    ]);
    assert.equal(path.resolve(capture.cwd), path.resolve(current.runtimeRoot));
    assert.deepEqual(capture.env, {
      CODEX_AUTOCUT_CONFIG_VERSION: "7",
      CODEX_AUTOCUT_DRAFTS_ROOT: current.run.draftsRoot,
      CODEX_AUTOCUT_EVENT_ID: current.run.eventId,
      CODEX_AUTOCUT_EXECUTION_INPUT_PATH: current.run.executionInputPath,
      CODEX_AUTOCUT_JOB_ROOT: path.dirname(current.run.manifestPath),
      CODEX_AUTOCUT_PACKAGE_ZIP_PATH: current.run.packageZipPath,
      CODEX_AUTOCUT_RESULT_PATH: current.run.resultPath,
      CODEX_AUTOCUT_RUN_ID: current.run.runId,
      CODEX_AUTOCUT_SOURCE_MANIFEST_PATH: current.run.manifestPath,
      CODEX_AUTOCUT_SOURCE_MANIFEST_SHA256: current.run.manifestSha256,
      CODEX_AUTOCUT_STAGE_ID: current.run.stageId,
      CODEX_AUTOCUT_SUBJECT_KEY: current.run.subjectKey,
      CODEX_AUTOCUT_TASK_ID: current.run.taskId,
    });
  } finally {
    await rm(capturePath, { force: true });
    await rm(current.root, { recursive: true, force: true });
  }
});

test("terminates the local Auto-Cut process when Taskboard shuts down", async () => {
  const readyPath = path.join(os.tmpdir(), `taskboard-runner-ready-${process.pid}-${Date.now()}.json`);
  const current = await fixture(`
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.RUNNER_READY_PATH, "{}");
setInterval(() => {}, 1_000);
`);
  const controller = new AbortController();
  try {
    const pending = runLocalAutoCut({
      run: current.run,
      packageConfig: current.packageConfig,
      environment: {
        ...process.env,
        LOCALAPPDATA: current.localAppData,
        RUNNER_READY_PATH: readyPath,
      },
      signal: controller.signal,
    });
    await waitForJson(readyPath);
    controller.abort();
    await assert.rejects(
      pending,
      (error) => error?.code === "AUTOCUT_RUN_INTERRUPTED",
    );
  } finally {
    controller.abort();
    await rm(readyPath, { force: true });
    await rm(current.root, { recursive: true, force: true });
  }
});
