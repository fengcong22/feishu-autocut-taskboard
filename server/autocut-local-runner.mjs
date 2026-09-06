import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { signalProcessTree } from "../shared/process-tree.mjs";

function runnerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function collect(stream) {
  return new Promise((resolve) => {
    let value = "";
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk) => {
      if (value.length < 64 * 1024) value += chunk;
    });
    stream?.on("end", () => resolve(value));
    if (!stream) resolve(value);
  });
}

function runtimeEnvironment(environment, run) {
  return {
    ...Object.fromEntries(Object.entries(environment).filter(
      ([key]) => !key.toUpperCase().startsWith("CODEX_AUTOCUT_"),
    )),
    CODEX_AUTOCUT_SOURCE_MANIFEST_PATH: run.manifestPath,
    CODEX_AUTOCUT_SOURCE_MANIFEST_SHA256: run.manifestSha256,
    CODEX_AUTOCUT_EXECUTION_INPUT_PATH: run.executionInputPath,
    CODEX_AUTOCUT_JOB_ROOT: path.dirname(run.manifestPath),
    CODEX_AUTOCUT_DRAFTS_ROOT: run.draftsRoot,
    CODEX_AUTOCUT_RESULT_PATH: run.resultPath,
    CODEX_AUTOCUT_PACKAGE_ZIP_PATH: run.packageZipPath,
    CODEX_AUTOCUT_TASK_ID: run.taskId,
    CODEX_AUTOCUT_RUN_ID: run.runId,
    CODEX_AUTOCUT_SUBJECT_KEY: run.subjectKey,
    CODEX_AUTOCUT_CONFIG_VERSION: String(run.configVersion),
    CODEX_AUTOCUT_STAGE_ID: run.stageId,
    CODEX_AUTOCUT_EVENT_ID: run.eventId,
  };
}

async function resolveInstalledRuntime(workspacePath, environment) {
  if (typeof workspacePath !== "string" || !path.isAbsolute(workspacePath)) {
    throw runnerError("AUTOCUT_RUNTIME_UNAVAILABLE", "Auto-Cut package workspace is unavailable");
  }
  const localAppData = environment.LOCALAPPDATA;
  if (!localAppData || !path.isAbsolute(localAppData)) {
    throw runnerError("AUTOCUT_RUNTIME_UNAVAILABLE", "Auto-Cut local runtime is unavailable");
  }
  const reportPath = path.join(localAppData, "Auto-Cut", "auto-cut-lite", "deployment-report.json");
  let report;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"));
  } catch {
    throw runnerError("AUTOCUT_RUNTIME_UNAVAILABLE", "Auto-Cut deployment report is unavailable");
  }
  if (
    report?.deployment_status !== "installed"
    || path.resolve(report.workspace_root ?? "") !== path.resolve(workspacePath)
    || !path.isAbsolute(report.runtime_root ?? "")
    || !path.isAbsolute(report.components?.python?.runtime_path ?? "")
  ) {
    throw runnerError("AUTOCUT_RUNTIME_UNAVAILABLE", "Auto-Cut deployment does not match the registered package");
  }
  const runtimeRoot = await realpath(report.runtime_root);
  const python = await realpath(report.components.python.runtime_path);
  const script = await realpath(path.join(runtimeRoot, "scripts", "jy_wrapper.py"));
  const [pythonInfo, scriptInfo] = await Promise.all([stat(python), stat(script)]);
  if (!pythonInfo.isFile() || !scriptInfo.isFile()) {
    throw runnerError("AUTOCUT_RUNTIME_UNAVAILABLE", "Auto-Cut local runner is unavailable");
  }
  return { runtimeRoot, python, script };
}

async function runProcess(command, args, options, signal = null) {
  const child = spawn(command, args, {
    ...options,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const abort = () => signalProcessTree(child, "SIGTERM");
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  let exitCode;
  try {
    exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  return { exitCode, stdout: await stdout, stderr: await stderr };
}

export async function runLocalAutoCut({ run, packageConfig, environment = process.env, signal } = {}) {
  const { runtimeRoot, python, script } = await resolveInstalledRuntime(
    packageConfig.workspacePath,
    environment,
  );
  const args = [
    script,
    "review-document-run",
    "--source-manifest", run.manifestPath,
    "--execution-input", run.executionInputPath,
    "--job-root", path.dirname(run.manifestPath),
    "--drafts-root", run.draftsRoot,
    "--package-zip", run.packageZipPath,
    "--result-path", run.resultPath,
    "--json",
  ];
  const result = await runProcess(python, args, {
    cwd: runtimeRoot,
    env: runtimeEnvironment(environment, run),
  }, signal);
  if (signal?.aborted) {
    throw runnerError("AUTOCUT_RUN_INTERRUPTED", "Auto-Cut was interrupted because Taskboard is shutting down");
  }
  if (result.exitCode !== 0) {
    throw runnerError(
      "autocut_process_failed",
      (result.stderr || result.stdout).trim().slice(-2_000) || "The Auto-Cut process did not complete successfully",
    );
  }
  return result;
}
