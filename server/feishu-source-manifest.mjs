import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const SOURCE_MANIFEST_SCHEMA_VERSION = 1;
const STAGE_IDS = new Set(["initial", "first_review", "final_review"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;

function error(message, code = "INVALID_SOURCE_MANIFEST") {
  const result = new Error(`SOURCE_MANIFEST_INVALID: ${message}`);
  result.code = code;
  return result;
}

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error(`${name} must be an object`);
  return value;
}

function text(value, name, { max = 4096 } = {}) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0") || value.length > max) {
    throw error(`${name} is invalid`);
  }
  return value.trim();
}

function id(value, name) {
  const result = text(value, name, { max: 256 });
  if (!ID.test(result)) throw error(`${name} is invalid`);
  return result;
}

function assertAllowed(value, allowed, name) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw error(`${name}.${unknown} is unsupported`, "SOURCE_MANIFEST_FIELD_UNSUPPORTED");
}

function validateUrl(value) {
  const raw = text(value, "document.url", { max: 2048 });
  let parsed;
  try { parsed = new URL(raw); } catch { throw error("document.url is invalid"); }
  if (
    parsed.protocol !== "https:"
    || !(parsed.hostname === "feishu.cn" || parsed.hostname.endsWith(".feishu.cn"))
    || !/^\/docx\/[^/]+$/u.test(parsed.pathname)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw error("document.url must be an HTTPS Feishu Docx URL");
  }
  return parsed.toString();
}

function normalizeSource(value, name, { allowBase = true, record = null } = {}) {
  const source = object(value, name);
  assertAllowed(source, new Set(["kind", "anchor_text", "field_id", "base_token", "table_id", "record_id"]), name);
  const kind = text(source.kind, `${name}.kind`, { max: 64 });
  if (kind === "docx_section") {
    return { kind, anchor_text: text(source.anchor_text, `${name}.anchor_text`, { max: 512 }) };
  }
  if (kind === "base_attachment" && allowBase) {
    const identity = record ?? {};
    return {
      kind,
      base_token: id(source.base_token ?? identity.base_token, `${name}.base_token`),
      table_id: id(source.table_id ?? identity.table_id, `${name}.table_id`),
      record_id: id(source.record_id ?? identity.record_id, `${name}.record_id`),
      field_id: id(source.field_id, `${name}.field_id`),
    };
  }
  throw error(`${name}.kind is invalid`);
}

function normalizeBinding(value) {
  const binding = object(value, "binding");
  assertAllowed(binding, new Set(["task_id", "run_id", "subject_key", "config_version", "stage_id", "event_id"]), "binding");
  const configVersion = binding.config_version;
  if (!Number.isSafeInteger(configVersion) || configVersion < 1) throw error("binding.config_version is invalid");
  const stageId = text(binding.stage_id, "binding.stage_id", { max: 64 });
  if (!STAGE_IDS.has(stageId)) throw error("binding.stage_id is invalid");
  const subjectKey = text(binding.subject_key, "binding.subject_key", { max: 513 });
  if (!subjectKey.includes(":") || subjectKey.includes("\0")) throw error("binding.subject_key is invalid");
  return {
    task_id: id(binding.task_id, "binding.task_id"),
    run_id: id(binding.run_id, "binding.run_id"),
    subject_key: subjectKey,
    config_version: configVersion,
    stage_id: stageId,
    event_id: id(binding.event_id, "binding.event_id"),
  };
}

function rejectExecutableKeys(value, name = "manifest") {
  object(value, name);
  for (const key of Object.keys(value)) {
    // Opaque Base identifiers such as `base_token` are part of the manifest
    // contract. Reject only fields that carry a path, executable instruction,
    // or an actual credential rather than matching every key containing
    // "token".
    if (/(?:^|_)(?:access|refresh|id|api)_?token$|(?:secret|credential|password|command|prompt|shell|executable|local_path|output_path|working_directory)/iu.test(key)) {
      throw error(`${name}.${key} is unsupported`, "SOURCE_MANIFEST_FIELD_UNSUPPORTED");
    }
    const child = value[key];
    if (child && typeof child === "object") {
      if (Array.isArray(child)) child.forEach((entry, index) => entry && typeof entry === "object" && rejectExecutableKeys(entry, `${name}.${key}[${index}]`));
      else rejectExecutableKeys(child, `${name}.${key}`);
    }
  }
}

/** Stable JSON serialization used for run identity and report validation. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function canonicalSha256(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function manifestValue(value) {
  // Accept the result wrapper returned by createSourceManifest as well as a
  // raw normalized manifest, so callers can pass either representation.
  return value && typeof value === "object" && value.manifest
    && typeof value.manifest === "object" ? value.manifest : value;
}

export function canonicalSourceManifestJson(value) {
  return canonicalJson(normalizeSourceManifest(manifestValue(value)));
}

export function sourceManifestSha256(value) {
  return createHash("sha256")
    .update(canonicalSourceManifestJson(value), "utf8")
    .digest("hex");
}

export function normalizeSourceManifest(value) {
  const input = object(value, "source manifest");
  rejectExecutableKeys(input);
  assertAllowed(input, new Set(["schema_version", "binding", "record", "document", "sources"]), "manifest");
  if (input.schema_version !== undefined && input.schema_version !== SOURCE_MANIFEST_SCHEMA_VERSION) {
    throw error(`schema_version must be ${SOURCE_MANIFEST_SCHEMA_VERSION}`, "SOURCE_MANIFEST_SCHEMA_UNSUPPORTED");
  }
  const document = object(input.document, "document");
  assertAllowed(document, new Set(["field_id", "url"]), "document");
  const sources = object(input.sources, "sources");
  assertAllowed(sources, new Set(["video", "review", "audio"]), "sources");
  const record = input.record === undefined
    ? null
    : (() => {
        const value = object(input.record, "record");
        assertAllowed(value, new Set(["base_token", "table_id", "record_id"]), "record");
        return {
          base_token: id(value.base_token, "record.base_token"),
          table_id: id(value.table_id, "record.table_id"),
          record_id: id(value.record_id, "record.record_id"),
        };
      })();
  const normalized = {
    schema_version: SOURCE_MANIFEST_SCHEMA_VERSION,
    binding: normalizeBinding(input.binding),
    ...(record === null ? {} : { record }),
    document: {
      field_id: id(document.field_id, "document.field_id"),
      url: validateUrl(document.url),
    },
    sources: {
      video: normalizeSource(sources.video, "sources.video", { record }),
      review: normalizeSource(sources.review, "sources.review", { allowBase: false }),
      audio: null,
    },
  };
  const audio = object(sources.audio, "sources.audio");
  assertAllowed(audio, new Set(["mode", "duration_tolerance_seconds", "source"]), "sources.audio");
  const mode = text(audio.mode, "sources.audio.mode", { max: 64 });
  if (mode === "video_original") {
    normalized.sources.audio = { mode };
  } else if (mode === "replace_original") {
    const tolerance = audio.duration_tolerance_seconds ?? 3;
    if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance <= 0) {
      throw error("sources.audio.duration_tolerance_seconds must be positive");
    }
    normalized.sources.audio = {
      mode,
      duration_tolerance_seconds: tolerance,
      source: normalizeSource(audio.source, "sources.audio.source", { record }),
    };
  } else {
    throw error("sources.audio.mode is invalid");
  }
  return normalized;
}

export function createSourceManifest(value) {
  const manifest = normalizeSourceManifest(value);
  return {
    schema_version: SOURCE_MANIFEST_SCHEMA_VERSION,
    manifest,
    sha256: canonicalSha256(manifest),
  };
}

export async function writeSourceManifest(filename, value) {
  const created = createSourceManifest(value);
  const target = path.resolve(filename);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(created.manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    await rename(temporary, target);
  } catch (error) {
    try { await rename(temporary, `${target}.${Date.now()}.tmp`); } catch {}
    throw error;
  }
  return { ...created, path: target };
}

export async function readSourceManifest(filename) {
  const target = path.resolve(filename);
  const parsed = JSON.parse(await readFile(target, "utf8"));
  const created = createSourceManifest(parsed);
  return { ...created, path: target };
}
