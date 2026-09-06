import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type {
  FeishuBaseCatalog,
  FeishuFieldMetadata,
  FeishuPackageSummary,
  FeishuStageConfig,
  FeishuStageConfigMap,
  FeishuStageId,
  FeishuSubjectConfig,
  FeishuWorkflowShareDiagnostic,
} from "../types";
import { FeishuStageEditor, type FeishuStageValue } from "./FeishuStageEditor";
import {
  addFeishuBaseFromUrl,
  exportFeishuWorkflowShare,
  importFeishuWorkflowShare,
  saveFeishuWorkflowDraft,
  setFeishuSubjectDisabled,
  setFeishuSubjectDisplay,
  setFeishuSubjectEnabled,
} from "../feishuWorkflow";
import { listFeishuPackages } from "../api";

export interface FeishuWorkflowPanelProps {
  catalog: FeishuBaseCatalog[];
  configurationBaseToken: string | null;
  selectedSubjectKey: string | null;
  /** Select a subject; the second flag controls whether to open its task board. */
  onSelectSubject: (subjectKey: string, openProject?: boolean) => void;
  onCatalogChange: (catalog: FeishuBaseCatalog[]) => void;
  onSubjectChange: (subject: FeishuSubjectConfig) => void;
  /** Optional orchestration hooks used by hosts that own persistence. */
  onAddBase?: (url: string) => Promise<FeishuBaseCatalog | void> | void;
  onSaveDraft?: (subjectKey: string, patch: unknown) => Promise<FeishuSubjectConfig> | void;
  onEnable?: (subject: FeishuSubjectConfig) => Promise<FeishuSubjectConfig> | void;
  onDisable?: (subject: FeishuSubjectConfig) => Promise<FeishuSubjectConfig> | void;
  onToggleDisplay?: (subject: FeishuSubjectConfig, displayEnabled: boolean) => Promise<FeishuSubjectConfig> | void;
  onShareImported?: (catalog: FeishuBaseCatalog[]) => void;
  compact?: boolean;
  onOpenConfiguration?: () => void;
  onError?: (message: string) => void;
}

function statusLabel(subject: FeishuSubjectConfig): string {
  return subject.lifecycle === "enabled" ? "已启用" : subject.lifecycle === "draft" ? "草稿" : "已停用";
}

const PHASE_IDS: FeishuStageId[] = ["initial", "first_review", "final_review"];
const PHASE_LABELS: Record<FeishuStageId, string> = {
  initial: "初稿",
  first_review: "初审修改",
  final_review: "终审修改",
};

function fieldIdOf(field: FeishuFieldMetadata | undefined): string {
  return field?.fieldId ?? "";
}

function fieldNameOf(field: FeishuFieldMetadata | undefined): string {
  return field?.fieldName ?? "";
}

function stageDefaults(subject: FeishuSubjectConfig, fields: FeishuFieldMetadata[]): FeishuStageConfigMap {
  const status = subject.statusField;
  const statusField = fields.find((field) => field.fieldId === status?.fieldId)
    ?? fields.find((field) => String(field.uiType ?? field.type ?? "").toLowerCase().replace(/[\s_-]/gu, "") === "singleselect");
  const options = statusField?.options ?? [];
  const existing = subject.stages;
  return Object.fromEntries(PHASE_IDS.map((stageId, index) => {
    const option = options[index] ?? options[0];
    const old = existing?.[stageId];
    const fallback: FeishuStageConfig = {
      enabled: index === 0,
      trigger: {
        fieldId: statusField?.fieldId ?? subject.trigger?.fieldId ?? null,
        fieldName: statusField?.fieldName ?? subject.trigger?.fieldName ?? null,
        optionId: option?.id ?? (index === 0 ? subject.trigger?.optionId ?? null : null),
        value: option?.name ?? (index === 0 ? subject.trigger?.startValue ?? "" : ""),
      },
      videoSource: { kind: "docx_section", anchorText: "录屏" },
      reviewSource: { kind: "docx_section", anchorText: "修改意见" },
      audio: { mode: "video_original" },
      artifactTargetPath: null,
      nameSuffix: `_${PHASE_LABELS[stageId]}`,
    };
    return [stageId, old ? structuredClone(old) : fallback];
  })) as FeishuStageConfigMap;
}

type SubjectForm = {
  triggerFieldId: string;
  triggerFieldName: string;
  startValue: string;
  optionId: string | null;
  titleFieldId: string;
  titleFieldName: string;
  executionMode: "manual" | "automatic";
  concurrencyGroup: string;
  maxConcurrent: string;
  resourceGroups: string;
  packageAlias: string;
  artifactSourceMode: "manual_select" | "watch_directory" | "driver_report";
  artifactSourcePath: string;
  enqueueMode: "manual" | "automatic";
  targetId: string;
  targetPath: string;
  uploadConcurrency: string;
  statusFieldId: string;
  statusFieldName: string;
  documentFieldId: string;
  documentFieldName: string;
  namingFieldId: string;
  namingFieldName: string;
  stages: FeishuStageConfigMap | null;
};

function formForSubject(subject: FeishuSubjectConfig): SubjectForm {
  const fields = subject.metadata?.fields ?? [];
  const statusField = subject.statusField;
  const documentField = subject.documentField;
  const namingField = subject.namingField;
  return {
    triggerFieldId: subject.trigger?.fieldId ?? "",
    triggerFieldName: subject.trigger?.fieldName ?? "",
    startValue: subject.trigger?.startValue ?? "",
    optionId: subject.trigger?.optionId ?? null,
    titleFieldId: subject.title?.fieldId ?? "",
    titleFieldName: subject.title?.fieldName ?? "",
    executionMode: subject.execution?.mode ?? "manual",
    concurrencyGroup: subject.execution?.concurrencyGroup ?? "default",
    maxConcurrent: String(subject.execution?.maxConcurrent ?? 1),
    resourceGroups: subject.execution?.resourceGroups.join(", ") ?? "",
    packageAlias: subject.packageRoute?.packageAlias ?? "",
    artifactSourceMode: (subject.upload?.artifactSourceMode as SubjectForm["artifactSourceMode"]) ?? "manual_select",
    artifactSourcePath: subject.upload?.artifactSourcePath ?? "",
    enqueueMode: subject.upload?.enqueueMode ?? "manual",
    targetId: subject.upload?.targetId ?? "",
    targetPath: subject.upload?.targetPath ?? "",
    uploadConcurrency: String(subject.upload?.uploadConcurrency ?? 1),
    statusFieldId: statusField?.fieldId ?? "",
    statusFieldName: statusField?.fieldName ?? "",
    documentFieldId: documentField?.fieldId ?? "",
    documentFieldName: documentField?.fieldName ?? "",
    namingFieldId: namingField?.fieldId ?? "",
    namingFieldName: namingField?.fieldName ?? "",
    stages: subject.stages || (statusField || documentField || namingField ? stageDefaults(subject, fields) : null),
  };
}

function resourceGroupsFrom(value: string): string[] {
  return [...new Set(value.split(/[,，\n]/u).map((entry) => entry.trim()).filter(Boolean))];
}

function shareImportConfirmation(diagnostics: FeishuWorkflowShareDiagnostic[]): string {
  const warnings = diagnostics.filter((entry) => entry.severity !== "info");
  if (warnings.length === 0) {
    return "共享配置校验通过，导入后所有子表仍保持草稿状态。继续吗？";
  }
  const details = warnings.slice(0, 8).map((entry) => {
    const severity = entry.severity === "error" ? "错误" : "警告";
    return `- ${severity} [${entry.code}] ${entry.message}`;
  });
  if (warnings.length > details.length) {
    details.push(`- 还有 ${warnings.length - details.length} 项未显示`);
  }
  return `共享配置校验发现 ${warnings.length} 个需要确认的问题：\n\n${details.join("\n")}\n\n仍要导入为草稿吗？`;
}

export function FeishuWorkflowPanel({
  catalog,
  configurationBaseToken,
  selectedSubjectKey,
  onSelectSubject,
  onCatalogChange,
  onSubjectChange,
  onAddBase,
  onSaveDraft,
  onEnable,
  onDisable,
  onToggleDisplay,
  onShareImported,
  compact = false,
  onOpenConfiguration,
  onError,
}: FeishuWorkflowPanelProps) {
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [packageOptions, setPackageOptions] = useState<FeishuPackageSummary[] | null>(null);
  const shareFileRef = useRef<HTMLInputElement | null>(null);
  const preserveDirtyFormForSubjectRef = useRef<string | null>(null);
  const scopedCatalog = useMemo(() => (
    configurationBaseToken
      ? catalog.filter((base) => base.baseToken === configurationBaseToken)
      : catalog.slice(0, 1)
  ), [catalog, configurationBaseToken]);
  const selected = useMemo(() => scopedCatalog
    .flatMap((base) => base.subjects)
    .find((subject) => subject.subjectKey === selectedSubjectKey)
    ?? scopedCatalog.flatMap((base) => base.subjects)[0]
    ?? null, [scopedCatalog, selectedSubjectKey]);
  const [subjectForm, setSubjectForm] = useState<SubjectForm | null>(() => selected ? formForSubject(selected) : null);
  const subjectFormDirty = Boolean(selected && subjectForm
    && JSON.stringify(subjectForm) !== JSON.stringify(formForSubject(selected)));
  const selectedPackage = packageOptions?.find((item) => item.alias === subjectForm?.packageAlias);
  const visibleSubjects = (base: FeishuBaseCatalog) => base.subjects.filter((subject) => subject.displayEnabled);
  const hiddenSubjects = (base: FeishuBaseCatalog) => base.subjects.filter((subject) => !subject.displayEnabled);
  const triggerFields = selected ? selected.metadata?.fields ?? [] : [];
  const phased = Boolean(subjectForm?.stages);
  const selectedStatusField = subjectForm
    ? triggerFields.find((field) => field.fieldId === subjectForm.statusFieldId)
    : undefined;
  const statusOptions = selectedStatusField?.options ?? [];
  const metadataFieldOptions = triggerFields;
  const phasedValidationErrors = useMemo(() => {
    if (!subjectForm?.stages) return [];
    const errors: string[] = [];
    const enabledStages = PHASE_IDS.filter((stageId) => subjectForm.stages?.[stageId]?.enabled);
    if (enabledStages.length === 0) errors.push("至少启用一个阶段");
    const optionIds = enabledStages
      .map((stageId) => subjectForm.stages?.[stageId]?.trigger.optionId)
      .filter((value): value is string => Boolean(value));
    if (new Set(optionIds).size !== optionIds.length) errors.push("已启用阶段的触发选项不能重复");
    for (const stageId of PHASE_IDS) {
      const stage = subjectForm.stages[stageId];
      if (!stage) continue;
      const phaseLabel = PHASE_LABELS[stageId];
      if (stage.enabled && (!stage.trigger.optionId || !stage.trigger.value)) errors.push(`${phaseLabel}需要触发选项`);
      if (stage.videoSource.kind === "docx_section" && !stage.videoSource.anchorText?.trim()) errors.push(`${phaseLabel}需要视频目录标题`);
      if (stage.videoSource.kind === "base_attachment" && !stage.videoSource.fieldId) errors.push(`${phaseLabel}需要视频附件字段`);
      if (!stage.reviewSource.anchorText?.trim()) errors.push(`${phaseLabel}需要剪辑意见目录标题`);
      if (stage.audio.mode === "replace_original" && !stage.audio.source?.fieldId && !stage.audio.source?.anchorText) errors.push(`${phaseLabel}需要外部音频来源`);
      if (stage.audio.mode === "replace_original" && (!(stage.audio.durationToleranceSeconds ?? 0) || (stage.audio.durationToleranceSeconds ?? 0) <= 0)) errors.push(`${phaseLabel}的时长误差必须为正数`);
      if (!stage.nameSuffix.trim()) errors.push(`${phaseLabel}需要命名后缀`);
      if (subjectForm.enqueueMode === "automatic" && !stage.artifactTargetPath?.trim()) errors.push(`${phaseLabel}需要 ZIP 目标目录`);
    }
    if (!subjectForm.statusFieldId) errors.push("请选择状态字段");
    if (!subjectForm.documentFieldId) errors.push("请选择素材文档字段");
    if (!subjectForm.namingFieldId) errors.push("请选择命名字段");
    return [...new Set(errors)];
  }, [subjectForm]);
  const enableBlockedReason = subjectFormDirty
    ? "请先保存草稿"
    : packageOptions === null
      ? "正在加载 Auto-Cut 包"
      : !subjectForm?.packageAlias
        ? "请选择 Auto-Cut 包"
        : !selectedPackage
          ? "当前包不存在，请重新选择"
          : selectedPackage.state !== "enabled"
            ? "只能启用已启用状态的 Auto-Cut 包"
            : subjectForm.artifactSourceMode === "watch_directory"
              ? "该 ZIP 获取方式将在后续开放"
              : subjectForm.artifactSourceMode === "driver_report" && !subjectForm.artifactSourcePath.trim()
                ? "请填写 ZIP 来源根目录"
                : phased && phasedValidationErrors.length > 0
                  ? phasedValidationErrors[0]
                : undefined;
  const selectedTriggerField = subjectForm
    ? triggerFields.find((field) => field.fieldId === subjectForm.triggerFieldId)
    : undefined;
  const startValueOptions = selectedTriggerField?.options ?? [];
  const hasConfiguredTriggerField = subjectForm
    ? triggerFields.some((field) => field.fieldId === subjectForm.triggerFieldId)
    : false;
  const hasConfiguredTitleField = subjectForm
    ? triggerFields.some((field) => field.fieldId === subjectForm.titleFieldId)
    : false;
  const configuredStartValueOption = subjectForm
    ? startValueOptions.find((option) => (
      option.id === subjectForm.optionId && option.name === subjectForm.startValue
    ))
    : undefined;
  const startValueSelectValue = configuredStartValueOption
    ? `option:${configuredStartValueOption.id}`
    : `existing:${subjectForm?.optionId ?? ""}:${subjectForm?.startValue ?? ""}`;

  useEffect(() => {
    if (selected && preserveDirtyFormForSubjectRef.current === selected.subjectKey) {
      preserveDirtyFormForSubjectRef.current = null;
      return;
    }
    preserveDirtyFormForSubjectRef.current = null;
    setSubjectForm(selected ? formForSubject(selected) : null);
  }, [selected?.subjectKey, selected?.configVersion]);

  useEffect(() => {
    let active = true;
    void listFeishuPackages()
      .then((packages) => { if (active) setPackageOptions(packages); })
      .catch((error) => {
        if (active) {
          setPackageOptions([]);
          onError?.(error instanceof Error ? error.message : "无法加载 Auto-Cut 包");
        }
      });
    return () => { active = false; };
  }, []);

  function selectTriggerField(fieldId: string) {
    if (!subjectForm) return;
    const field = triggerFields.find((candidate) => candidate.fieldId === fieldId);
    if (!field) return;
    const options = field.options ?? [];
    const option = options.find((candidate) => candidate.id === subjectForm.optionId)
      ?? options.find((candidate) => candidate.name === subjectForm.startValue)
      ?? options[0]
      ?? null;
    setSubjectForm({
      ...subjectForm,
      triggerFieldId: field.fieldId,
      triggerFieldName: field.fieldName,
      startValue: option?.name ?? subjectForm.startValue,
      optionId: option?.id ?? null,
    });
  }

  function selectStartValue(value: string) {
    if (!subjectForm || !value.startsWith("option:")) return;
    const option = startValueOptions.find((candidate) => candidate.id === value.slice("option:".length));
    if (!option) return;
    setSubjectForm({ ...subjectForm, startValue: option.name, optionId: option.id });
  }

  function selectTitleField(fieldId: string) {
    if (!subjectForm) return;
    const field = triggerFields.find((candidate) => candidate.fieldId === fieldId);
    setSubjectForm({
      ...subjectForm,
      titleFieldId: field?.fieldId ?? "",
      titleFieldName: field?.fieldName ?? "",
    });
  }

  function selectPhasedField(kind: "status" | "document" | "naming", fieldId: string) {
    if (!subjectForm) return;
    const field = triggerFields.find((candidate) => candidate.fieldId === fieldId);
    if (!field) return;
    if (kind === "status") {
      const option = field.options?.[0] ?? null;
      const stages = subjectForm.stages
        ? Object.fromEntries(PHASE_IDS.map((stageId, index) => {
          const current = subjectForm.stages?.[stageId];
          return [stageId, current ? {
            ...current,
            trigger: {
              ...current.trigger,
              fieldId: field.fieldId,
              fieldName: field.fieldName,
              ...(current.trigger.optionId && field.options?.some((candidate) => candidate.id === current.trigger.optionId)
                ? {}
                : { optionId: field.options?.[index]?.id ?? option?.id ?? null, value: field.options?.[index]?.name ?? option?.name ?? "" }),
            },
          } : current];
        })) as FeishuStageConfigMap
        : null;
      setSubjectForm({ ...subjectForm, statusFieldId: field.fieldId, statusFieldName: field.fieldName, stages });
      return;
    }
    setSubjectForm({
      ...subjectForm,
      ...(kind === "document"
        ? { documentFieldId: field.fieldId, documentFieldName: field.fieldName }
        : { namingFieldId: field.fieldId, namingFieldName: field.fieldName }),
    });
  }

  function updateStage(stageId: FeishuStageId, value: FeishuStageValue) {
    if (!subjectForm?.stages) return;
    setSubjectForm({
      ...subjectForm,
      stages: { ...subjectForm.stages, [stageId]: value as FeishuStageConfig },
    });
  }

  async function addBase() {
    if (!baseUrl.trim()) return;
    setBusy(true);
    try {
      const next = await (onAddBase ? onAddBase(baseUrl.trim()) : addFeishuBaseFromUrl(baseUrl.trim()));
      if (!next) return;
      onCatalogChange([...catalog.filter((base) => base.baseToken !== next.baseToken), next]);
      setBaseUrl("");
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "无法读取多维表格");
    } finally { setBusy(false); }
  }

  async function saveDraft() {
    if (!selected || !subjectForm) return;
    setBusy(true);
    try {
      const patch = {
        expectedVersion: selected.configVersion,
        trigger: {
          ...selected.trigger,
          fieldId: subjectForm.triggerFieldId,
          fieldName: subjectForm.triggerFieldName,
          startValue: subjectForm.startValue,
          optionId: subjectForm.optionId,
        },
        title: {
          fieldId: subjectForm.titleFieldId || null,
          fieldName: subjectForm.titleFieldName || null,
        },
        execution: {
          ...selected.execution,
          mode: subjectForm.executionMode,
          concurrencyGroup: subjectForm.concurrencyGroup,
          maxConcurrent: Number(subjectForm.maxConcurrent),
          resourceGroups: resourceGroupsFrom(subjectForm.resourceGroups),
        },
        packageRoute: {
          ...selected.packageRoute,
          packageAlias: subjectForm.packageAlias,
        },
        upload: {
          ...selected.upload,
          artifactSourceMode: subjectForm.artifactSourceMode,
          artifactSourcePath: subjectForm.artifactSourceMode === "manual_select"
            ? null
            : subjectForm.artifactSourcePath || null,
          enqueueMode: subjectForm.enqueueMode,
          targetId: subjectForm.targetId || null,
          targetPath: subjectForm.targetPath || null,
          uploadConcurrency: Number(subjectForm.uploadConcurrency),
        },
        ...(subjectForm.stages ? {
          statusField: { fieldId: subjectForm.statusFieldId || null, fieldName: subjectForm.statusFieldName || null },
          documentField: { fieldId: subjectForm.documentFieldId || null, fieldName: subjectForm.documentFieldName || null },
          namingField: { fieldId: subjectForm.namingFieldId || null, fieldName: subjectForm.namingFieldName || null },
          stages: subjectForm.stages,
        } : {}),
      };
      const subject = await (onSaveDraft ? onSaveDraft(selected.subjectKey, patch) : saveFeishuWorkflowDraft(selected.subjectKey, patch));
      if (subject) onSubjectChange(subject);
    }
    catch (error) { onError?.(error instanceof Error ? error.message : "无法保存草稿"); }
    finally { setBusy(false); }
  }

  async function transition(action: "enable" | "disable") {
    if (!selected) return;
    const preserveDirtyForm = action === "disable" && subjectFormDirty;
    setBusy(true);
    try {
      const subject = await (action === "enable"
        ? (onEnable ? onEnable(selected) : setFeishuSubjectEnabled(selected))
        : (onDisable ? onDisable(selected) : setFeishuSubjectDisabled(selected)));
      if (subject) {
        if (preserveDirtyForm) preserveDirtyFormForSubjectRef.current = subject.subjectKey;
        onSubjectChange(subject);
      }
    }
    catch (error) { onError?.(error instanceof Error ? error.message : "无法更新状态"); }
    finally { setBusy(false); }
  }

  async function toggleDisplay(subject: FeishuSubjectConfig, displayEnabled: boolean) {
    setBusy(true);
    try {
      const next = await (onToggleDisplay
        ? onToggleDisplay(subject, displayEnabled)
        : setFeishuSubjectDisplay(subject, displayEnabled));
      if (next) onSubjectChange(next);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "无法更新显示设置");
    } finally { setBusy(false); }
  }

  async function exportShare() {
    setBusy(true);
    try {
      const configuration = await exportFeishuWorkflowShare();
      const blob = new Blob([`${JSON.stringify(configuration, null, 2)}\n`], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = "feishu-workflow-share.json";
      link.click();
      URL.revokeObjectURL(href);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "无法导出共享配置");
    } finally { setBusy(false); }
  }

  async function importShare(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      const configuration = JSON.parse(await file.text());
      const preview = await importFeishuWorkflowShare(configuration, true);
      const summary = shareImportConfirmation(preview.diagnostics);
      if (typeof window !== "undefined" && !window.confirm(summary)) return;
      const imported = await importFeishuWorkflowShare(configuration, false);
      if (imported.catalog) {
        onCatalogChange(imported.catalog);
        onShareImported?.(imported.catalog);
      }
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "无法导入共享配置");
    } finally { setBusy(false); }
  }

  return <section className={`feishu-workflow-panel${compact ? " is-compact" : ""}`} aria-label="飞书多维表格工作流">
    <div className="feishu-workflow-add">
      {!compact && <>
        <input aria-label="多维表格链接" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="粘贴多维表格链接" />
        <button type="button" onClick={() => void addBase()} disabled={busy || !baseUrl.trim()}>新增多维表格</button>
        <button type="button" onClick={() => void exportShare()} disabled={busy}>导出共享配置</button>
        <button type="button" onClick={() => shareFileRef.current?.click()} disabled={busy}>导入共享配置</button>
        <input ref={shareFileRef} type="file" accept="application/json,.json" onChange={(event) => void importShare(event)} hidden />
      </>}
      {compact && <>
        <strong className="feishu-workflow-current-label">{selected ? `${selected.baseName} / ${selected.tableName}` : "选择学科"}</strong>
        <button type="button" onClick={onOpenConfiguration}>配置多维表格</button>
      </>}
    </div>
    <div className="feishu-workflow-catalog">
      {scopedCatalog.map((base) => <div className="feishu-base" key={base.baseToken}>
        <h3>{base.baseName}</h3>
        <h4>已显示子表</h4>
        {visibleSubjects(base).map((subject) => <div className="feishu-subject-row" key={subject.subjectKey}>
          <button
            type="button"
            className={subject.subjectKey === selectedSubjectKey ? "active" : ""}
            onClick={() => onSelectSubject(subject.subjectKey, true)}
          >{subject.tableName}<span>{statusLabel(subject)}</span></button>
          <button type="button" disabled={busy} onClick={() => void toggleDisplay(subject, false)}>隐藏</button>
        </div>)}
        {!compact && <>
          <h4>未显示子表</h4>
          {hiddenSubjects(base).map((subject) => <div className="feishu-subject-row" key={subject.subjectKey}>
            <button
              type="button"
              className={subject.subjectKey === selectedSubjectKey ? "active" : ""}
              onClick={() => onSelectSubject(subject.subjectKey, false)}
            >{subject.tableName}<span>{statusLabel(subject)}</span></button>
            <button type="button" disabled={busy} onClick={() => void toggleDisplay(subject, true)}>显示</button>
          </div>)}
        </>}
      </div>)}
    </div>
    {!compact && selected && subjectForm && <form className="feishu-subject-settings" onSubmit={(event) => { event.preventDefault(); void saveDraft(); }}>
      <header className="feishu-subject-settings-header">
        <div>
          <h3>{selected.baseName} / {selected.tableName}</h3>
          <span data-lifecycle={selected.lifecycle}>{statusLabel(selected)}</span>
        </div>
        <small>配置版本 {selected.configVersion}</small>
      </header>
      {phased && subjectForm.stages && <section className="feishu-phased-settings" aria-label="分阶段素材配置">
        <fieldset disabled={busy}>
          <legend>字段来源</legend>
          <div className="feishu-settings-grid">
            <label>
              <span>状态字段</span>
              <select
                aria-label="状态字段"
                value={subjectForm.statusFieldId}
                onChange={(event) => selectPhasedField("status", event.target.value)}
              >
                <option value="">选择单选状态字段</option>
                {triggerFields.filter((field) => {
                  const kind = String(field.uiType ?? field.type ?? "").toLowerCase().replace(/[\s_-]/gu, "");
                  return kind === "singleselect" || kind === "select" || kind === "3";
                }).map((field) => <option key={field.fieldId} value={field.fieldId}>{field.fieldName}</option>)}
              </select>
            </label>
            <label>
              <span>素材文档字段</span>
              <select
                aria-label="素材文档字段"
                value={subjectForm.documentFieldId}
                onChange={(event) => selectPhasedField("document", event.target.value)}
              >
                <option value="">选择文档字段</option>
                {metadataFieldOptions.map((field) => <option key={field.fieldId} value={field.fieldId}>{field.fieldName}</option>)}
              </select>
            </label>
            <label>
              <span>命名字段</span>
              <select
                aria-label="命名字段"
                value={subjectForm.namingFieldId}
                onChange={(event) => selectPhasedField("naming", event.target.value)}
              >
                <option value="">选择命名字段</option>
                {metadataFieldOptions.map((field) => <option key={field.fieldId} value={field.fieldId}>{field.fieldName}</option>)}
              </select>
            </label>
          </div>
        </fieldset>
        <div className="feishu-stage-editors">
          {PHASE_IDS.map((stageId) => <FeishuStageEditor
            key={stageId}
            stageId={stageId}
            value={subjectForm.stages![stageId]}
            metadataFields={triggerFields}
            statusOptions={statusOptions}
            disabled={busy}
            onChange={(value) => updateStage(stageId, value)}
            validationErrors={phasedValidationErrors.filter((error) => error.startsWith(PHASE_LABELS[stageId]))}
          />)}
        </div>
      </section>}
      {!phased && <fieldset disabled={busy}>
        <legend>触发与执行</legend>
        <div className="feishu-settings-grid">
          <label>触发字段<select value={subjectForm.triggerFieldId} onChange={(event) => selectTriggerField(event.target.value)}>
            {!hasConfiguredTriggerField && <option value={subjectForm.triggerFieldId}>{subjectForm.triggerFieldName}（已有配置）</option>}
            {triggerFields.map((field) => <option key={field.fieldId} value={field.fieldId}>{field.fieldName}</option>)}
          </select></label>
          <label>可开始值（如待剪辑/待制作）{startValueOptions.length > 0
            ? <select value={startValueSelectValue} onChange={(event) => selectStartValue(event.target.value)}>
              {!configuredStartValueOption && <option value={startValueSelectValue}>{subjectForm.startValue}（已有配置）</option>}
              {startValueOptions.map((option) => <option key={option.id} value={`option:${option.id}`}>{option.name}</option>)}
            </select>
            : <input value={subjectForm.startValue} onChange={(event) => setSubjectForm({ ...subjectForm, startValue: event.target.value, optionId: null })} />}
          </label>
          <label>卡片标题字段<select value={subjectForm.titleFieldId} onChange={(event) => selectTitleField(event.target.value)}>
            <option value="">使用记录 ID</option>
            {!hasConfiguredTitleField && subjectForm.titleFieldId
              && <option value={subjectForm.titleFieldId}>{subjectForm.titleFieldName}（已有配置）</option>}
            {triggerFields.map((field) => <option key={field.fieldId} value={field.fieldId}>{field.fieldName}</option>)}
          </select></label>
          <label>剪辑模式<select value={subjectForm.executionMode} onChange={(event) => setSubjectForm({ ...subjectForm, executionMode: event.target.value as SubjectForm["executionMode"] })}><option value="manual">手动</option><option value="automatic">自动</option></select></label>
          <label>并发组<input value={subjectForm.concurrencyGroup} onChange={(event) => setSubjectForm({ ...subjectForm, concurrencyGroup: event.target.value })} /></label>
          <label>并发数<input type="number" min={1} step={1} value={subjectForm.maxConcurrent} onChange={(event) => setSubjectForm({ ...subjectForm, maxConcurrent: event.target.value })} /></label>
          <label>资源组<input value={subjectForm.resourceGroups} onChange={(event) => setSubjectForm({ ...subjectForm, resourceGroups: event.target.value })} /></label>
        </div>
      </fieldset>}
      <fieldset disabled={busy}>
        <legend>Auto-Cut 路由</legend>
        <div className="feishu-settings-grid">
          <label className="feishu-settings-wide">Auto-Cut 包<select value={subjectForm.packageAlias} onChange={(event) => setSubjectForm({ ...subjectForm, packageAlias: event.target.value })}>
            {!selectedPackage && subjectForm.packageAlias && <option value={subjectForm.packageAlias}>{subjectForm.packageAlias}（不可用）</option>}
            <option value="">未选择包</option>
            {(packageOptions ?? []).filter((item) => item.state === "enabled").map((item) => <option key={item.alias} value={item.alias}>{item.name}（{item.alias}）</option>)}
          </select></label>
        </div>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>ZIP 与上传</legend>
        <div className="feishu-settings-grid">
          <label>ZIP 获取方式<select value={subjectForm.artifactSourceMode} onChange={(event) => setSubjectForm({ ...subjectForm, artifactSourceMode: event.target.value as SubjectForm["artifactSourceMode"] })}><option value="manual_select">手动选择</option><option value="watch_directory" disabled>监控目录（后续）</option><option value="driver_report">Auto-Cut 上报</option></select></label>
          <label>上传入队<select value={subjectForm.enqueueMode} onChange={(event) => setSubjectForm({ ...subjectForm, enqueueMode: event.target.value as SubjectForm["enqueueMode"] })}><option value="manual">手动</option><option value="automatic">自动</option></select></label>
          <label className="feishu-settings-wide">ZIP 来源根目录<input value={subjectForm.artifactSourcePath} disabled={subjectForm.artifactSourceMode === "manual_select"} onChange={(event) => setSubjectForm({ ...subjectForm, artifactSourcePath: event.target.value })} /></label>
          <label>上传目标别名<input value={subjectForm.targetId} onChange={(event) => setSubjectForm({ ...subjectForm, targetId: event.target.value })} /></label>
          <label>上传并发数<input type="number" min={1} step={1} value={subjectForm.uploadConcurrency} onChange={(event) => setSubjectForm({ ...subjectForm, uploadConcurrency: event.target.value })} /></label>
          <label className="feishu-settings-wide">上传路径<input value={subjectForm.targetPath} onChange={(event) => setSubjectForm({ ...subjectForm, targetPath: event.target.value })} /></label>
        </div>
      </fieldset>
      <div className="feishu-subject-actions">
        <button type="submit" className="button secondary" disabled={busy || (phased && phasedValidationErrors.length > 0)}>保存草稿</button>
        {selected.lifecycle === "enabled"
          ? <button type="button" className="button secondary" disabled={busy} onClick={() => void transition("disable")}>停用</button>
          : selected.lifecycle === "draft"
            ? <>
              <button type="button" className="button primary" disabled={busy || Boolean(enableBlockedReason)} title={enableBlockedReason} onClick={() => void transition("enable")}>启用</button>
              <button type="button" className="button secondary" disabled={busy} onClick={() => void transition("disable")}>停用旧 Bridge 快照</button>
            </>
            : <button type="button" className="button primary" disabled={busy || Boolean(enableBlockedReason)} title={enableBlockedReason} onClick={() => void transition("enable")}>启用</button>}
      </div>
    </form>}
  </section>;
}

export default FeishuWorkflowPanel;
