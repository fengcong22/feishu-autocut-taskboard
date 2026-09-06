const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u;

export const STAGE_IDS = Object.freeze(["initial", "first_review", "final_review"]);

function fail(message, code = "INVALID_FIELD") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function text(value, name, { optional = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (optional) return null;
    throw fail(`${name} is required`);
  }
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw fail(`${name} is invalid`);
  }
  return value.trim();
}

function identifier(value, name, { optional = false } = {}) {
  const result = text(value, name, { optional });
  if (result === null) return null;
  if (!IDENTIFIER.test(result)) throw fail(`${name} is invalid`);
  return result;
}

function plainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail(`${name} must be an object`);
  return value;
}

function fieldId(field) {
  return field?.fieldId ?? field?.id ?? null;
}

function fieldName(field) {
  return field?.fieldName ?? field?.name ?? null;
}

function metadataFields(metadata) {
  if (Array.isArray(metadata)) return metadata;
  return Array.isArray(metadata?.fields) ? metadata.fields : [];
}

function metadataField(metadata, id) {
  return metadataFields(metadata).find((field) => fieldId(field) === id) ?? null;
}

function isSingleSelect(field) {
  const uiType = String(field?.uiType ?? field?.type ?? "").toLowerCase().replace(/[\s_-]/gu, "");
  return uiType === "singleselect" || uiType === "select" || field?.type === 3;
}

function isAttachment(field) {
  const uiType = String(field?.uiType ?? field?.type ?? "").toLowerCase().replace(/[\s_-]/gu, "");
  return uiType === "attachment" || uiType === "attachments" || field?.type === 17;
}

function normalizeSource(source, metadata, name, { review = false } = {}) {
  plainObject(source, name);
  const kind = text(source.kind, `${name}.kind`);
  if (kind === "docx_section") {
    const anchorText = text(source.anchorText ?? source.anchor_text, `${name}.anchorText`);
    return { kind, anchorText };
  }
  if (kind === "base_attachment" && !review) {
    const fieldIdValue = identifier(source.fieldId ?? source.field_id, `${name}.fieldId`);
    const field = metadataField(metadata, fieldIdValue);
    if (field && !isAttachment(field)) throw fail(`${name}.fieldId must identify an attachment field`);
    return { kind, fieldId: fieldIdValue };
  }
  throw fail(`${name}.kind is invalid`);
}

function normalizeAudio(audio, metadata, name) {
  plainObject(audio, name);
  const mode = text(audio.mode, `${name}.mode`);
  if (mode === "video_original") return { mode };
  if (mode !== "replace_original") throw fail(`${name}.mode is invalid`);
  if (audio.source === null || audio.source === undefined) throw fail(`${name} audio source is required`);
  const source = normalizeSource(audio.source, metadata, `${name}.source`);
  const tolerance = audio.durationToleranceSeconds ?? audio.duration_tolerance_seconds ?? 3;
  if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance <= 0) {
    throw fail(`${name}.durationToleranceSeconds must be positive`);
  }
  return {
    mode,
    source,
    durationToleranceSeconds: tolerance,
  };
}

/**
 * Normalize one of the fixed stage entries. The function is deliberately
 * independent from the database so Bridge and Taskboard can share the same
 * field/source contract without importing either application's internals.
 */
export function normalizeStage(stage, metadata = null, stageId = "stage") {
  plainObject(stage, `stages.${stageId}`);
  if (!STAGE_IDS.includes(stageId)) throw fail(`Unknown stage '${stageId}'`);
  const enabled = stage.enabled === undefined ? false : stage.enabled;
  if (typeof enabled !== "boolean") throw fail(`stages.${stageId}.enabled must be boolean`);

  const triggerInput = stage.trigger ?? {};
  plainObject(triggerInput, `stages.${stageId}.trigger`);
  const triggerFieldId = identifier(triggerInput.fieldId ?? triggerInput.field_id, `stages.${stageId}.trigger.fieldId`, { optional: !enabled });
  const optionId = identifier(triggerInput.optionId ?? triggerInput.option_id, `stages.${stageId}.trigger.optionId`, { optional: !enabled });
  const value = text(
    triggerInput.value ?? triggerInput.startValue ?? triggerInput.start_value,
    `stages.${stageId}.trigger.value`,
    { optional: !enabled },
  );
  const statusField = metadataField(metadata, triggerFieldId);
  const fieldNameValue = text(
    triggerInput.fieldName ?? triggerInput.field_name ?? fieldName(statusField),
    `stages.${stageId}.trigger.fieldName`,
    { optional: !enabled },
  );

  const videoSource = normalizeSource(stage.videoSource ?? stage.video_source, metadata, `stages.${stageId}.videoSource`);
  const reviewSource = normalizeSource(stage.reviewSource ?? stage.review_source, metadata, `stages.${stageId}.reviewSource`, { review: true });
  const audio = normalizeAudio(stage.audio, metadata, `stages.${stageId}.audio`);
  const artifactTargetPath = text(
    stage.artifactTargetPath ?? stage.artifact_target_path,
    `stages.${stageId}.artifactTargetPath`,
    { optional: true },
  );
  if (artifactTargetPath !== null && !ABSOLUTE_PATH.test(artifactTargetPath)) {
    throw fail(`stages.${stageId}.artifactTargetPath must be absolute`);
  }
  const nameSuffix = text(stage.nameSuffix ?? stage.name_suffix, `stages.${stageId}.nameSuffix`);

  return {
    enabled,
    trigger: {
      fieldId: triggerFieldId,
      fieldName: fieldNameValue,
      optionId,
      value,
    },
    videoSource,
    reviewSource,
    audio,
    artifactTargetPath,
    nameSuffix,
  };
}

function validateMetadataField(metadata, descriptor, name, predicate = null, { required = true } = {}) {
  const id = identifier(descriptor?.fieldId ?? descriptor?.field_id, `${name}.fieldId`, { optional: !required });
  const configuredName = text(descriptor?.fieldName ?? descriptor?.field_name, `${name}.fieldName`, { optional: !required });
  if (id === null) return { fieldId: null, fieldName: null };
  const field = metadataField(metadata, id);
  if (metadataFields(metadata).length > 0 && !field) throw fail(`${name}.fieldId is not present in metadata`, "FIELD_NOT_FOUND");
  if (field && predicate && !predicate(field)) throw fail(`${name}.fieldId has an incompatible type`, "FIELD_TYPE_INVALID");
  return { fieldId: id, fieldName: configuredName ?? text(fieldName(field), `${name}.fieldName`) };
}

/**
 * Validate and normalize the phased subject portion of a workflow subject.
 * The caller decides whether the subject is a legacy single-trigger subject;
 * this function is only required when staged fields are present.
 */
export function validatePhasedSubjectConfig(value) {
  plainObject(value, "Subject configuration");
  const metadata = value.metadata ?? null;
  const statusField = validateMetadataField(metadata, value.statusField, "statusField", isSingleSelect);
  if (!statusField.fieldId) throw fail("statusField is required");
  const documentField = validateMetadataField(metadata, value.documentField, "documentField", null);
  if (!documentField.fieldId) throw fail("documentField is required");
  const namingField = validateMetadataField(metadata, value.namingField, "namingField", null);
  if (!namingField.fieldId) throw fail("namingField is required");
  const stagesValue = plainObject(value.stages, "stages");
  const unknownStage = Object.keys(stagesValue).find((key) => !STAGE_IDS.includes(key));
  if (unknownStage) throw fail(`Unknown stage '${unknownStage}'`);
  const stages = {};
  for (const stageId of STAGE_IDS) {
    stages[stageId] = normalizeStage(stagesValue[stageId], metadata, stageId);
    if (stages[stageId].trigger.fieldId !== null && stages[stageId].trigger.fieldId !== statusField.fieldId) {
      throw fail(`stages.${stageId}.trigger.fieldId must match statusField.fieldId`);
    }
    if (stages[stageId].enabled && stages[stageId].trigger.optionId === null) {
      throw fail(`stages.${stageId}.trigger.optionId is required`);
    }
  }
  const enabled = STAGE_IDS.filter((stageId) => stages[stageId].enabled);
  if (enabled.length === 0) throw fail("at least one stage must be enabled");
  const optionIds = enabled.map((stageId) => stages[stageId].trigger.optionId);
  if (new Set(optionIds).size !== optionIds.length) throw fail("enabled stage trigger options must be unique");
  const field = metadataField(metadata, statusField.fieldId);
  if (field && Array.isArray(field.options)) {
    for (const stageId of enabled) {
      const option = field.options.find((candidate) => candidate?.id === stages[stageId].trigger.optionId);
      if (!option) throw fail(`stages.${stageId}.trigger.optionId is not present in metadata`, "TRIGGER_OPTION_NOT_FOUND");
      if (option.name !== stages[stageId].trigger.value) {
        throw fail(`stages.${stageId}.trigger.value does not match metadata`, "TRIGGER_OPTION_NOT_FOUND");
      }
    }
  }
  return {
    ...value,
    statusField,
    documentField,
    namingField,
    stages,
  };
}

export function isPhasedSubject(value) {
  return Boolean(value && typeof value === "object" && (value.stages || value.statusField || value.documentField || value.namingField));
}

export function portablePhasedSubject(value) {
  if (!isPhasedSubject(value)) return value;
  const normalized = validatePhasedSubjectConfig(value);
  return {
    ...normalized,
    stages: Object.fromEntries(STAGE_IDS.map((stageId) => [
      stageId,
      { ...normalized.stages[stageId], artifactTargetPath: null },
    ])),
  };
}
