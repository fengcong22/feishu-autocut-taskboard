import { mkdir, realpath, stat, writeFile, rename } from "node:fs/promises";
import path from "node:path";

import {
  createSourceManifest,
  writeSourceManifest,
} from "./feishu-source-manifest.mjs";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

function fail(code, message, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function text(value, name) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw fail("AUTOCUT_RUN_INPUT_INVALID", `${name} is invalid`, 400);
  }
  return value.trim();
}

function identifier(value, name) {
  const normalized = text(value, name);
  if (!RUN_ID.test(normalized)) throw fail("AUTOCUT_RUN_INPUT_INVALID", `${name} is invalid`, 400);
  return normalized;
}

function safeName(value, name) {
  const normalized = text(value, name);
  if (
    CONTROL.test(normalized)
    || normalized === "."
    || normalized === ".."
    || /[\\/]/u.test(normalized)
    || normalized.length > 240
  ) {
    throw fail("AUTOCUT_NAMING_INVALID", `${name} is invalid`, 409);
  }
  return normalized;
}

function sourceToManifest(source, name) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw fail("AUTOCUT_SOURCE_INVALID", `${name} is invalid`, 409);
  }
  const kind = source.kind;
  if (kind === "docx_section") {
    return { kind, anchor_text: text(source.anchorText ?? source.anchor_text, `${name}.anchorText`) };
  }
  if (kind === "base_attachment") {
    return {
      kind,
      field_id: identifier(source.fieldId ?? source.field_id, `${name}.fieldId`),
    };
  }
  throw fail("AUTOCUT_SOURCE_INVALID", `${name}.kind is unsupported`, 409);
}

function stageFor(origin, subjectVersion) {
  const stageId = text(origin.stageId ?? origin.stage_id, "origin.stageId");
  const stages = subjectVersion?.stages;
  const stage = stages?.[stageId];
  if (!stage || typeof stage !== "object") throw fail("AUTOCUT_STAGE_CONFIG_MISSING", `Stage '${stageId}' is unavailable`);
  return { stageId, stage };
}

async function atomicJson(filename, value) {
  const temporary = `${filename}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await rename(temporary, filename);
  } catch (error) {
    try { await rename(temporary, `${filename}.${Date.now()}.tmp`); } catch {}
    throw error;
  }
}

function packageZipFilename(artifactName) {
  return `${artifactName}.zip`;
}

/**
 * Build the immutable files and paths used by one trusted phased Auto-Cut run.
 * All source descriptors remain opaque; no Feishu cell is interpreted as a
 * path, command, or prompt.
 */
export async function prepareFeishuRunInputs({
  dataDirectory,
  task,
  run,
  origin,
  subjectVersion,
  packageSnapshot,
  controlledContext,
}) {
  const root = path.resolve(text(dataDirectory, "dataDirectory"));
  const taskId = identifier(task?.id ?? origin?.taskId, "task.id");
  const runId = identifier(run?.runId ?? run?.id, "run.id");
  const { stageId, stage } = stageFor(origin, subjectVersion);
  const subjectKey = text(origin.subjectKey, "origin.subjectKey");
  const configVersion = origin.configVersion;
  if (!Number.isSafeInteger(configVersion) || configVersion < 1) {
    throw fail("AUTOCUT_RUN_INPUT_INVALID", "origin.configVersion is invalid", 400);
  }
  const eventId = text(origin.eventId, "origin.eventId");
  const baseToken = text(origin.baseToken, "origin.baseToken");
  const tableId = text(origin.tableId, "origin.tableId");
  const recordId = text(origin.recordId, "origin.recordId");
  const links = controlledContext?.documentLinks;
  if (!Array.isArray(links) || links.length === 0) {
    throw fail("document_link_missing", "Exactly one Feishu Docx document link is required");
  }
  if (links.length !== 1) {
    throw fail("document_link_ambiguous", "Exactly one Feishu Docx document link is required");
  }
  if (typeof controlledContext?.namingDisplayValue !== "string"
    || controlledContext.namingDisplayValue.trim() === "") {
    throw fail("naming_value_missing", "The naming field result is empty");
  }
  const naming = safeName(controlledContext.namingDisplayValue, "namingDisplayValue");
  if (controlledContext?.namingValueUnique !== true) {
    throw fail("naming_value_not_unique", "The naming field result is not proven unique");
  }
  const suffix = safeName(stage.nameSuffix ?? stage.name_suffix, "stage.nameSuffix");
  const artifactName = safeName(`${naming}${suffix}`, "artifactName");
  const jobRoot = path.join(root, "autocut-runs", taskId, runId);
  const draftsRoot = path.join(jobRoot, "drafts");
  await mkdir(draftsRoot, { recursive: true, mode: 0o700 });

  const packageDirectoryInput = packageSnapshot?.zipSourceDirectory ?? packageSnapshot?.artifactSourcePath;
  const packageDirectory = text(packageDirectoryInput, "packageSnapshot.zipSourceDirectory");
  if (!path.isAbsolute(packageDirectory)) {
    throw fail("AUTOCUT_PACKAGE_SOURCE_UNAVAILABLE", "The package ZIP source directory must be absolute");
  }
  let packageRoot;
  try {
    packageRoot = await realpath(packageDirectory);
    if (!(await stat(packageRoot)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw fail("AUTOCUT_PACKAGE_SOURCE_UNAVAILABLE", "The package ZIP source directory is unavailable");
  }
  const outputRoot = path.join(packageRoot, ".taskboard-autocut", taskId, runId);
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const packageZipPath = path.join(outputRoot, packageZipFilename(artifactName));
  const resultPath = path.join(jobRoot, "result.json");
  const manifestPath = path.join(jobRoot, "source-manifest.json");
  const executionInputPath = path.join(jobRoot, "execution_input.json");
  const manifestInput = {
    binding: {
      task_id: taskId,
      run_id: runId,
      subject_key: subjectKey,
      config_version: configVersion,
      stage_id: stageId,
      event_id: eventId,
    },
    record: {
      base_token: baseToken,
      table_id: tableId,
      record_id: recordId,
    },
    document: {
      field_id: text(subjectVersion?.documentField?.fieldId, "documentField.fieldId"),
      url: links[0],
    },
    sources: {
      video: sourceToManifest(stage.videoSource ?? stage.video_source, "videoSource"),
      review: sourceToManifest(stage.reviewSource ?? stage.review_source, "reviewSource"),
      audio: (() => {
        const audio = stage.audio;
        if (!audio || typeof audio !== "object" || Array.isArray(audio)) throw fail("AUTOCUT_AUDIO_INVALID", "Stage audio configuration is invalid");
        const mode = text(audio.mode, "audio.mode");
        if (mode === "video_original") return { mode };
        if (mode !== "replace_original") throw fail("AUTOCUT_AUDIO_INVALID", "audio.mode is invalid");
        const tolerance = audio.durationToleranceSeconds ?? audio.duration_tolerance_seconds ?? 3;
        if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance <= 0) {
          throw fail("AUTOCUT_AUDIO_INVALID", "audio.durationToleranceSeconds is invalid");
        }
        return {
          mode,
          duration_tolerance_seconds: tolerance,
          source: sourceToManifest(audio.source, "audio.source"),
        };
      })(),
    },
  };
  const created = createSourceManifest(manifestInput);
  await writeSourceManifest(manifestPath, created.manifest);
  await atomicJson(executionInputPath, { schema_version: 1, artifact_name: artifactName });
  return {
    manifestPath,
    manifestSha256: created.sha256,
    executionInputPath,
    resultPath,
    packageZipPath,
    artifactName,
    draftsRoot,
    stageDestinationPath: stage.artifactTargetPath ?? stage.artifact_target_path ?? null,
    attempt: run?.attempt ?? null,
    jobRoot,
  };
}
