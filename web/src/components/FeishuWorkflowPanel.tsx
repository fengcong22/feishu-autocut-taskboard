import { useMemo, useState } from "react";
import type { FeishuBaseCatalog, FeishuSubjectConfig } from "../types";
import {
  addFeishuBaseFromUrl,
  saveFeishuWorkflowDraft,
  setFeishuSubjectDisabled,
  setFeishuSubjectEnabled,
} from "../feishuWorkflow";

export interface FeishuWorkflowPanelProps {
  catalog: FeishuBaseCatalog[];
  selectedSubjectKey: string | null;
  onSelectSubject: (subjectKey: string) => void;
  onCatalogChange: (catalog: FeishuBaseCatalog[]) => void;
  onSubjectChange: (subject: FeishuSubjectConfig) => void;
  /** Optional orchestration hooks used by hosts that own persistence. */
  onAddBase?: (url: string) => Promise<FeishuBaseCatalog> | void;
  onSaveDraft?: (subjectKey: string, patch: unknown) => Promise<FeishuSubjectConfig> | void;
  onEnable?: (subject: FeishuSubjectConfig) => Promise<FeishuSubjectConfig> | void;
  onDisable?: (subject: FeishuSubjectConfig) => Promise<FeishuSubjectConfig> | void;
  onError?: (message: string) => void;
}

function statusLabel(subject: FeishuSubjectConfig): string {
  return subject.lifecycle === "enabled" ? "已启用" : subject.lifecycle === "draft" ? "草稿" : "已停用";
}

export function FeishuWorkflowPanel({
  catalog,
  selectedSubjectKey,
  onSelectSubject,
  onCatalogChange,
  onSubjectChange,
  onAddBase,
  onSaveDraft,
  onEnable,
  onDisable,
  onError,
}: FeishuWorkflowPanelProps) {
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = useMemo(() => catalog.flatMap((base) => base.subjects).find((subject) => subject.subjectKey === selectedSubjectKey) ?? null, [catalog, selectedSubjectKey]);
  const visibleSubjects = (base: FeishuBaseCatalog) => base.subjects.filter((subject) => subject.displayEnabled);

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

  async function save(patch: unknown) {
    if (!selected) return;
    setBusy(true);
    try {
      const subject = await (onSaveDraft ? onSaveDraft(selected.subjectKey, patch) : saveFeishuWorkflowDraft(selected.subjectKey, patch));
      if (subject) onSubjectChange(subject);
    }
    catch (error) { onError?.(error instanceof Error ? error.message : "无法保存草稿"); }
    finally { setBusy(false); }
  }

  async function transition(action: "enable" | "disable") {
    if (!selected) return;
    setBusy(true);
    try {
      const subject = await (action === "enable"
        ? (onEnable ? onEnable(selected) : setFeishuSubjectEnabled(selected))
        : (onDisable ? onDisable(selected) : setFeishuSubjectDisabled(selected)));
      if (subject) onSubjectChange(subject);
    }
    catch (error) { onError?.(error instanceof Error ? error.message : "无法更新状态"); }
    finally { setBusy(false); }
  }

  return <section className="feishu-workflow-panel" aria-label="飞书多维表格工作流">
    <div className="feishu-workflow-add">
      <input aria-label="多维表格链接" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="粘贴多维表格链接" />
      <button type="button" onClick={() => void addBase()} disabled={busy || !baseUrl.trim()}>新增多维表格</button>
    </div>
    <div className="feishu-workflow-catalog">
      {catalog.map((base) => <div className="feishu-base" key={base.baseToken}>
        <h3>{base.baseName}</h3>
        {visibleSubjects(base).map((subject) => <button
          type="button"
          className={subject.subjectKey === selectedSubjectKey ? "active" : ""}
          key={subject.subjectKey}
          onClick={() => onSelectSubject(subject.subjectKey)}
        >{subject.tableName}<span>{statusLabel(subject)}</span></button>)}
      </div>)}
    </div>
    {selected && <div className="feishu-subject-settings">
      <h3>{selected.baseName} / {selected.tableName}</h3>
      <label>触发字段 <input value={selected.trigger?.fieldName ?? ""} onChange={(event) => void save({ trigger: { ...selected.trigger, fieldName: event.target.value } })} /></label>
      <label>可开始值（如待剪辑/待制作） <input value={selected.trigger?.startValue ?? ""} onChange={(event) => void save({ trigger: { ...selected.trigger, startValue: event.target.value } })} /></label>
      <label>剪辑模式 <select value={selected.execution?.mode ?? "manual"} onChange={(event) => void save({ execution: { ...selected.execution, mode: event.target.value } })}><option value="manual">手动</option><option value="automatic">自动</option></select></label>
      <label>并发数 <input type="number" min={1} value={selected.execution?.maxConcurrent ?? 1} onChange={(event) => void save({ execution: { ...selected.execution, maxConcurrent: Number(event.target.value) } })} /></label>
      <label>上传路径 <input value={selected.upload?.targetPath ?? ""} onChange={(event) => void save({ upload: { ...selected.upload, targetPath: event.target.value } })} placeholder="本地路径或 NAS/UNC 路径" /></label>
      <div className="feishu-subject-actions"><button type="button" disabled={busy} onClick={() => void save({})}>保存草稿</button>{selected.lifecycle === "enabled" ? <button type="button" disabled={busy} onClick={() => void transition("disable")}>停用</button> : <button type="button" disabled={busy} onClick={() => void transition("enable")}>启用</button>}</div>
    </div>}
  </section>;
}

export default FeishuWorkflowPanel;
