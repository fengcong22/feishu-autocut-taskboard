import { createHash } from "node:crypto";

import { ApiError } from "./database.mjs";

const now = () => new Date().toISOString();

export function subjectProjectId(subjectKey) {
  const digest = createHash("sha256").update(String(subjectKey), "utf8").digest("hex").slice(0, 16);
  return `feishu-${digest}`;
}

function requireText(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new ApiError(400, "INVALID_FIELD", `${name} is required`);
  if (value.includes("\0")) throw new ApiError(400, "INVALID_FIELD", `${name} contains null bytes`);
  return value.trim();
}

function parseSubjectKey(value) {
  const key = requireText(value, "subjectKey");
  const separator = key.indexOf(":");
  if (separator <= 0 || separator === key.length - 1 || key.indexOf(":", separator + 1) !== -1) {
    throw new ApiError(400, "INVALID_FIELD", "subjectKey must be baseToken:tableId");
  }
  return { subjectKey: key, baseToken: key.slice(0, separator), tableId: key.slice(separator + 1) };
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
    SELECT * FROM feishu_subjects WHERE base_token = ? ORDER BY table_name, table_id
  `).all(row.base_token).map(rowSubject);
  return {
    baseToken: row.base_token,
    baseName: row.base_name,
    sourceUrlLabel: row.source_url_label,
    metadataRefreshedAt: row.metadata_refreshed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    subjects,
  };
}

function snapshotFor(row) {
  return rowSubject(row);
}

const SUBJECT_PATCH_KEYS = new Set([
  "subjectKey", "baseToken", "baseName", "tableId", "tableName", "projectId", "displayEnabled",
  "lifecycle", "configVersion", "trigger", "title", "execution", "packageRoute", "upload",
]);

function validateSubjectConfig(value) {
  for (const key of Object.keys(value)) {
    if (!SUBJECT_PATCH_KEYS.has(key) && !["metadata", "createdAt", "updatedAt"].includes(key)) {
      throw new ApiError(400, "UNKNOWN_FIELD", `Unknown subject field '${key}'`);
    }
  }
  if (typeof value.displayEnabled !== "boolean") throw new ApiError(400, "INVALID_FIELD", "displayEnabled must be boolean");
  if (!value.trigger || typeof value.trigger !== "object" || !value.trigger.fieldId || !value.trigger.fieldName || !value.trigger.startValue) {
    throw new ApiError(400, "INVALID_FIELD", "trigger field and startValue are required");
  }
  if (!value.execution || !["manual", "automatic"].includes(value.execution.mode)) throw new ApiError(400, "INVALID_FIELD", "execution.mode is invalid");
  if (!Number.isInteger(value.execution.maxConcurrent) || value.execution.maxConcurrent < 1) throw new ApiError(400, "INVALID_FIELD", "execution.maxConcurrent must be positive");
  if (!value.packageRoute || typeof value.packageRoute.packageAlias !== "string" || !value.packageRoute.packageAlias.trim() || /[\\/\0\s]/u.test(value.packageRoute.packageAlias)) throw new ApiError(400, "INVALID_FIELD", "packageRoute.packageAlias is invalid");
  if (!value.upload || !["manual", "automatic"].includes(value.upload.enqueueMode)) throw new ApiError(400, "INVALID_FIELD", "upload.enqueueMode is invalid");
  for (const field of ["artifactSourcePath", "targetPath"]) {
    const candidate = value.upload[field];
    if (candidate !== null && candidate !== undefined && candidate !== "" && !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(candidate)) {
      throw new ApiError(400, "INVALID_FIELD", `upload.${field} must be absolute`);
    }
  }
  return value;
}

export function createFeishuWorkflowStore({ database, validateConfig = null } = {}) {
  if (!database?.database) throw new TypeError("database is required");
  const db = database.database;
  const validate = (value) => {
    const normalized = typeof validateConfig === "function" ? validateConfig(value) : value;
    return validateSubjectConfig(normalized);
  };
  function getSubject(subjectKey) {
    const row = db.prepare("SELECT * FROM feishu_subjects WHERE subject_key = ?").get(subjectKey);
    if (!row) throw new ApiError(404, "SUBJECT_NOT_FOUND", `Subject '${subjectKey}' does not exist`);
    return row;
  }
  function saveVersion(row, snapshot, version, timestamp) {
    db.prepare(`INSERT INTO feishu_subject_versions (subject_key, version, snapshot_json, created_at) VALUES (?, ?, ?, ?)`)
      .run(row.subject_key, version, JSON.stringify(snapshot), timestamp);
  }
  return {
    async listCatalog() {
      return db.prepare("SELECT * FROM feishu_bases ORDER BY base_name, base_token").all().map((row) => rowBase(db, row));
    },
    async getSubject(subjectKey) {
      return rowSubject(getSubject(parseSubjectKey(subjectKey).subjectKey));
    },
    async upsertBasePreview(preview) {
      if (!preview || typeof preview !== "object" || Array.isArray(preview)) throw new ApiError(400, "INVALID_BODY", "Base preview must be an object");
      const baseToken = requireText(preview.baseToken, "baseToken");
      const baseName = requireText(preview.baseName, "baseName");
      if (!Array.isArray(preview.tables)) throw new ApiError(400, "INVALID_FIELD", "tables must be an array");
      const timestamp = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`INSERT INTO feishu_bases (base_token, base_name, source_url_label, metadata_refreshed_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(base_token) DO UPDATE SET base_name=excluded.base_name, source_url_label=excluded.source_url_label,
          metadata_refreshed_at=excluded.metadata_refreshed_at, updated_at=excluded.updated_at`)
          .run(baseToken, baseName, preview.sourceUrlLabel ?? null, preview.metadataRefreshedAt ?? null, timestamp, timestamp);
        for (const table of preview.tables) {
          const tableId = requireText(table.tableId, "tableId");
          const tableName = requireText(table.tableName, "tableName");
          const key = `${baseToken}:${tableId}`;
          const existing = db.prepare("SELECT * FROM feishu_subjects WHERE subject_key = ?").get(key);
          const metadata = { fields: Array.isArray(table.fields) ? table.fields : [] };
          if (existing) {
            db.prepare("UPDATE feishu_subjects SET table_name = ?, metadata_json = ?, updated_at = ? WHERE subject_key = ?")
              .run(tableName, JSON.stringify(metadata), timestamp, key);
          } else {
            const initial = validate({
              subjectKey: key,
              baseToken,
              baseName,
              tableId,
              tableName,
              displayEnabled: true,
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
              VALUES (?, ?, ?, ?, ?, 1, 'draft', 1, ?, ?, ?, ?)`)
              .run(key, baseToken, tableId, tableName, subjectProjectId(key), JSON.stringify(initial), JSON.stringify(metadata), timestamp, timestamp);
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
      const current = getSubject(key);
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new ApiError(400, "INVALID_BODY", "Subject patch must be an object");
      const next = validate({ ...rowSubject(current), ...patch, subjectKey: key, lifecycle: "draft", configVersion: current.config_version + 1 });
      const timestamp = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("UPDATE feishu_subjects SET lifecycle='draft', config_version=?, config_json=?, display_enabled=?, updated_at=? WHERE subject_key=?")
          .run(next.configVersion, JSON.stringify(next), next.displayEnabled === false ? 0 : 1, timestamp, key);
        saveVersion({ subject_key: key }, next, next.configVersion, timestamp);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return rowSubject(getSubject(key));
    },
    async enableSubject(subjectKey, expectedVersion) { return transition(subjectKey, expectedVersion, "enabled"); },
    async disableSubject(subjectKey, expectedVersion) { return transition(subjectKey, expectedVersion, "disabled"); },
  };

  async function transition(subjectKey, expectedVersion, lifecycle) {
    const key = parseSubjectKey(subjectKey).subjectKey;
    const current = getSubject(key);
    if (!Number.isInteger(expectedVersion) || expectedVersion !== current.config_version) {
      throw new ApiError(409, "VERSION_CONFLICT", "Subject was changed by another client", { expectedVersion, actualVersion: current.config_version });
    }
    const base = rowBase(db, db.prepare("SELECT * FROM feishu_bases WHERE base_token = ?").get(current.base_token));
    const next = validate({ ...rowSubject(current), lifecycle, configVersion: current.config_version + 1 });
    const timestamp = now();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE feishu_subjects SET lifecycle=?, config_version=?, config_json=?, updated_at=? WHERE subject_key=? AND config_version=?")
        .run(lifecycle, next.configVersion, JSON.stringify(next), timestamp, key, expectedVersion);
      saveVersion({ subject_key: key }, next, next.configVersion, timestamp);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return rowSubject(getSubject(key));
  }
}
