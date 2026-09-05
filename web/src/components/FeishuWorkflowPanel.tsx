import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type {
  FeishuBaseCatalog,
  FeishuPackageSummary,
  FeishuSubjectConfig,
  FeishuWorkflowShareDiagnostic,
} from "../types";
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
};

function formForSubject(subject: FeishuSubjectConfig): SubjectForm {
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
                : undefined;
  const visibleSubjects = (base: FeishuBaseCatalog) => base.subjects.filter((subject) => subject.displayEnabled);
  const hiddenSubjects = (base: FeishuBaseCatalog) => base.subjects.filter((subject) => !subject.displayEnabled);
  const triggerFields = selected ? selected.metadata?.fields ?? [] : [];
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
      <fieldset disabled={busy}>
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
      </fieldset>
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
        <button type="submit" className="button secondary" disabled={busy}>保存草稿</button>
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
