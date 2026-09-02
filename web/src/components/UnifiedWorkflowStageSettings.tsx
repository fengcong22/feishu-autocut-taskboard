import { useEffect, useId, useRef, useState } from "react";
import {
  ApiError,
  getUnifiedWorkflowStageDisplays,
  saveUnifiedWorkflowStageDisplay,
} from "../api";
import { useTaskboardI18n } from "../i18n";
import type { StageDisplayOverride, UnifiedWorkflowStage } from "../types";
import { LinearIcon } from "./LinearIcon";

// The stable registry is shared with the server and the unified board runtime.
// @ts-expect-error The shared ESM registry intentionally has no TypeScript declaration.
import { UNIFIED_WORKFLOW_STAGES } from "../../../shared/unified-workflow-stages.mjs";

type DisplayDraft = {
  zhName: string;
  enName: string;
  zhDescription: string;
  enDescription: string;
};

type DisplayField = keyof DisplayDraft;

type Props = {
  subjectKey: string;
  overrides: StageDisplayOverride[];
  onChange: (override: StageDisplayOverride) => void;
  onError?: (message: string) => void;
};

const STAGES = UNIFIED_WORKFLOW_STAGES as readonly UnifiedWorkflowStage[];
const STAGE_SET = new Set<UnifiedWorkflowStage>(STAGES);
const EMPTY_DRAFT: DisplayDraft = {
  zhName: "",
  enName: "",
  zhDescription: "",
  enDescription: "",
};

const DEFAULT_STAGE_TEXT: Record<
  UnifiedWorkflowStage,
  { zhName: string; enName: string; zhDescription: string; enDescription: string }
> = {
  todo: {
    zhName: "待处理",
    enName: "Ready",
    zhDescription: "任务已进入 Taskboard，等待开始处理。",
    enDescription: "The task is ready to start.",
  },
  queued: {
    zhName: "排队中",
    enName: "Queued",
    zhDescription: "任务正在等待可用的 Auto-Cut 执行名额。",
    enDescription: "The task is waiting for an available Auto-Cut slot.",
  },
  in_progress: {
    zhName: "处理中",
    enName: "Processing",
    zhDescription: "Auto-Cut/Codex 正在执行剪辑。",
    enDescription: "Auto-Cut/Codex is editing the task.",
  },
  blocked: {
    zhName: "阻塞",
    enName: "Blocked",
    zhDescription: "任务需要处理错误或补充信息后才能继续。",
    enDescription: "The task needs an error resolved or more information before it can continue.",
  },
  in_review: {
    zhName: "待验收",
    enName: "Review",
    zhDescription: "手动模式的剪辑结果正在等待确认。",
    enDescription: "A manual editing result is waiting for confirmation.",
  },
  completed_editing: {
    zhName: "已完成剪辑",
    enName: "Editing complete",
    zhDescription: "剪辑已完成，剪映草稿 ZIP 可以加入上传队列。",
    enDescription: "Editing is complete and the draft ZIP can be queued for upload.",
  },
  upload_queue: {
    zhName: "上传队列",
    enName: "Upload queue",
    zhDescription: "剪映草稿 ZIP 正在等待上传。",
    enDescription: "The draft ZIP is waiting to upload.",
  },
  uploading: {
    zhName: "上传中",
    enName: "Uploading",
    zhDescription: "正在把剪映草稿 ZIP 复制到目标位置。",
    enDescription: "The draft ZIP is being copied to its destination.",
  },
  uploaded: {
    zhName: "已上传",
    enName: "Uploaded",
    zhDescription: "剪映草稿 ZIP 已成功复制到目标位置。",
    enDescription: "The draft ZIP was copied to its destination.",
  },
};

function scopedOverrides(
  subjectKey: string,
  overrides: StageDisplayOverride[],
): Map<UnifiedWorkflowStage, StageDisplayOverride> {
  const result = new Map<UnifiedWorkflowStage, StageDisplayOverride>();
  for (const override of overrides) {
    if (override.subjectKey === subjectKey && STAGE_SET.has(override.stageId)) {
      result.set(override.stageId, override);
    }
  }
  return result;
}

function draftFor(override?: StageDisplayOverride): DisplayDraft {
  if (!override) return { ...EMPTY_DRAFT };
  return {
    zhName: override.zhName ?? "",
    enName: override.enName ?? "",
    zhDescription: override.zhDescription ?? "",
    enDescription: override.enDescription ?? "",
  };
}

function draftsFor(
  rows: Map<UnifiedWorkflowStage, StageDisplayOverride>,
): Record<UnifiedWorkflowStage, DisplayDraft> {
  return Object.fromEntries(STAGES.map((stageId) => [stageId, draftFor(rows.get(stageId))])) as Record<
    UnifiedWorkflowStage,
    DisplayDraft
  >;
}

function normalizedDraftValue(value: string): string | null {
  return value.trim() === "" ? null : value;
}

function isDirty(override: StageDisplayOverride | undefined, draft: DisplayDraft): boolean {
  if (!override) return false;
  return (
    normalizedDraftValue(draft.zhName) !== override.zhName
    || normalizedDraftValue(draft.enName) !== override.enName
    || normalizedDraftValue(draft.zhDescription) !== override.zhDescription
    || normalizedDraftValue(draft.enDescription) !== override.enDescription
  );
}

function hasSavedOverride(override: StageDisplayOverride | undefined): boolean {
  return Boolean(override && (
    override.zhName !== null
    || override.enName !== null
    || override.zhDescription !== null
    || override.enDescription !== null
  ));
}

export function UnifiedWorkflowStageSettings({
  subjectKey,
  overrides,
  onChange,
  onError,
}: Props) {
  const { text } = useTaskboardI18n();
  const instanceId = useId().replaceAll(":", "");
  const subjectKeyRef = useRef(subjectKey);
  subjectKeyRef.current = subjectKey;

  const initialRows = scopedOverrides(subjectKey, overrides);
  const [rows, setRows] = useState(initialRows);
  const [drafts, setDrafts] = useState(() => draftsFor(initialRows));
  const [busyStages, setBusyStages] = useState<Set<UnifiedWorkflowStage>>(() => new Set());
  const [conflictStage, setConflictStage] = useState<UnifiedWorkflowStage | null>(null);

  useEffect(() => {
    const nextRows = scopedOverrides(subjectKey, overrides);
    setRows(nextRows);
    setDrafts(draftsFor(nextRows));
    setBusyStages(new Set());
    setConflictStage(null);
  }, [subjectKey, overrides]);

  function setStageBusy(stageId: UnifiedWorkflowStage, busy: boolean) {
    setBusyStages((current) => {
      const next = new Set(current);
      if (busy) next.add(stageId);
      else next.delete(stageId);
      return next;
    });
  }

  function updateDraft(stageId: UnifiedWorkflowStage, field: DisplayField, value: string) {
    setDrafts((current) => ({
      ...current,
      [stageId]: { ...current[stageId], [field]: value },
    }));
    if (conflictStage === stageId) setConflictStage(null);
  }

  function replaceRows(nextOverrides: StageDisplayOverride[]) {
    const nextRows = scopedOverrides(subjectKey, nextOverrides);
    setRows(nextRows);
    setDrafts(draftsFor(nextRows));
  }

  async function reloadAfterConflict(stageId: UnifiedWorkflowStage, operationSubjectKey: string) {
    try {
      const latest = await getUnifiedWorkflowStageDisplays(operationSubjectKey);
      if (subjectKeyRef.current !== operationSubjectKey) return;
      replaceRows(latest);
      setConflictStage(stageId);
      for (const override of latest) {
        if (override.subjectKey === operationSubjectKey && STAGE_SET.has(override.stageId)) {
          onChange(override);
        }
      }
      onError?.(text(
        `流程 ${stageId} 已在其他窗口修改，已重新加载最新内容。`,
        `Stage ${stageId} changed in another window. The latest content was reloaded.`,
      ));
    } catch (error) {
      if (subjectKeyRef.current !== operationSubjectKey) return;
      onError?.(error instanceof Error
        ? error.message
        : text("无法重新加载流程显示设置", "Could not reload stage display settings"));
    }
  }

  async function save(stageId: UnifiedWorkflowStage, reset = false) {
    const row = rows.get(stageId);
    if (!row || busyStages.has(stageId)) return;
    const operationSubjectKey = subjectKey;
    setStageBusy(stageId, true);
    setConflictStage(null);
    try {
      const draft = drafts[stageId];
      const nextOverrides = await saveUnifiedWorkflowStageDisplay(operationSubjectKey, stageId, {
        revision: row.revision,
        zhName: reset ? null : normalizedDraftValue(draft.zhName),
        enName: reset ? null : normalizedDraftValue(draft.enName),
        zhDescription: reset ? null : normalizedDraftValue(draft.zhDescription),
        enDescription: reset ? null : normalizedDraftValue(draft.enDescription),
      });
      if (subjectKeyRef.current !== operationSubjectKey) return;
      replaceRows(nextOverrides);
      const changed = nextOverrides.find((override) => (
        override.subjectKey === operationSubjectKey && override.stageId === stageId
      ));
      if (changed) onChange(changed);
    } catch (error) {
      if (subjectKeyRef.current !== operationSubjectKey) return;
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        await reloadAfterConflict(stageId, operationSubjectKey);
      } else {
        onError?.(error instanceof Error
          ? error.message
          : text("无法保存流程显示设置", "Could not save stage display settings"));
      }
    } finally {
      if (subjectKeyRef.current === operationSubjectKey) setStageBusy(stageId, false);
    }
  }

  function reset(stageId: UnifiedWorkflowStage) {
    const row = rows.get(stageId);
    if (!row) return;
    if (!hasSavedOverride(row)) {
      setDrafts((current) => ({ ...current, [stageId]: draftFor(row) }));
      setConflictStage(null);
      return;
    }
    void save(stageId, true);
  }

  return (
    <section className="unified-stage-settings" aria-label={text("当前学科流程显示设置", "Current subject stage display settings")}>
      <header className="unified-stage-settings-header">
        <div>
          <h3>{text("流程名称与说明", "Stage names and descriptions")}</h3>
          <p>{text(
            "设置只应用于当前学科；内部流程标识和任务归类不会改变。",
            "These settings apply only to this subject. Internal stage IDs and task routing stay unchanged.",
          )}</p>
        </div>
      </header>

      {conflictStage && (
        <div className="unified-stage-settings-conflict" role="alert">
          {text(
            `流程 ${conflictStage} 已被其他窗口修改，当前表单已更新为最新内容。`,
            `Stage ${conflictStage} was changed in another window. This form now shows the latest content.`,
          )}
        </div>
      )}

      <div className="unified-stage-settings-list">
        {STAGES.map((stageId) => {
          const row = rows.get(stageId);
          const draft = drafts[stageId];
          const defaults = DEFAULT_STAGE_TEXT[stageId];
          const busy = busyStages.has(stageId);
          const dirty = isDirty(row, draft);
          const helpId = `${instanceId}-${stageId}-display-help`;
          const fieldId = (field: DisplayField) => `${instanceId}-${stageId}-${field}`;
          return (
            <fieldset className="unified-stage-settings-row" key={stageId} disabled={busy}>
              <legend>{text(defaults.zhName, defaults.enName)}</legend>
              <div className="unified-stage-settings-fields">
                <label htmlFor={fieldId("zhName")}>
                  <span>{text("中文名称", "Chinese name")}</span>
                  <input
                    id={fieldId("zhName")}
                    value={draft.zhName}
                    maxLength={32}
                    placeholder={defaults.zhName}
                    aria-describedby={helpId}
                    onChange={(event) => updateDraft(stageId, "zhName", event.target.value)}
                  />
                </label>
                <label htmlFor={fieldId("enName")}>
                  <span>{text("英文名称", "English name")}</span>
                  <input
                    id={fieldId("enName")}
                    value={draft.enName}
                    maxLength={32}
                    placeholder={defaults.enName}
                    aria-describedby={helpId}
                    onChange={(event) => updateDraft(stageId, "enName", event.target.value)}
                  />
                </label>
                <label htmlFor={fieldId("zhDescription")}>
                  <span>{text("中文说明", "Chinese description")}</span>
                  <input
                    id={fieldId("zhDescription")}
                    value={draft.zhDescription}
                    maxLength={120}
                    placeholder={defaults.zhDescription}
                    aria-describedby={helpId}
                    onChange={(event) => updateDraft(stageId, "zhDescription", event.target.value)}
                  />
                </label>
                <label htmlFor={fieldId("enDescription")}>
                  <span>{text("英文说明", "English description")}</span>
                  <input
                    id={fieldId("enDescription")}
                    value={draft.enDescription}
                    maxLength={120}
                    placeholder={defaults.enDescription}
                    aria-describedby={helpId}
                    onChange={(event) => updateDraft(stageId, "enDescription", event.target.value)}
                  />
                </label>
                <label htmlFor={`${instanceId}-${stageId}-internal-id`}>
                  <span>{text("内部标识", "Internal ID")}</span>
                  <input
                    id={`${instanceId}-${stageId}-internal-id`}
                    value={stageId}
                    readOnly
                    aria-describedby={helpId}
                  />
                </label>
              </div>
              <small id={helpId} className="unified-stage-settings-help">
                {text(
                  "留空时使用系统默认文字。名称最多 32 个字符，说明最多 120 个字符。",
                  "Leave a field empty to use its system default. Names allow 32 characters and descriptions allow 120.",
                )}
              </small>
              <div className="unified-stage-settings-actions">
                <button
                  type="button"
                  className="icon-button"
                  title={text("保存", "Save")}
                  aria-label={text(`保存 ${defaults.zhName}`, `Save ${defaults.enName}`)}
                  disabled={!row || !dirty || busy}
                  onClick={() => void save(stageId)}
                >
                  <LinearIcon name="check" />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title={text("重置为系统默认", "Reset to system defaults")}
                  aria-label={text(`重置 ${defaults.zhName}`, `Reset ${defaults.enName}`)}
                  disabled={!row || (!dirty && !hasSavedOverride(row)) || busy}
                  onClick={() => reset(stageId)}
                >
                  <LinearIcon name="recurrence" />
                </button>
              </div>
            </fieldset>
          );
        })}
      </div>
    </section>
  );
}

export default UnifiedWorkflowStageSettings;
