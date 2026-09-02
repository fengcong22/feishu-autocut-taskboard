import { createHash } from "node:crypto";

import { ApiError } from "./database.mjs";

const now = () => new Date().toISOString();
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const LIFECYCLES = new Set(["draft", "enabled", "disabled"]);
const EXECUTION_MODES = new Set(["manual", "automatic"]);
const ARTIFACT_SOURCE_MODES = new Set(["manual_select", "watch_directory", "driver_report"]);
const SUBJECT_PROJECT_HASH_LENGTH = 16;
export const WORKFLOW_SCHEMA_VERSION = 1;

export function subjectProjectId(subjectKey) {
  const digest = createHash("sha256")
    .update(String(subjectKey), "utf8")
    .digest("hex")
    .slice(0, SUBJECT_PROJECT_HASH_LENGTH);
  return `feishu-${digest}`;
}

function requireText(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new ApiError(400, "INVALID_FIELD", `${name} is required`);
  if (value.includes("\0")) throw new ApiError(400, "INVALID_FIELD", `${name} contains null bytes`);
  return value.trim();
}

function identifier(value, name) {
  const result = requireText(value, name);
  if (!ID_PATTERN.test(result)) throw new ApiError(400, "INVALID_FIELD", `${name} is invalid`);
  return result;
}

function optionalIdentifier(value, name) {
  if (value === undefined || value === null || value === "") return null;
  return identifier(value, name);
}

function assertKeys(value, allowed, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_FIELD", `${name} must be an object`);
  }
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new ApiError(400, "UNKNOWN_FIELD", `${name}.${unknown} is not supported`);
}

function mergeObjects(current, patch) {
  const result = { ...current };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value)
      && current?.[key] && typeof current[key] === "object" && !Array.isArray(current[key])) {
      result[key] = mergeObjects(current[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function parseSubjectKey(value) {
  const key = requireText(value, "subjectKey");
  const separator = key.indexOf(":");
  if (separator <= 0 || separator === key.length - 1 || key.indexOf(":", separator + 1) !== -1) {
    throw new ApiError(400, "INVALID_FIELD", "subjectKey must be baseToken:tableId");
  }
  const baseToken = identifier(key.slice(0, separator), "baseToken");
  const tableId = identifier(key.slice(separator + 1), "tableId");
  return { subjectKey: key, baseToken, tableId };
}

function json(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function rowSubject(row) {
  return {
    ...json(row.config_json),
    subjectKey: row.subject_key,
    baseToken: row.base_token,
    tableId: row.table_id,
    tableName: row.table_name,
    projectId: row.project_id,
    displayEnabled: Boolean(row.display_enabled),
    lifecycle: row.lifecycle,
    configVersion: row.config_version,
    metadata: json(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowBase(database, row) {
  const subjects = database.prepare(`
    SELECT * FROM feishu_subjects
    WHERE base_token = ? AND removed_at IS NULL
    ORDER BY table_name, table_id
  `).all(row.base_token).map(rowSubject);
  return {
    baseToken: row.base_token,
    baseName: row.base_name,
    sourceUrlLabel: safeSourceUrlLabel(row.source_url_label),
    metadataRefreshedAt: row.metadata_refreshed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    subjects,
  };
}

function snapshotFor(row) {
  return rowSubject(row);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function safeSourceUrlLabel(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol)) return null;
    // A Base link is only a display hint.  Never carry query strings, hash
    // fragments or embedded credentials into a portable configuration.
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function portableMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  if (!Array.isArray(metadata.fields)) return {};
  return {
    fields: metadata.fields.map((field) => {
      if (!field || typeof field !== "object" || Array.isArray(field)) return null;
      const safe = {};
      for (const key of ["fieldId", "id", "fieldName", "name", "type", "uiType", "options"]) {
        if (field[key] !== undefined) {
          safe[key] = key === "options" && Array.isArray(field[key])
            ? field[key].filter((option) => option && typeof option === "object").map((option) => ({
              ...(option.id !== undefined ? { id: clone(option.id) } : {}),
              ...(option.name !== undefined ? { name: clone(option.name) } : {}),
            }))
            : clone(field[key]);
        }
      }
      return safe;
    }).filter(Boolean),
  };
}

function shareableSubject(subject, { forceDraft = false } = {}) {
  const result = {
    subjectKey: subject.subjectKey,
    baseToken: subject.baseToken,
    baseName: subject.baseName,
    tableId: subject.tableId,
    tableName: subject.tableName,
    projectId: subject.projectId,
    displayEnabled: subject.displayEnabled,
    lifecycle: subject.lifecycle,
    configVersion: subject.configVersion,
    trigger: clone(subject.trigger),
    title: clone(subject.title),
    execution: clone(subject.execution),
    packageRoute: clone(subject.packageRoute),
    upload: clone(subject.upload),
    metadata: portableMetadata(subject.metadata),
  };
  // A share file is a portable description of workflow intent.  Runtime
  // snapshots, database timestamps and machine-local path bindings never cross
  // the device boundary.
  if (forceDraft) {
    result.lifecycle = "draft";
    result.configVersion = 1;
  }
  result.upload = {
    ...result.upload,
    artifactSourcePath: null,
    targetPath: null,
  };
  return result;
}

function shareableConfiguration(catalog, { forceDraft = false } = {}) {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    configVersion: 1,
    createdAt: null,
    updatedAt: null,
    bases: (catalog ?? []).map((base) => ({
      baseToken: base.baseToken,
      baseName: base.baseName,
      sourceUrlLabel: safeSourceUrlLabel(base.sourceUrlLabel),
      metadataRefreshedAt: base.metadataRefreshedAt ?? null,
      subjects: (base.subjects ?? []).map((subject) => shareableSubject(subject, { forceDraft })),
    })),
  };
}

function validateShareDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", "Shared workflow configuration must be an object");
  }
  const allowed = new Set(["schemaVersion", "configVersion", "createdAt", "updatedAt", "bases"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new ApiError(400, "UNKNOWN_FIELD", `configuration.${unknown} is not supported`);
  if (value.schemaVersion !== undefined && value.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    throw new ApiError(400, "UNSUPPORTED_SCHEMA_VERSION", `configuration.schemaVersion must be ${WORKFLOW_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(value.bases)) throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", "configuration.bases must be an array");
  const bases = [];
  const seenBases = new Set();
  const seenSubjects = new Set();
  for (const [baseIndex, inputBase] of value.bases.entries()) {
    if (!inputBase || typeof inputBase !== "object" || Array.isArray(inputBase)) {
      throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", `configuration.bases[${baseIndex}] must be an object`);
    }
    const baseAllowed = new Set(["baseToken", "baseName", "sourceUrlLabel", "metadataRefreshedAt", "subjects"]);
    const baseUnknown = Object.keys(inputBase).find((key) => !baseAllowed.has(key));
    if (baseUnknown) throw new ApiError(400, "UNKNOWN_FIELD", `configuration.bases[${baseIndex}].${baseUnknown} is not supported`);
    const baseToken = identifier(inputBase.baseToken, `configuration.bases[${baseIndex}].baseToken`);
    const baseName = requireText(inputBase.baseName, `configuration.bases[${baseIndex}].baseName`);
    if (seenBases.has(baseToken)) throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", `duplicate baseToken: ${baseToken}`);
    seenBases.add(baseToken);
    if (!Array.isArray(inputBase.subjects)) {
      throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", `configuration.bases[${baseIndex}].subjects must be an array`);
    }
    const subjects = [];
    for (const [subjectIndex, inputSubject] of inputBase.subjects.entries()) {
      if (!inputSubject || typeof inputSubject !== "object" || Array.isArray(inputSubject)) {
        throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", `configuration.bases[${baseIndex}].subjects[${subjectIndex}] must be an object`);
      }
      const subjectAllowed = new Set([
        "subjectKey", "baseToken", "baseName", "tableId", "tableName", "projectId", "displayEnabled",
        "lifecycle", "configVersion", "createdAt", "updatedAt", "trigger", "title", "execution",
        "packageRoute", "upload", "metadata",
      ]);
      const subjectUnknown = Object.keys(inputSubject).find((key) => !subjectAllowed.has(key));
      if (subjectUnknown) {
        throw new ApiError(400, "UNKNOWN_FIELD", `configuration.bases[${baseIndex}].subjects[${subjectIndex}].${subjectUnknown} is not supported`);
      }
      const tableId = identifier(inputSubject.tableId, `configuration.bases[${baseIndex}].subjects[${subjectIndex}].tableId`);
      const key = `${baseToken}:${tableId}`;
      if (inputSubject.subjectKey !== undefined && inputSubject.subjectKey !== key) {
        throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", `subjectKey does not match ${key}`);
      }
      if (inputSubject.baseToken !== undefined && inputSubject.baseToken !== baseToken) {
        throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", `baseToken does not match ${key}`);
      }
      if (inputSubject.projectId !== undefined && inputSubject.projectId !== subjectProjectId(key)) {
        throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", `projectId does not match ${key}`);
      }
      if (seenSubjects.has(key)) throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", `duplicate subjectKey: ${key}`);
      seenSubjects.add(key);
      const normalized = {
        subjectKey: key,
        baseToken,
        baseName: requireText(inputSubject.baseName ?? baseName, "subject.baseName"),
        tableId,
        tableName: requireText(inputSubject.tableName, "subject.tableName"),
        projectId: subjectProjectId(key),
        displayEnabled: inputSubject.displayEnabled === undefined ? false : inputSubject.displayEnabled,
        lifecycle: "draft",
        configVersion: Number.isInteger(inputSubject.configVersion) && inputSubject.configVersion > 0 ? inputSubject.configVersion : 1,
        metadata: portableMetadata(inputSubject.metadata),
        trigger: clone(inputSubject.trigger),
        title: clone(inputSubject.title),
        execution: clone(inputSubject.execution),
        packageRoute: clone(inputSubject.packageRoute),
        upload: clone(inputSubject.upload),
      };
      if (typeof normalized.displayEnabled !== "boolean") {
        throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", `${key}.displayEnabled must be boolean`);
      }
      // Reuse the store's strict field/package/path-independent validator after
      // filling only fields that are safe defaults for a portable document.
      normalized.title ??= { fieldId: null, fieldName: null };
      normalized.execution ??= { mode: "manual", concurrencyGroup: "default", maxConcurrent: 1, resourceGroups: [] };
      normalized.packageRoute ??= { routeMode: "fixed", packageAlias: "Auto-cut-A", subjectCodeFieldId: null, branchMap: null };
      normalized.upload ??= { enqueueMode: "manual", artifactSourceMode: "manual_select", artifactSourcePath: null, targetId: null, targetPath: null, uploadConcurrency: 1 };
      normalized.upload.artifactSourcePath = null;
      normalized.upload.targetPath = null;
      try {
        validateSubjectConfig(normalized);
      } catch (error) {
        if (error instanceof ApiError) {
          throw new ApiError(400, "INVALID_SHARE_CONFIGURATION", error.message);
        }
        throw error;
      }
      subjects.push(normalized);
    }
    bases.push({
      baseToken,
      baseName,
      sourceUrlLabel: safeSourceUrlLabel(inputBase.sourceUrlLabel),
      metadataRefreshedAt: inputBase.metadataRefreshedAt ?? null,
      subjects,
    });
  }
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    configVersion: 1,
    createdAt: null,
    updatedAt: null,
    bases,
  };
}

const SUBJECT_PATCH_KEYS = new Set([
  "displayEnabled", "trigger", "title", "execution", "packageRoute", "upload", "expectedVersion",
]);

function validateSubjectConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_BODY", "Subject configuration must be an object");
  }
  const allowedTopLevel = new Set([
    "subjectKey", "baseToken", "baseName", "tableId", "tableName", "projectId",
    "displayEnabled", "lifecycle", "configVersion", "trigger", "title", "execution",
    "packageRoute", "upload", "metadata", "createdAt", "updatedAt",
  ]);
  const unknownTopLevel = Object.keys(value).find((key) => !allowedTopLevel.has(key));
  if (unknownTopLevel) throw new ApiError(400, "UNKNOWN_FIELD", `Unknown subject field '${unknownTopLevel}'`);
  const identity = parseSubjectKey(value.subjectKey);
  if (value.baseToken !== identity.baseToken || value.tableId !== identity.tableId) {
    throw new ApiError(400, "INVALID_FIELD", "Subject identity does not match subjectKey");
  }
  if (value.projectId !== subjectProjectId(value.subjectKey)) {
    throw new ApiError(400, "INVALID_FIELD", "Subject project identity is invalid");
  }
  if (!LIFECYCLES.has(value.lifecycle)) throw new ApiError(400, "INVALID_FIELD", "lifecycle is invalid");
  assertKeys(value.trigger, new Set(["fieldId", "fieldName", "startValue", "optionId"]), "trigger");
  identifier(value.trigger.fieldId, "trigger.fieldId");
  requireText(value.trigger.fieldName, "trigger.fieldName");
  requireText(value.trigger.startValue, "trigger.startValue");
  optionalIdentifier(value.trigger.optionId, "trigger.optionId");
  assertKeys(value.title, new Set(["fieldId", "fieldName"]), "title");
  const titleFieldId = optionalIdentifier(value.title.fieldId, "title.fieldId");
  const titleFieldName = value.title.fieldName === null || value.title.fieldName === undefined || value.title.fieldName === ""
    ? null : requireText(value.title.fieldName, "title.fieldName");
  if (Boolean(titleFieldId) !== Boolean(titleFieldName)) {
    throw new ApiError(400, "INVALID_FIELD", "title.fieldId and title.fieldName must be configured together");
  }
  assertKeys(value.execution, new Set(["mode", "concurrencyGroup", "maxConcurrent", "resourceGroups"]), "execution");
  if (!EXECUTION_MODES.has(value.execution.mode)) throw new ApiError(400, "INVALID_FIELD", "execution.mode is invalid");
  identifier(value.execution.concurrencyGroup, "execution.concurrencyGroup");
  if (!Number.isSafeInteger(value.execution.maxConcurrent) || value.execution.maxConcurrent < 1) {
    throw new ApiError(400, "INVALID_FIELD", "execution.maxConcurrent must be positive");
  }
  if (!Array.isArray(value.execution.resourceGroups)) throw new ApiError(400, "INVALID_FIELD", "execution.resourceGroups must be an array");
  const groups = value.execution.resourceGroups.map((group, index) => identifier(group, `execution.resourceGroups[${index}]`));
  if (new Set(groups).size !== groups.length) throw new ApiError(400, "INVALID_FIELD", "execution.resourceGroups must be unique");
  assertKeys(value.packageRoute, new Set(["routeMode", "packageAlias", "subjectCodeFieldId", "branchMap"]), "packageRoute");
  if ((value.packageRoute.routeMode ?? "fixed") !== "fixed") throw new ApiError(400, "INVALID_FIELD", "packageRoute.routeMode is invalid");
  const alias = requireText(value.packageRoute.packageAlias, "packageRoute.packageAlias");
  if (/^[./\\]/u.test(alias) || /[\s\u0000-\u001f\u007f"'`:$<>|]/u.test(alias)) {
    throw new ApiError(400, "INVALID_FIELD", "packageRoute.packageAlias is invalid");
  }
  optionalIdentifier(value.packageRoute.subjectCodeFieldId, "packageRoute.subjectCodeFieldId");
  if (value.packageRoute.branchMap !== null && value.packageRoute.branchMap !== undefined) {
    assertKeys(value.packageRoute.branchMap, new Set(Object.keys(value.packageRoute.branchMap)), "packageRoute.branchMap");
    for (const [code, branchAlias] of Object.entries(value.packageRoute.branchMap)) {
      requireText(code, "packageRoute.branchMap key");
      const normalized = requireText(branchAlias, `packageRoute.branchMap.${code}`);
      if (/^[./\\]/u.test(normalized) || /[\s\u0000-\u001f\u007f"'`:$<>|]/u.test(normalized)) {
        throw new ApiError(400, "INVALID_FIELD", "packageRoute.branchMap contains an invalid alias");
      }
    }
  }
  assertKeys(value.upload, new Set(["enqueueMode", "artifactSourceMode", "artifactSourcePath", "targetId", "targetPath", "uploadConcurrency"]), "upload");
  if (!EXECUTION_MODES.has(value.upload.enqueueMode)) throw new ApiError(400, "INVALID_FIELD", "upload.enqueueMode is invalid");
  if (!ARTIFACT_SOURCE_MODES.has(value.upload.artifactSourceMode)) throw new ApiError(400, "INVALID_FIELD", "upload.artifactSourceMode is invalid");
  if (!Number.isSafeInteger(value.upload.uploadConcurrency) || value.upload.uploadConcurrency < 1) throw new ApiError(400, "INVALID_FIELD", "upload.uploadConcurrency must be positive");
  optionalIdentifier(value.upload.targetId, "upload.targetId");
  if (typeof value.displayEnabled !== "boolean") throw new ApiError(400, "INVALID_FIELD", "displayEnabled must be boolean");
  for (const field of ["artifactSourcePath", "targetPath"]) {
    const candidate = value.upload[field];
    if (candidate !== null && candidate !== undefined && candidate !== "" && !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(candidate)) {
      throw new ApiError(400, "INVALID_FIELD", `upload.${field} must be absolute`);
    }
  }
  return value;
}

export function createFeishuWorkflowStore({ database, validateConfig = null, packageAliases = null, syncSubject = null } = {}) {
  if (!database?.database) throw new TypeError("database is required");
  const db = database.database;
  const validate = (value) => {
    const normalized = typeof validateConfig === "function" ? validateConfig(value) : value;
    return validateSubjectConfig(normalized);
  };
  async function assertPackageAlias(alias) {
    if (typeof packageAliases !== "function") return;
    const allowed = await packageAliases();
    if (!Array.isArray(allowed) || !allowed.includes(alias)) {
      throw new ApiError(409, "UNKNOWN_PACKAGE_ALIAS", "Auto-Cut package is not configured on this Taskboard");
    }
  }

  function assertTriggerMetadata(subject) {
    const fields = Array.isArray(subject?.metadata?.fields) ? subject.metadata.fields : [];
    const field = fields.find((candidate) => (
      candidate && typeof candidate === "object"
      && (candidate.fieldId ?? candidate.id) === subject.trigger.fieldId
    ));
    if (!field) {
      throw new ApiError(
        409,
        "TRIGGER_FIELD_NOT_FOUND",
        "The configured trigger field is not present in the latest Base metadata",
      );
    }
    if (subject.trigger.optionId) {
      const options = Array.isArray(field.options) ? field.options : [];
      const option = options.find((candidate) => (
        candidate && typeof candidate === "object"
        && candidate.id === subject.trigger.optionId
      ));
      if (!option || option.name !== subject.trigger.startValue) {
        throw new ApiError(
          409,
          "TRIGGER_OPTION_NOT_FOUND",
          "The configured start option is not present in the latest Base metadata",
        );
      }
    }
  }

  async function configuredPackageAliases() {
    if (typeof packageAliases !== "function") return null;
    const aliases = await packageAliases();
    return new Set(Array.isArray(aliases) ? aliases : []);
  }

  async function shareDiagnostics(configuration) {
    const diagnostics = [];
    const packageSet = await configuredPackageAliases();
    const currentBases = new Map(db.prepare("SELECT * FROM feishu_bases").all().map((row) => [row.base_token, row]));
    const currentSubjects = new Map(db.prepare("SELECT * FROM feishu_subjects").all().map((row) => [row.subject_key, row]));
    for (const base of configuration.bases) {
      const currentBase = currentBases.get(base.baseToken);
      if (!currentBase) {
        diagnostics.push({
          code: "BASE_NOT_FOUND",
          severity: "info",
          path: `bases.${base.baseToken}`,
          message: `Base ${base.baseName} will be added to this Taskboard`,
        });
      }
      for (const subject of base.subjects) {
        const current = currentSubjects.get(subject.subjectKey);
        if (!current) {
          diagnostics.push({
            code: "SUBJECT_NOT_FOUND",
            severity: "info",
            path: `bases.${base.baseToken}.subjects.${subject.tableId}`,
            message: `Subject ${subject.tableName} will be added to this Taskboard`,
          });
        }
        const currentConfig = current ? rowSubject(current) : null;
        const fields = Array.isArray(currentConfig?.metadata?.fields) && currentConfig.metadata.fields.length > 0
          ? currentConfig.metadata.fields
          : subject.metadata?.fields;
        if (Array.isArray(fields) && fields.length > 0) {
          const knownIds = new Set(fields.map((field) => field?.fieldId ?? field?.id).filter(Boolean));
          for (const [fieldName, fieldId] of [
            ["trigger", subject.trigger?.fieldId],
            ["title", subject.title?.fieldId],
            ["subjectCode", subject.packageRoute?.subjectCodeFieldId],
          ]) {
            if (fieldId && !knownIds.has(fieldId)) {
              diagnostics.push({
                code: "FIELD_NOT_FOUND",
                severity: "warning",
                path: `bases.${base.baseToken}.subjects.${subject.tableId}.${fieldName}.fieldId`,
                message: `Configured ${fieldName} field ${fieldId} is not present in the local metadata`,
              });
            }
          }
        } else if (current && (subject.trigger?.fieldId || subject.title?.fieldId)) {
          diagnostics.push({
            code: "FIELD_METADATA_UNAVAILABLE",
            severity: "info",
            path: `bases.${base.baseToken}.subjects.${subject.tableId}.metadata`,
            message: "Local field metadata is unavailable; verify field IDs before enabling",
          });
        }
        const aliases = [
          subject.packageRoute?.packageAlias,
          ...Object.values(subject.packageRoute?.branchMap ?? {}),
        ].filter(Boolean);
        if (packageSet) {
          for (const alias of aliases) {
            if (!packageSet.has(alias)) {
              diagnostics.push({
                code: "PACKAGE_ALIAS_UNAVAILABLE",
                severity: "error",
                path: `bases.${base.baseToken}.subjects.${subject.tableId}.packageRoute`,
                alias,
                message: `Auto-Cut package alias ${alias} is not configured on this Taskboard`,
              });
            }
          }
        }
        const sourcePath = currentConfig?.upload?.artifactSourcePath ?? null;
        const targetPath = currentConfig?.upload?.targetPath ?? null;
        if (["watch_directory", "driver_report"].includes(subject.upload?.artifactSourceMode) && !sourcePath) {
          diagnostics.push({
            code: "ARTIFACT_SOURCE_PATH_UNBOUND",
            severity: "warning",
            path: `bases.${base.baseToken}.subjects.${subject.tableId}.upload.artifactSourcePath`,
            message: "Artifact source path must be bound on this machine before upload can run",
          });
        }
        if (subject.upload?.targetId && !targetPath) {
          diagnostics.push({
            code: "UPLOAD_TARGET_PATH_UNBOUND",
            severity: "warning",
            path: `bases.${base.baseToken}.subjects.${subject.tableId}.upload.targetPath`,
            message: "Upload target path must be bound on this machine before upload can run",
          });
        }
      }
    }
    return diagnostics;
  }

  function configurationFromCatalog(catalog) {
    return shareableConfiguration(catalog);
  }
  function getSubject(subjectKey) {
    const row = db.prepare("SELECT * FROM feishu_subjects WHERE subject_key = ? AND removed_at IS NULL").get(subjectKey);
    if (!row) throw new ApiError(404, "SUBJECT_NOT_FOUND", `Subject '${subjectKey}' does not exist`);
    return row;
  }
  function saveVersion(row, snapshot, version, timestamp) {
    db.prepare(`INSERT INTO feishu_subject_versions (subject_key, version, snapshot_json, created_at) VALUES (?, ?, ?, ?)`)
      .run(row.subject_key, version, JSON.stringify(snapshot), timestamp);
  }
  return {
    async listCatalog() {
      return db.prepare("SELECT * FROM feishu_bases WHERE removed_at IS NULL ORDER BY base_name, base_token").all().map((row) => rowBase(db, row));
    },
    async packageAliases() {
      if (typeof packageAliases !== "function") return [];
      const aliases = await packageAliases();
      return Array.isArray(aliases) ? [...new Set(aliases)] : [];
    },
    async exportShareable() {
      const catalog = db.prepare("SELECT * FROM feishu_bases WHERE removed_at IS NULL ORDER BY base_name, base_token").all().map((row) => rowBase(db, row));
      return configurationFromCatalog(catalog);
    },
    async importShareable(value, { dryRun = false } = {}) {
      if (typeof dryRun !== "boolean") {
        throw new ApiError(400, "INVALID_FIELD", "dryRun must be boolean");
      }
      const configuration = validateShareDocument(value);
      const diagnostics = await shareDiagnostics(configuration);
      const diagnosticsOk = diagnostics.every((entry) => entry.severity !== "error");
      const draftConfiguration = shareableConfiguration(
        configuration.bases.map((base) => ({
          ...base,
          subjects: base.subjects.map((subject) => shareableSubject(subject, { forceDraft: true })),
        })),
        { forceDraft: true },
      );
      if (dryRun) {
        return { ...draftConfiguration, configuration: draftConfiguration, diagnostics, diagnosticsOk, dryRun: true };
      }
      const timestamp = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const base of configuration.bases) {
          const existingBase = db.prepare("SELECT * FROM feishu_bases WHERE base_token = ?").get(base.baseToken);
          db.prepare(`INSERT INTO feishu_bases
              (base_token, base_name, source_url_label, metadata_refreshed_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(base_token) DO UPDATE SET base_name=excluded.base_name,
                source_url_label=excluded.source_url_label,
                metadata_refreshed_at=excluded.metadata_refreshed_at,
                removed_at=NULL,
                updated_at=excluded.updated_at`)
            .run(base.baseToken, base.baseName, base.sourceUrlLabel ?? null, base.metadataRefreshedAt ?? null,
              existingBase?.created_at ?? timestamp, timestamp);
          for (const imported of base.subjects) {
            const existing = db.prepare("SELECT * FROM feishu_subjects WHERE subject_key = ?").get(imported.subjectKey);
            const local = existing ? rowSubject(existing) : null;
            const next = validateSubjectConfig({
              ...imported,
              baseName: base.baseName,
              lifecycle: "draft",
              projectId: subjectProjectId(imported.subjectKey),
              configVersion: (existing?.config_version ?? 0) + 1,
              createdAt: existing?.created_at ?? timestamp,
              updatedAt: timestamp,
              // Keep bindings already established on this machine.  Imported
              // files themselves always carry null paths.
              upload: {
                ...imported.upload,
                artifactSourcePath: local?.upload?.artifactSourcePath ?? null,
                targetPath: local?.upload?.targetPath ?? null,
              },
            });
            const metadata = next.metadata && typeof next.metadata === "object" ? next.metadata : {};
            if (existing) {
              db.prepare(`UPDATE feishu_subjects SET table_name=?, project_id=?, display_enabled=?, lifecycle='draft',
                config_version=?, config_json=?, metadata_json=?, removed_at=NULL, updated_at=? WHERE subject_key=?`)
                .run(next.tableName, next.projectId, next.displayEnabled ? 1 : 0, next.configVersion,
                  JSON.stringify(next), JSON.stringify(metadata), timestamp, next.subjectKey);
            } else {
              db.prepare(`INSERT INTO feishu_subjects
                (subject_key, base_token, table_id, table_name, project_id, display_enabled, lifecycle, config_version,
                 config_json, metadata_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`)
                .run(next.subjectKey, next.baseToken, next.tableId, next.tableName, next.projectId,
                  next.displayEnabled ? 1 : 0, next.configVersion, JSON.stringify(next), JSON.stringify(metadata), timestamp, timestamp);
            }
            db.prepare(`INSERT INTO projects
              (id, name, workspace_path, source, archived_at, next_task_number, created_at, updated_at)
              VALUES (?, ?, NULL, 'feishu', NULL, 1, ?, ?)
              ON CONFLICT(id) DO UPDATE SET name=excluded.name, source='feishu', archived_at=NULL,
                updated_at=excluded.updated_at`)
              .run(next.projectId, next.tableName, timestamp, timestamp);
            saveVersion({ subject_key: next.subjectKey }, next, next.configVersion, timestamp);
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      const catalog = db.prepare("SELECT * FROM feishu_bases WHERE removed_at IS NULL ORDER BY base_name, base_token").all().map((row) => rowBase(db, row));
      const resultConfiguration = configurationFromCatalog(catalog);
      return { ...resultConfiguration, configuration: resultConfiguration, catalog, diagnostics, diagnosticsOk, dryRun: false };
    },
    async getSubject(subjectKey) {
      return rowSubject(getSubject(parseSubjectKey(subjectKey).subjectKey));
    },
    async upsertBasePreview(preview) {
      if (!preview || typeof preview !== "object" || Array.isArray(preview)) throw new ApiError(400, "INVALID_BODY", "Base preview must be an object");
      const baseToken = identifier(preview.baseToken, "baseToken");
      const baseName = requireText(preview.baseName, "baseName");
      if (!Array.isArray(preview.tables)) throw new ApiError(400, "INVALID_FIELD", "tables must be an array");
      const sourceUrlLabel = safeSourceUrlLabel(preview.sourceUrlLabel);
      const timestamp = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`INSERT INTO feishu_bases (base_token, base_name, source_url_label, metadata_refreshed_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(base_token) DO UPDATE SET base_name=excluded.base_name, source_url_label=excluded.source_url_label,
          metadata_refreshed_at=excluded.metadata_refreshed_at, removed_at=NULL, updated_at=excluded.updated_at`)
          .run(baseToken, baseName, sourceUrlLabel, preview.metadataRefreshedAt ?? null, timestamp, timestamp);
        for (const table of preview.tables) {
          const tableId = identifier(table.tableId, "tableId");
          const tableName = requireText(table.tableName, "tableName");
          const key = `${baseToken}:${tableId}`;
          const existing = db.prepare("SELECT * FROM feishu_subjects WHERE subject_key = ?").get(key);
          const metadata = { fields: Array.isArray(table.fields) ? table.fields : [] };
          if (existing) {
            const existingConfig = rowSubject(existing);
            const namesChanged = existingConfig.baseName !== baseName || existingConfig.tableName !== tableName;
            const metadataChanged = JSON.stringify(existingConfig.metadata ?? {}) !== JSON.stringify(metadata);
            if (namesChanged || metadataChanged) {
              // A metadata refresh changes the configuration snapshot.  Keep
              // the Bridge's last enabled snapshot active until the operator
              // explicitly validates and re-enables the refreshed draft.
              const next = validate({
                ...existingConfig,
                baseName,
                tableName,
                metadata,
                lifecycle: existingConfig.lifecycle === "enabled" ? "draft" : existingConfig.lifecycle,
                configVersion: existing.config_version + 1,
                updatedAt: timestamp,
              });
              db.prepare(`UPDATE feishu_subjects
                SET table_name = ?, metadata_json = ?, lifecycle = ?, config_version = ?, config_json = ?, removed_at = NULL, updated_at = ?
                WHERE subject_key = ?`)
                .run(tableName, JSON.stringify(metadata), next.lifecycle, next.configVersion, JSON.stringify(next), timestamp, key);
              saveVersion({ subject_key: key }, next, next.configVersion, timestamp);
            } else if (existing.removed_at !== null) {
              db.prepare("UPDATE feishu_subjects SET removed_at = NULL, updated_at = ? WHERE subject_key = ?")
                .run(timestamp, key);
            }
            db.prepare("UPDATE projects SET name = ?, source = 'feishu', archived_at = NULL, updated_at = ? WHERE id = ?")
              .run(tableName, timestamp, subjectProjectId(key));
          } else {
            const initial = validate({
              subjectKey: key,
              baseToken,
              baseName,
              tableId,
              tableName,
              projectId: subjectProjectId(key),
              displayEnabled: false,
              lifecycle: "draft",
              configVersion: 1,
              trigger: { fieldId: "pending", fieldName: "待配置", startValue: "待配置", optionId: null },
              title: { fieldId: null, fieldName: null },
              execution: { mode: "manual", concurrencyGroup: "default", maxConcurrent: 1, resourceGroups: [] },
              packageRoute: { routeMode: "fixed", packageAlias: "Auto-cut-A", subjectCodeFieldId: null, branchMap: null },
              upload: { enqueueMode: "manual", artifactSourceMode: "manual_select", artifactSourcePath: null, targetId: null, targetPath: null, uploadConcurrency: 1 },
            });
            db.prepare(`INSERT INTO feishu_subjects
              (subject_key, base_token, table_id, table_name, project_id, display_enabled, lifecycle, config_version, config_json, metadata_json, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 0, 'draft', 1, ?, ?, ?, ?)`)
              .run(key, baseToken, tableId, tableName, subjectProjectId(key), JSON.stringify(initial), JSON.stringify(metadata), timestamp, timestamp);
            db.prepare(`INSERT INTO projects
              (id, name, workspace_path, source, archived_at, next_task_number, created_at, updated_at)
              VALUES (?, ?, NULL, 'feishu', NULL, 1, ?, ?)
              ON CONFLICT(id) DO UPDATE SET name = excluded.name, source = 'feishu', archived_at = NULL,
                updated_at = excluded.updated_at`)
              .run(subjectProjectId(key), tableName, timestamp, timestamp);
            saveVersion({ subject_key: key }, initial, 1, timestamp);
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return rowBase(db, db.prepare("SELECT * FROM feishu_bases WHERE base_token = ?").get(baseToken));
    },
    async saveSubjectDraft(subjectKey, patch) {
      const key = parseSubjectKey(subjectKey).subjectKey;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new ApiError(400, "INVALID_BODY", "Subject patch must be an object");
      for (const field of Object.keys(patch)) {
        if (!SUBJECT_PATCH_KEYS.has(field)) throw new ApiError(400, "UNKNOWN_FIELD", `Unknown subject field '${field}'`);
      }
      const timestamp = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = getSubject(key);
        if (patch.expectedVersion !== undefined
          && (!Number.isInteger(patch.expectedVersion) || patch.expectedVersion !== current.config_version)) {
          throw new ApiError(409, "VERSION_CONFLICT", "Subject was changed by another client", {
            expectedVersion: patch.expectedVersion,
            actualVersion: current.config_version,
          });
        }
        const { expectedVersion: _expectedVersion, ...changes } = patch;
        const next = validate({
          ...mergeObjects(rowSubject(current), changes),
          subjectKey: key,
          baseToken: current.base_token,
          tableId: current.table_id,
          projectId: current.project_id,
          lifecycle: "draft",
          configVersion: current.config_version + 1,
        });
        db.prepare("UPDATE feishu_subjects SET lifecycle='draft', config_version=?, config_json=?, display_enabled=?, updated_at=? WHERE subject_key=?")
          .run(next.configVersion, JSON.stringify(next), next.displayEnabled === false ? 0 : 1, timestamp, key);
        saveVersion({ subject_key: key }, next, next.configVersion, timestamp);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return rowSubject(getSubject(key));
    },
    async setSubjectDisplayEnabled(subjectKey, displayEnabled) {
      const key = parseSubjectKey(subjectKey).subjectKey;
      if (typeof displayEnabled !== "boolean") {
        throw new ApiError(400, "INVALID_FIELD", "displayEnabled must be boolean");
      }
      const timestamp = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = getSubject(key);
        const currentConfig = rowSubject(current);
        const nextConfig = { ...currentConfig, displayEnabled, updatedAt: timestamp };
        db.prepare("UPDATE feishu_subjects SET config_json=?, display_enabled=?, updated_at=? WHERE subject_key=?")
          .run(JSON.stringify(nextConfig), displayEnabled ? 1 : 0, timestamp, key);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return rowSubject(getSubject(key));
    },
    async removeSubject(subjectKey) {
      const key = parseSubjectKey(subjectKey).subjectKey;
      const current = getSubject(key);
      if (current.lifecycle !== "disabled") {
        await transition(key, current.config_version, "disabled");
      }
      removeSubjectRows([getSubject(key)]);
      return this.listCatalog();
    },
    async removeBase(baseTokenValue) {
      const baseToken = identifier(baseTokenValue, "baseToken");
      const base = db.prepare("SELECT * FROM feishu_bases WHERE base_token = ? AND removed_at IS NULL").get(baseToken);
      if (!base) throw new ApiError(404, "BASE_NOT_FOUND", `Base '${baseToken}' does not exist`);
      const subjects = db.prepare("SELECT * FROM feishu_subjects WHERE base_token = ? AND removed_at IS NULL ORDER BY subject_key").all(baseToken);
      for (const subject of subjects) {
        if (subject.lifecycle !== "disabled") {
          await transition(subject.subject_key, subject.config_version, "disabled");
        }
      }
      const timestamp = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const lockedSubjects = db.prepare("SELECT * FROM feishu_subjects WHERE base_token = ? AND removed_at IS NULL ORDER BY subject_key").all(baseToken);
        if (lockedSubjects.some((subject) => subject.lifecycle !== "disabled")) {
          throw new ApiError(409, "VERSION_CONFLICT", "A subject changed while the Base was being removed");
        }
        removeSubjectRows(lockedSubjects, timestamp, false);
        db.prepare("UPDATE feishu_bases SET removed_at = ?, updated_at = ? WHERE base_token = ? AND removed_at IS NULL")
          .run(timestamp, timestamp, baseToken);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return this.listCatalog();
    },
    async enableSubject(subjectKey, expectedVersion) { return transition(subjectKey, expectedVersion, "enabled"); },
    async disableSubject(subjectKey, expectedVersion) { return transition(subjectKey, expectedVersion, "disabled"); },
  };

  function removeSubjectRows(subjects, timestamp = now(), manageTransaction = true) {
    if (manageTransaction) db.exec("BEGIN IMMEDIATE");
    try {
      for (const subject of subjects) {
        const locked = getSubject(subject.subject_key);
        if (locked.config_version !== subject.config_version || locked.lifecycle !== "disabled") {
          throw new ApiError(409, "VERSION_CONFLICT", "Subject changed while it was being removed", {
            expectedVersion: subject.config_version,
            actualVersion: locked.config_version,
          });
        }
        const next = { ...rowSubject(locked), displayEnabled: false, updatedAt: timestamp };
        db.prepare(`UPDATE feishu_subjects
          SET display_enabled=0, config_json=?, removed_at=?, updated_at=?
          WHERE subject_key=? AND config_version=? AND lifecycle='disabled' AND removed_at IS NULL`)
          .run(JSON.stringify(next), timestamp, timestamp, locked.subject_key, locked.config_version);
      }
      if (manageTransaction) db.exec("COMMIT");
    } catch (error) {
      if (manageTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  async function transition(subjectKey, expectedVersion, lifecycle) {
    const key = parseSubjectKey(subjectKey).subjectKey;
    const current = getSubject(key);
    if (!Number.isInteger(expectedVersion) || expectedVersion !== current.config_version) {
      throw new ApiError(409, "VERSION_CONFLICT", "Subject was changed by another client", { expectedVersion, actualVersion: current.config_version });
    }
    const currentConfig = rowSubject(current);
    if (lifecycle === "enabled") {
      assertTriggerMetadata(currentConfig);
      await assertPackageAlias(currentConfig.packageRoute.packageAlias);
      if (
        currentConfig.upload.enqueueMode === "automatic"
        && !(typeof currentConfig.upload.targetPath === "string" && currentConfig.upload.targetPath.trim())
      ) {
        throw new ApiError(
          409,
          "UPLOAD_TARGET_NOT_CONFIGURED",
          "Set an upload destination before enabling automatic upload",
        );
      }
    }
    const timestamp = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const locked = getSubject(key);
      if (locked.config_version !== expectedVersion) {
        throw new ApiError(409, "VERSION_CONFLICT", "Subject was changed by another client", {
          expectedVersion,
          actualVersion: locked.config_version,
        });
      }
      const next = validate({
        ...rowSubject(locked),
        subjectKey: key,
        baseToken: locked.base_token,
        tableId: locked.table_id,
        projectId: locked.project_id,
        lifecycle,
        configVersion: locked.config_version + 1,
      });
      if (typeof syncSubject === "function") {
        // Keep the local transaction open until Bridge accepts the same
        // validated snapshot.  A failed loopback sync rolls back the local
        // lifecycle transition and leaves the subject as a draft/previous
        // state.
        await syncSubject(next, {
          lifecycle,
          expectedVersion,
        });
      }
      db.prepare("UPDATE feishu_subjects SET lifecycle=?, config_version=?, config_json=?, updated_at=? WHERE subject_key=? AND config_version=?")
        .run(lifecycle, next.configVersion, JSON.stringify(next), timestamp, key, expectedVersion);
      saveVersion({ subject_key: key }, next, next.configVersion, timestamp);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return rowSubject(getSubject(key));
  }
}
