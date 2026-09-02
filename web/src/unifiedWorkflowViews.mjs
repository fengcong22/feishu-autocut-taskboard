import {
  UNIFIED_WORKFLOW_STAGES,
} from "../../shared/unified-workflow-stages.mjs";

export const SYSTEM_UNIFIED_VIEW_ID = "all";
export const MAX_UNIFIED_WORKFLOW_VIEW_NAME_LENGTH = 64;

const UNIFIED_WORKFLOW_VIEWS_SCHEMA_VERSION = 1;
const UNIFIED_WORKFLOW_STAGE_SET = new Set(UNIFIED_WORKFLOW_STAGES);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredTrimmedString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} is required`);
  }
  return value.trim();
}

function normalizedRevision(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function normalizedViewName(value, { allowEmpty = false } = {}) {
  if (typeof value !== "string") {
    if (allowEmpty && value === undefined) return "";
    throw new TypeError("view name is required");
  }
  const name = value.trim();
  if (!allowEmpty && name.length === 0) throw new TypeError("view name is required");
  if ([...name].length > MAX_UNIFIED_WORKFLOW_VIEW_NAME_LENGTH) {
    throw new TypeError(`view name must be at most ${MAX_UNIFIED_WORKFLOW_VIEW_NAME_LENGTH} characters`);
  }
  return name;
}

function validatedStageIds(stageIds, { rejectDuplicates }) {
  if (!Array.isArray(stageIds)) throw new TypeError("stageIds must be an array");
  const seen = new Set();
  const normalized = [];
  for (const stageId of stageIds) {
    if (typeof stageId !== "string" || !UNIFIED_WORKFLOW_STAGE_SET.has(stageId)) {
      throw new TypeError(`unknown stage '${String(stageId)}'`);
    }
    if (seen.has(stageId)) {
      if (rejectDuplicates) throw new TypeError(`duplicate stage '${stageId}'`);
      continue;
    }
    seen.add(stageId);
    normalized.push(stageId);
  }
  return normalized;
}

function systemView(subjectKey, persisted = null) {
  const hasPersistedMetadata = isRecord(persisted)
    && persisted.id === SYSTEM_UNIFIED_VIEW_ID
    && persisted.subjectKey === subjectKey
    && persisted.isSystem === true;
  return {
    id: SYSTEM_UNIFIED_VIEW_ID,
    subjectKey,
    name: "全部流程",
    stageIds: UNIFIED_WORKFLOW_STAGES,
    isSystem: true,
    revision: hasPersistedMetadata ? normalizedRevision(persisted.revision) : 0,
    createdAt: hasPersistedMetadata && typeof persisted.createdAt === "string"
      ? persisted.createdAt
      : "",
    updatedAt: hasPersistedMetadata && typeof persisted.updatedAt === "string"
      ? persisted.updatedAt
      : "",
  };
}

function fallbackState(subjectKey, revision = 0) {
  return {
    schemaVersion: UNIFIED_WORKFLOW_VIEWS_SCHEMA_VERSION,
    subjectKey,
    revision,
    defaultViewId: SYSTEM_UNIFIED_VIEW_ID,
    activeViewId: SYSTEM_UNIFIED_VIEW_ID,
    views: [systemView(subjectKey)],
    readOnly: false,
  };
}

function newCustomViewId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `view-${uuid}`;
  return `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function stageIdsInBoardOrder(stageIds) {
  const selected = new Set(validatedStageIds(stageIds, { rejectDuplicates: false }));
  return UNIFIED_WORKFLOW_STAGES.filter((stageId) => selected.has(stageId));
}

export function validateUnifiedWorkflowViewInput(input, existingViews = []) {
  if (!isRecord(input)) throw new TypeError("view input must be an object");
  const subjectKey = requiredTrimmedString(input.subjectKey, "subjectKey");
  const name = normalizedViewName(input.name);
  const stageIds = validatedStageIds(input.stageIds, { rejectDuplicates: true });
  if (stageIds.length === 0) throw new TypeError("custom view requires at least one stage");

  const inputId = typeof input.id === "string" ? input.id.trim() : null;
  const duplicateName = Array.isArray(existingViews) && existingViews.some((view) => (
    isRecord(view)
    && view.subjectKey === subjectKey
    && view.id !== inputId
    && typeof view.name === "string"
    && view.name.trim() === name
  ));
  if (duplicateName) throw new TypeError(`view name already exists for subject '${subjectKey}'`);

  return { subjectKey, name, stageIds };
}

export function createUnifiedWorkflowView(input, now = new Date().toISOString()) {
  if (!isRecord(input)) throw new TypeError("view input must be an object");
  const subjectKey = requiredTrimmedString(input.subjectKey, "subjectKey");
  const name = normalizedViewName(input.name, { allowEmpty: true });
  const suppliedId = typeof input.id === "string" ? input.id.trim() : "";
  const id = suppliedId || newCustomViewId();
  if (id === SYSTEM_UNIFIED_VIEW_ID) {
    throw new TypeError(`custom view id cannot be '${SYSTEM_UNIFIED_VIEW_ID}'`);
  }
  const timestamp = requiredTrimmedString(now, "now");
  return {
    id,
    subjectKey,
    name,
    stageIds: [],
    isSystem: false,
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function normalizeUnifiedWorkflowViews(raw, requestedSubjectKey) {
  const subjectKey = requiredTrimmedString(requestedSubjectKey, "subjectKey");
  const collectionRevision = normalizedRevision(isRecord(raw) ? raw.revision : undefined);
  if (
    !isRecord(raw)
    || raw.schemaVersion !== UNIFIED_WORKFLOW_VIEWS_SCHEMA_VERSION
    || raw.subjectKey !== subjectKey
    || !Array.isArray(raw.views)
  ) {
    return fallbackState(subjectKey, collectionRevision);
  }

  const persistedSystem = raw.views.find((view) => (
    isRecord(view)
    && view.id === SYSTEM_UNIFIED_VIEW_ID
    && view.subjectKey === subjectKey
    && view.isSystem === true
  ));
  const views = [systemView(subjectKey, persistedSystem)];
  const viewIds = new Set([SYSTEM_UNIFIED_VIEW_ID]);

  for (const candidate of raw.views) {
    if (!isRecord(candidate) || candidate.id === SYSTEM_UNIFIED_VIEW_ID) continue;
    if (
      typeof candidate.id !== "string"
      || candidate.id.length === 0
      || candidate.id !== candidate.id.trim()
      || candidate.subjectKey !== subjectKey
      || candidate.isSystem !== false
      || !Number.isSafeInteger(candidate.revision)
      || candidate.revision < 0
      || typeof candidate.createdAt !== "string"
      || typeof candidate.updatedAt !== "string"
      || viewIds.has(candidate.id)
    ) {
      continue;
    }

    try {
      const normalized = validateUnifiedWorkflowViewInput(candidate, views);
      views.push({
        id: candidate.id,
        subjectKey,
        name: normalized.name,
        stageIds: normalized.stageIds,
        isSystem: false,
        revision: candidate.revision,
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
      });
      viewIds.add(candidate.id);
    } catch {
      // Persisted foreign, duplicate, or damaged definitions are ignored.
    }
  }

  const defaultViewId = typeof raw.defaultViewId === "string" && viewIds.has(raw.defaultViewId)
    ? raw.defaultViewId
    : SYSTEM_UNIFIED_VIEW_ID;
  const activeViewId = typeof raw.activeViewId === "string" && viewIds.has(raw.activeViewId)
    ? raw.activeViewId
    : SYSTEM_UNIFIED_VIEW_ID;
  return {
    schemaVersion: UNIFIED_WORKFLOW_VIEWS_SCHEMA_VERSION,
    subjectKey,
    revision: collectionRevision,
    defaultViewId,
    activeViewId,
    views,
    readOnly: raw.readOnly === true,
  };
}
