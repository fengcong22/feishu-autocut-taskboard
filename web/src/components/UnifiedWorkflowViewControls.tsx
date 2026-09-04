import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  createUnifiedWorkflowView,
  deleteUnifiedWorkflowView,
  getUnifiedWorkflowViews,
  updateUnifiedWorkflowView,
} from "../api";
import { useTaskboardI18n } from "../i18n";
import type {
  StageDisplayOverride,
  UnifiedWorkflowStage,
  UnifiedWorkflowView,
  UnifiedWorkflowViewsState,
} from "../types";
import { LinearIcon } from "./LinearIcon";

// The server and board use this registry as the stable stage identity and order.
// @ts-expect-error The shared ESM registry intentionally has no TypeScript declaration.
import { UNIFIED_WORKFLOW_STAGES } from "../../../shared/unified-workflow-stages.mjs";
// Layout preferences are browser-only and scoped to a project/view pair.
// @ts-expect-error The helper's storage contract is covered by focused node tests.
import { resetUnifiedWorkflowLayout } from "../unifiedWorkflowLayout.mjs";

type ViewDraft = {
  kind: "create" | "copy" | "edit";
  sourceViewId: string | null;
  name: string;
  stageIds: UnifiedWorkflowStage[];
};

type OperationScope = {
  subjectKey: string;
  generation: number;
};

type Props = {
  projectId: string;
  subjectKey: string;
  state: UnifiedWorkflowViewsState;
  stageDisplays?: StageDisplayOverride[];
  onChange: (state: UnifiedWorkflowViewsState) => void;
  onError?: (message: string) => void;
};

const STAGES = UNIFIED_WORKFLOW_STAGES as readonly UnifiedWorkflowStage[];
const MAX_VIEW_NAME_LENGTH = 64;
const SYSTEM_VIEW_ID = "all";

const DEFAULT_STAGE_NAMES: Record<UnifiedWorkflowStage, { zh: string; en: string }> = {
  todo: { zh: "待处理", en: "Ready" },
  queued: { zh: "排队中", en: "Queued" },
  in_progress: { zh: "处理中", en: "Processing" },
  blocked: { zh: "阻塞", en: "Blocked" },
  in_review: { zh: "待验收", en: "Review" },
  completed_editing: { zh: "已完成剪辑", en: "Editing complete" },
  upload_queue: { zh: "上传队列", en: "Upload queue" },
  uploading: { zh: "上传中", en: "Uploading" },
  uploaded: { zh: "已上传", en: "Uploaded" },
};

function truncateName(value: string, maximum: number) {
  return [...value].slice(0, Math.max(0, maximum)).join("");
}

function uniqueCopyName(sourceName: string, suffix: string, views: UnifiedWorkflowView[]) {
  const existingNames = new Set(views.map((view) => view.name.trim()));
  for (let ordinal = 1; ; ordinal += 1) {
    const copySuffix = ordinal === 1 ? ` ${suffix}` : ` ${suffix} ${ordinal}`;
    const prefix = truncateName(sourceName.trim(), MAX_VIEW_NAME_LENGTH - [...copySuffix].length);
    const candidate = `${prefix}${copySuffix}`;
    if (!existingNames.has(candidate)) return candidate;
  }
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function UnifiedWorkflowViewControls({
  projectId,
  subjectKey,
  state,
  stageDisplays = [],
  onChange,
  onError,
}: Props) {
  const { text } = useTaskboardI18n();
  const instanceId = useId().replaceAll(":", "");
  const subjectKeyRef = useRef(subjectKey);
  const requestGenerationRef = useRef(0);
  const enteredSubjectKeyRef = useRef<string | null>(null);

  const [currentState, setCurrentState] = useState<UnifiedWorkflowViewsState | null>(
    state.subjectKey === subjectKey ? state : null,
  );
  const [draft, setDraft] = useState<ViewDraft | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [hasConflict, setHasConflict] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);

  useEffect(() => {
    if (state.subjectKey === subjectKey) setCurrentState(state);
  }, [state, subjectKey]);

  useEffect(() => {
    setDraft(null);
    setBusyAction(null);
    setValidationError(null);
    setHasConflict(false);
    setManagerOpen(false);
  }, [subjectKey]);

  useLayoutEffect(() => {
    if (subjectKeyRef.current !== subjectKey) enteredSubjectKeyRef.current = null;
    subjectKeyRef.current = subjectKey;
    requestGenerationRef.current += 1;
    return () => {
      requestGenerationRef.current += 1;
    };
  }, [subjectKey]);

  const displayOverrides = useMemo(() => {
    const scoped = new Map<UnifiedWorkflowStage, StageDisplayOverride>();
    for (const display of stageDisplays) {
      if (display.subjectKey === subjectKey) scoped.set(display.stageId, display);
    }
    return scoped;
  }, [stageDisplays, subjectKey]);

  function stageName(stageId: UnifiedWorkflowStage) {
    const defaults = DEFAULT_STAGE_NAMES[stageId];
    const display = displayOverrides.get(stageId);
    return text(display?.zhName ?? defaults.zh, display?.enName ?? defaults.en);
  }

  function viewName(view: UnifiedWorkflowView) {
    return view.isSystem || view.id === SYSTEM_VIEW_ID
      ? text("全部流程", "All stages")
      : view.name;
  }

  function selectorViewName(view: UnifiedWorkflowView) {
    return view.isSystem || view.id === SYSTEM_VIEW_ID
      ? text("全部流程（系统）", "All stages (system)")
      : view.name;
  }

  function operationScope(): OperationScope {
    return { subjectKey, generation: requestGenerationRef.current };
  }

  function operationIsCurrent(operation: OperationScope) {
    return (
      operation.subjectKey === subjectKeyRef.current
      && operation.generation === requestGenerationRef.current
    );
  }

  function applyState(nextState: UnifiedWorkflowViewsState, operation: OperationScope) {
    if (
      !operationIsCurrent(operation)
      || nextState.subjectKey !== operation.subjectKey
    ) return false;
    setCurrentState(nextState);
    onChange(nextState);
    return true;
  }

  function reportFailure(error: unknown, operation: OperationScope) {
    if (!operationIsCurrent(operation)) return;
    if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
      setHasConflict(true);
      onError?.(text(
        "流程视图已在其他窗口修改，请重新加载后再试。",
        "Workflow views changed in another window. Reload before trying again.",
      ));
      return;
    }
    onError?.(errorMessage(
      error,
      text("无法更新流程视图", "Could not update workflow views"),
    ));
  }

  async function selectView(
    viewId: string,
    selectionState: UnifiedWorkflowViewsState | null = currentState,
  ) {
    if (!selectionState || busyAction) return;
    if (viewId === selectionState.activeViewId) return;
    const selected = selectionState.views.find((view) => (
      view.id === viewId && view.subjectKey === subjectKey
    ));
    if (!selected) return;

    if (selectionState.readOnly) {
      const nextState = { ...selectionState, activeViewId: selected.id };
      setCurrentState(nextState);
      onChange(nextState);
      return;
    }

    const operation = operationScope();
    const operationSubjectKey = operation.subjectKey;
    setBusyAction("select");
    setValidationError(null);
    setHasConflict(false);
    try {
      const nextState = await updateUnifiedWorkflowView(selected.id, {
        subjectKey: operationSubjectKey,
        stateRevision: selectionState.revision,
        activeViewId: selected.id,
      });
      applyState(nextState, operation);
    } catch (error) {
      reportFailure(error, operation);
    } finally {
      if (operationIsCurrent(operation)) setBusyAction(null);
    }
  }

  function beginCreate() {
    if (!currentState || currentState.readOnly || busyAction) return;
    setDraft({
      kind: "create",
      sourceViewId: null,
      name: "",
      stageIds: [],
    });
    setValidationError(null);
  }

  function beginCopy(view: UnifiedWorkflowView) {
    if (!currentState || currentState.readOnly || busyAction) return;
    setDraft({
      kind: "copy",
      sourceViewId: view.id,
      name: uniqueCopyName(viewName(view), text("副本", "copy"), currentState.views),
      stageIds: [...view.stageIds],
    });
    setValidationError(null);
  }

  function beginEdit(view: UnifiedWorkflowView) {
    if (!currentState || currentState.readOnly || view.isSystem || busyAction) return;
    setDraft({
      kind: "edit",
      sourceViewId: view.id,
      name: view.name,
      stageIds: [...view.stageIds],
    });
    setValidationError(null);
  }

  function toggleStage(stageId: UnifiedWorkflowStage, selected: boolean) {
    setDraft((current) => {
      if (!current) return current;
      const stageIds = selected
        ? current.stageIds.includes(stageId)
          ? current.stageIds
          : [...current.stageIds, stageId]
        : current.stageIds.filter((candidate) => candidate !== stageId);
      return { ...current, stageIds };
    });
    setValidationError(null);
  }

  function moveStage(stageId: UnifiedWorkflowStage, direction: -1 | 1) {
    setDraft((current) => {
      if (!current) return current;
      const index = current.stageIds.indexOf(stageId);
      const destination = index + direction;
      if (index < 0 || destination < 0 || destination >= current.stageIds.length) return current;
      const stageIds = [...current.stageIds];
      [stageIds[index], stageIds[destination]] = [stageIds[destination], stageIds[index]];
      return { ...current, stageIds };
    });
  }

  function validateDraft(viewsState: UnifiedWorkflowViewsState, value: ViewDraft) {
    const name = value.name.trim();
    if (!name) return text("请输入视图名称。", "Enter a view name.");
    if ([...name].length > MAX_VIEW_NAME_LENGTH) {
      return text("视图名称最多 64 个字符。", "View names can contain at most 64 characters.");
    }
    if (value.stageIds.length === 0) {
      return text("至少选择一个流程。", "Select at least one stage.");
    }
    const excludedViewId = value.kind === "edit" ? value.sourceViewId : null;
    const duplicate = viewsState.views.some((view) => (
      view.subjectKey === subjectKey
      && view.id !== excludedViewId
      && view.name.trim() === name
    ));
    if (duplicate) {
      return text("当前学科中已存在同名视图。", "A view with this name already exists in the current subject.");
    }
    return null;
  }

  async function saveDraft() {
    if (!currentState || !draft || currentState.readOnly || busyAction) return;
    const invalid = validateDraft(currentState, draft);
    if (invalid) {
      setValidationError(invalid);
      return;
    }

    const operation = operationScope();
    const operationSubjectKey = operation.subjectKey;
    setBusyAction("save");
    setValidationError(null);
    setHasConflict(false);
    try {
      if (draft.kind === "edit") {
        const sourceView = currentState.views.find((view) => (
          view.id === draft.sourceViewId && view.subjectKey === operationSubjectKey
        ));
        if (!sourceView || sourceView.isSystem) {
          setValidationError(text(
            "找不到要编辑的视图，请重新加载。",
            "The view being edited is unavailable. Reload and try again.",
          ));
          return;
        }
        const nextState = await updateUnifiedWorkflowView(sourceView.id, {
          subjectKey: operationSubjectKey,
          stateRevision: currentState.revision,
          viewRevision: sourceView.revision,
          name: draft.name.trim(),
          stageIds: draft.stageIds,
        });
        if (applyState(nextState, operation)) setDraft(null);
        return;
      }

      const previousIds = new Set(currentState.views.map((view) => view.id));
      const createdState = await createUnifiedWorkflowView({
        subjectKey: operationSubjectKey,
        name: draft.name.trim(),
        stageIds: draft.stageIds,
        stateRevision: currentState.revision,
      });
      if (!applyState(createdState, operation)) return;
      setDraft(null);

      const createdView = createdState.views.find((view) => (
        view.subjectKey === operationSubjectKey && !previousIds.has(view.id)
      ));
      if (!createdView) return;
      const activatedState = await updateUnifiedWorkflowView(createdView.id, {
        subjectKey: operationSubjectKey,
        stateRevision: createdState.revision,
        activeViewId: createdView.id,
      });
      applyState(activatedState, operation);
    } catch (error) {
      reportFailure(error, operation);
    } finally {
      if (operationIsCurrent(operation)) setBusyAction(null);
    }
  }

  async function setDefaultView(view: UnifiedWorkflowView) {
    if (!currentState || currentState.readOnly || busyAction) return;
    if (currentState.defaultViewId === view.id) return;
    const operation = operationScope();
    const operationSubjectKey = operation.subjectKey;
    setBusyAction("default");
    setValidationError(null);
    setHasConflict(false);
    try {
      const nextState = await updateUnifiedWorkflowView(view.id, {
        subjectKey: operationSubjectKey,
        stateRevision: currentState.revision,
        defaultViewId: view.id,
      });
      applyState(nextState, operation);
    } catch (error) {
      reportFailure(error, operation);
    } finally {
      if (operationIsCurrent(operation)) setBusyAction(null);
    }
  }

  async function removeView(view: UnifiedWorkflowView) {
    if (!currentState || currentState.readOnly || view.isSystem || busyAction) return;
    if (typeof window !== "undefined" && !window.confirm(text(
      `确认删除视图“${view.name}”吗？`,
      `Delete the view “${view.name}”?`,
    ))) return;

    const operation = operationScope();
    const operationSubjectKey = operation.subjectKey;
    setBusyAction("delete");
    setValidationError(null);
    setHasConflict(false);
    try {
      const nextState = await deleteUnifiedWorkflowView(
        view.id,
        operationSubjectKey,
        currentState.revision,
      );
      resetUnifiedWorkflowLayout(projectId, view.id);
      if (applyState(nextState, operation)) setDraft(null);
    } catch (error) {
      reportFailure(error, operation);
    } finally {
      if (operationIsCurrent(operation)) setBusyAction(null);
    }
  }

  async function reloadViews() {
    if (busyAction) return;
    const operation = operationScope();
    const operationSubjectKey = operation.subjectKey;
    setBusyAction("reload");
    try {
      const nextState = await getUnifiedWorkflowViews(operationSubjectKey);
      if (applyState(nextState, operation)) {
        setDraft(null);
        setValidationError(null);
        setHasConflict(false);
      }
    } catch (error) {
      if (operationIsCurrent(operation)) {
        onError?.(errorMessage(
          error,
          text("无法重新加载流程视图", "Could not reload workflow views"),
        ));
      }
    } finally {
      if (operationIsCurrent(operation)) setBusyAction(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || !currentState || currentState.subjectKey !== subjectKey) return;
      if (enteredSubjectKeyRef.current === subjectKey) return;
      enteredSubjectKeyRef.current = subjectKey;
      const defaultView = currentState.views.find((view) => (
        view.subjectKey === subjectKey && view.id === currentState.defaultViewId
      ));
      if (!defaultView || defaultView.id === currentState.activeViewId) return;
      void selectView(defaultView.id);
    });
    return () => {
      cancelled = true;
    };
  }, [currentState, subjectKey]);

  if (!currentState || currentState.subjectKey !== subjectKey) {
    return (
      <section
        className="unified-view-controls"
        aria-label={text("当前学科流程视图", "Current subject workflow views")}
      >
        <p role="alert">
          {text(
            "当前学科的视图数据尚未加载。",
            "View data for the current subject has not loaded.",
          )}
        </p>
      </section>
    );
  }

  const subjectViews = currentState.views.filter((view) => view.subjectKey === subjectKey);
  const activeView = subjectViews.find((view) => (
    view.id === currentState.activeViewId && view.subjectKey === subjectKey
  )) ?? subjectViews.find((view) => view.id === SYSTEM_VIEW_ID);
  const readOnly = currentState.readOnly;
  const selectorHelpId = `${instanceId}-view-selector-help`;
  const managerId = `${instanceId}-view-manager`;
  const draftHelpId = `${instanceId}-view-draft-help`;
  const draftErrorId = `${instanceId}-view-draft-error`;

  return (
    <section
      className="unified-view-controls"
      aria-label={text("当前学科流程视图", "Current subject workflow views")}
    >
      <div className="unified-view-controls-toolbar">
        <label htmlFor={`${instanceId}-view-selector`}>
          {text("流程看板", "Workflow view")}
        </label>
        <select
          id={`${instanceId}-view-selector`}
          value={activeView?.id ?? SYSTEM_VIEW_ID}
          disabled={Boolean(busyAction)}
          aria-describedby={selectorHelpId}
          onChange={(event) => void selectView(event.target.value)}
        >
          {subjectViews.map((view) => (
              <option key={view.id} value={view.id}>
                {selectorViewName(view)}
                {view.id === currentState.defaultViewId ? text("（默认）", " (default)") : ""}
              </option>
            ))}
        </select>
        <small id={selectorHelpId}>
          {readOnly
            ? text(
                "可切换查看该学科的历史视图，不会修改保存的数据。",
                "You can inspect this subject's historical views without changing saved data.",
              )
            : text(
                "切换只影响当前学科；默认视图会在下次进入时打开。",
                "Selection applies only to the current subject. Its default opens next time.",
              )}
        </small>

        <div className="unified-view-controls-actions">
          <button
            type="button"
            disabled={readOnly || Boolean(busyAction)}
            aria-label={text("新建视图", "New view")}
            onClick={beginCreate}
          >
            <LinearIcon name="plus" aria-hidden="true" />
            <span>{text("新建视图", "New view")}</span>
          </button>
          <button
            type="button"
            disabled={Boolean(busyAction)}
            aria-label={text("管理视图", "Manage views")}
            aria-expanded={managerOpen}
            aria-controls={managerId}
            onClick={() => setManagerOpen((open) => !open)}
          >
            <LinearIcon name="displayOptions" aria-hidden="true" />
            <span>{text("管理视图", "Manage views")}</span>
          </button>
        </div>
      </div>

      {readOnly && (
        <p className="unified-view-controls-read-only" role="status">
          {text(
            "该学科已移除，流程视图仅供查看。",
            "This subject was removed, so its workflow views are read-only.",
          )}
        </p>
      )}

      {activeView?.isSystem && (
        <p className="unified-view-controls-system-note">
          {text(
            "“全部流程”是受保护的系统视图，不能编辑或删除。",
            "“All stages” is a protected system view and cannot be edited or deleted.",
          )}
        </p>
      )}

      {hasConflict && (
        <div className="unified-view-controls-conflict" role="alert">
          <span>
            {text(
              "流程视图已在其他窗口修改。重新加载最新内容后再继续。",
              "Workflow views changed in another window. Reload the latest version to continue.",
            )}
          </span>
          <button
            type="button"
            disabled={Boolean(busyAction)}
            aria-label={text("重新加载流程视图", "Reload workflow views")}
            onClick={() => void reloadViews()}
          >
            <LinearIcon name="recurrence" aria-hidden="true" />
            <span>{text("重新加载", "Reload")}</span>
          </button>
        </div>
      )}

      {managerOpen && (
        <div
          id={managerId}
          className="unified-view-editor unified-view-manager"
          aria-label={text("管理流程视图", "Manage workflow views")}
        >
          <header>
            <h3>{text("管理视图", "Manage views")}</h3>
          </header>
          <div className="unified-view-manager-list">
            {subjectViews.map((view) => (
              <div className="unified-view-manager-item" key={view.id}>
                <div>
                  <strong>{selectorViewName(view)}</strong>
                  {view.id === currentState.activeViewId && (
                    <small>{text("当前", "Active")}</small>
                  )}
                  {view.id === currentState.defaultViewId && (
                    <small>{text("默认", "Default")}</small>
                  )}
                </div>
                <div className="unified-view-controls-actions">
                  <button
                    type="button"
                    disabled={view.id === currentState.activeViewId || Boolean(busyAction)}
                    aria-label={text(
                      `${readOnly ? "查看" : "启用"}视图 ${viewName(view)}`,
                      `${readOnly ? "Inspect" : "Activate"} view ${viewName(view)}`,
                    )}
                    onClick={() => void selectView(view.id)}
                  >
                    <LinearIcon name="check" aria-hidden="true" />
                    <span>{readOnly ? text("查看", "Inspect") : text("启用", "Activate")}</span>
                  </button>
                  <button
                    type="button"
                    disabled={readOnly || Boolean(busyAction)}
                    aria-label={text(
                      `复制视图 ${viewName(view)}`,
                      `Copy view ${viewName(view)}`,
                    )}
                    onClick={() => beginCopy(view)}
                  >
                    <LinearIcon name="copy" aria-hidden="true" />
                    <span>{text("复制", "Copy")}</span>
                  </button>
                  <button
                    type="button"
                    disabled={readOnly || view.isSystem || Boolean(busyAction)}
                    aria-label={text(
                      `编辑视图 ${viewName(view)}`,
                      `Edit view ${viewName(view)}`,
                    )}
                    onClick={() => beginEdit(view)}
                  >
                    <LinearIcon name="write" aria-hidden="true" />
                    <span>{text("编辑", "Edit")}</span>
                  </button>
                  <button
                    type="button"
                    disabled={readOnly || view.id === currentState.defaultViewId || Boolean(busyAction)}
                    aria-label={text(
                      `将视图 ${viewName(view)} 设为默认`,
                      `Set view ${viewName(view)} as default`,
                    )}
                    onClick={() => void setDefaultView(view)}
                  >
                    <LinearIcon name="favorite" aria-hidden="true" />
                    <span>{text("设为默认", "Set as default")}</span>
                  </button>
                  <button
                    type="button"
                    disabled={readOnly || view.isSystem || Boolean(busyAction)}
                    aria-label={text(
                      `删除视图 ${viewName(view)}`,
                      `Delete view ${viewName(view)}`,
                    )}
                    onClick={() => void removeView(view)}
                  >
                    <LinearIcon name="trash" aria-hidden="true" />
                    <span>{text("删除", "Delete")}</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="unified-view-editor-actions">
            <button
              type="button"
              disabled={Boolean(busyAction)}
              aria-label={text("关闭视图管理", "Close view manager")}
              onClick={() => setManagerOpen(false)}
            >
              <LinearIcon name="close" aria-hidden="true" />
              <span>{text("关闭", "Close")}</span>
            </button>
          </div>
        </div>
      )}

      {draft && !readOnly && (
        <div
          className="unified-view-editor"
          aria-label={text("流程视图编辑器", "Workflow view editor")}
        >
          <header>
            <h3>
              {draft.kind === "create"
                ? text("新建视图", "New view")
                : draft.kind === "copy"
                  ? text("复制视图", "Copy view")
                  : text("编辑视图", "Edit view")}
            </h3>
          </header>

          <label htmlFor={`${instanceId}-view-name`}>
            <span>{text("视图名称", "View name")}</span>
            <input
              id={`${instanceId}-view-name`}
              value={draft.name}
              maxLength={MAX_VIEW_NAME_LENGTH}
              disabled={Boolean(busyAction)}
              aria-describedby={`${draftHelpId}${validationError ? ` ${draftErrorId}` : ""}`}
              onChange={(event) => {
                setDraft((current) => current ? { ...current, name: event.target.value } : current);
                setValidationError(null);
              }}
            />
          </label>
          <small id={draftHelpId}>
            {text(
              "名称在当前学科内不能重复，最多 64 个字符。",
              "Names must be unique in the current subject and can contain up to 64 characters.",
            )}
          </small>

          <fieldset disabled={Boolean(busyAction)}>
            <legend>{text("选择流程", "Choose stages")}</legend>
            <p>{text("至少选择一个流程。", "Select at least one stage.")}</p>
            <div className="unified-view-stage-options">
              {STAGES.map((stageId) => (
                <label key={stageId}>
                  <input
                    type="checkbox"
                    checked={draft.stageIds.includes(stageId)}
                    onChange={(event) => toggleStage(stageId, event.target.checked)}
                  />
                  <span>{stageName(stageId)}</span>
                  <code>{stageId}</code>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="unified-view-stage-order">
            <h4>{text("流程顺序", "Stage order")}</h4>
            {draft.stageIds.length === 0 ? (
              <p>{text("选择流程后可在这里调整顺序。", "Select stages to arrange their order here.")}</p>
            ) : (
              <ol aria-label={text("已选流程顺序", "Selected stage order")}>
                {draft.stageIds.map((stageId, index) => (
                  <li key={stageId}>
                    <span>{stageName(stageId)}</span>
                    <code>{stageId}</code>
                    <button
                      type="button"
                      disabled={Boolean(busyAction) || index === 0}
                      title={text("上移", "Move up")}
                      aria-label={text(`上移 ${stageName(stageId)}`, `Move ${stageName(stageId)} up`)}
                      onClick={() => moveStage(stageId, -1)}
                    >
                      <LinearIcon
                        name="chevronLeft"
                        aria-hidden="true"
                        style={{ transform: "rotate(90deg)" }}
                      />
                    </button>
                    <button
                      type="button"
                      disabled={Boolean(busyAction) || index === draft.stageIds.length - 1}
                      title={text("下移", "Move down")}
                      aria-label={text(`下移 ${stageName(stageId)}`, `Move ${stageName(stageId)} down`)}
                      onClick={() => moveStage(stageId, 1)}
                    >
                      <LinearIcon
                        name="chevronRight"
                        aria-hidden="true"
                        style={{ transform: "rotate(90deg)" }}
                      />
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>

          {validationError && (
            <p id={draftErrorId} className="unified-view-editor-error" role="alert">
              {validationError}
            </p>
          )}

          <div className="unified-view-editor-actions">
            <button
              type="button"
              disabled={Boolean(busyAction)}
              aria-label={text("保存流程视图", "Save workflow view")}
              onClick={() => void saveDraft()}
            >
              <LinearIcon name="check" aria-hidden="true" />
              <span>{text("保存", "Save")}</span>
            </button>
            <button
              type="button"
              disabled={Boolean(busyAction)}
              aria-label={text("取消编辑", "Cancel editing")}
              onClick={() => {
                setDraft(null);
                setValidationError(null);
              }}
            >
              <LinearIcon name="close" aria-hidden="true" />
              <span>{text("取消", "Cancel")}</span>
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export default UnifiedWorkflowViewControls;
