import {
  REAL_UNIFIED_WORKFLOW_STAGES,
} from "../../shared/unified-workflow-stages.mjs";

const REAL_STAGE_IDS = new Set(REAL_UNIFIED_WORKFLOW_STAGES);

// Drag payload values are protected during dragenter/dragover, but browsers
// expose their MIME types. This marker lets the board accept only its own
// drags before the final drop guard reads the protected values.
export const UNIFIED_WORKFLOW_DRAG_MIME_TYPE = "application/x-taskboard-unified-workflow-source";

export function hasUnifiedWorkflowDragType(types) {
  return Array.from(types ?? []).includes(UNIFIED_WORKFLOW_DRAG_MIME_TYPE);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate a task move initiated from the unified Feishu subject board.
 *
 * The regular taskboard move handler is intentionally broader because it also
 * serves ordinary projects and the Other Tasks panel. Keeping this predicate
 * separate makes the unified board's source and subject boundaries explicit.
 */
export function canDropUnifiedWorkflowTask(input) {
  if (!isRecord(input)) return false;

  const {
    projectId,
    subjectKey,
    visibleStageIds,
    task,
    targetStage,
    sourceSurface,
  } = input;

  if (
    sourceSurface !== "unified-board"
    || typeof projectId !== "string"
    || !projectId
    || typeof subjectKey !== "string"
    || !subjectKey
    || !Array.isArray(visibleStageIds)
    || typeof targetStage !== "string"
    || !REAL_STAGE_IDS.has(targetStage)
    || !visibleStageIds.includes(targetStage)
    || !isRecord(task)
    || typeof task.id !== "string"
    || !task.id
    || task.projectId !== projectId
    || task.archivedAt != null
    || !REAL_STAGE_IDS.has(task.status)
  ) {
    return false;
  }

  const origin = task.feishuOrigin;
  return isRecord(origin)
    && origin.source === "feishu-base"
    && origin.subjectKey === subjectKey;
}
