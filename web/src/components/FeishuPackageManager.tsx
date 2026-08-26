import { useEffect, useMemo, useState } from "react";
import {
  discoverFeishuPackageModels,
  disableFeishuPackage,
  enableFeishuPackage,
  listFeishuPackages,
  removeFeishuPackage,
  saveFeishuPackageDraft,
} from "../api";
import type { FeishuPackage } from "../types";

type Props = {
  onPackageChange?: (packages: FeishuPackage[]) => void;
  onError?: (message: string) => void;
};

const EMPTY: FeishuPackage = {
  alias: "", name: "", projectId: "", workspacePath: null, model: null,
  reasoningEffort: null, prompt: null, zipSourceDirectory: null,
  maxConcurrent: 1, state: "draft", revision: 1, updatedAt: "",
};

export function FeishuPackageManager({ onPackageChange, onError }: Props) {
  const [packages, setPackages] = useState<FeishuPackage[]>([]);
  const [selectedAlias, setSelectedAlias] = useState<string | null>(null);
  const [form, setForm] = useState<FeishuPackage>(EMPTY);
  const [models, setModels] = useState<Array<{ slug: string; displayName?: string; supportedReasoningEfforts?: string[] }>>([]);
  const [busy, setBusy] = useState(false);
  const [deleteReferences, setDeleteReferences] = useState<unknown[]>([]);
  const selected = useMemo(() => packages.find((item) => item.alias === selectedAlias) ?? null, [packages, selectedAlias]);

  const refresh = async () => {
    try {
      const next = await listFeishuPackages();
      setPackages(next); onPackageChange?.(next);
      if (selectedAlias && next.some((item) => item.alias === selectedAlias)) {
        const current = next.find((item) => item.alias === selectedAlias)!;
        setForm(current);
      } else if (!selectedAlias && next[0]) {
        setSelectedAlias(next[0].alias); setForm(next[0]);
      }
    } catch (error) { onError?.(error instanceof Error ? error.message : "加载 Auto-Cut 包失败"); }
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { if (selected) setForm(selected); }, [selected]);

  const update = (key: keyof FeishuPackage, value: unknown) => setForm((current) => ({ ...current, [key]: value }));
  const save = async () => {
    setBusy(true);
    try {
      const saved = await saveFeishuPackageDraft(selectedAlias, {
        alias: form.alias, name: form.name, projectId: form.projectId,
        workspacePath: form.workspacePath || null, model: form.model || null,
        reasoningEffort: form.reasoningEffort || null, prompt: form.prompt || null,
        zipSourceDirectory: form.zipSourceDirectory || null, maxConcurrent: Number(form.maxConcurrent) || 1,
        ...(selectedAlias ? { expectedRevision: form.revision } : {}),
      });
      setPackages((current) => { const next = selectedAlias ? current.map((item) => item.alias === selectedAlias ? saved : item) : [...current, saved]; onPackageChange?.(next); return next; });
      setSelectedAlias(saved.alias); setForm(saved);
    } catch (error) { onError?.(error instanceof Error ? error.message : "保存失败"); }
    finally { setBusy(false); }
  };
  const action = async (kind: "enable" | "disable" | "delete") => {
    if (!selectedAlias) return;
    setBusy(true);
    try {
      if (kind === "delete" && (form.referenceCount ?? 0) > 0) {
        setDeleteReferences(form.references ?? []);
        throw new Error(`该包仍被 ${form.referenceCount} 个配置引用，无法删除`);
      }
      const result = kind === "enable" ? await enableFeishuPackage(selectedAlias, form.revision)
        : kind === "disable" ? await disableFeishuPackage(selectedAlias, form.revision)
          : await removeFeishuPackage(selectedAlias, form.revision);
      if (kind === "delete") { const next = packages.filter((item) => item.alias !== selectedAlias); setPackages(next); onPackageChange?.(next); setSelectedAlias(next[0]?.alias ?? null); setForm(next[0] ?? EMPTY); setDeleteReferences([]); }
      else { const next = packages.map((item) => item.alias === selectedAlias ? result : item); setPackages(next); onPackageChange?.(next); setForm(result); setDeleteReferences([]); }
    } catch (error) { onError?.(error instanceof Error ? error.message : "操作失败"); }
    finally { setBusy(false); }
  };
  const discover = async () => {
    if (!form.workspacePath) return;
    setBusy(true);
    try { const result = await discoverFeishuPackageModels(form.workspacePath); setModels((result as { models?: typeof models }).models ?? []); }
    catch (error) { onError?.(error instanceof Error ? error.message : "模型发现失败"); }
    finally { setBusy(false); }
  };

  return <section className="feishu-package-manager" aria-label="Auto-Cut 包管理">
    <div className="feishu-package-list package-list">
      <div className="feishu-package-list-header"><h2>Auto-Cut 包</h2><button type="button" onClick={() => { setSelectedAlias(null); setForm({ ...EMPTY }); }}>新增</button></div>
      {packages.length === 0 && <p className="feishu-package-empty">暂无包配置</p>}
      {packages.map((item) => <button type="button" key={item.alias} className={`feishu-package-row${item.alias === selectedAlias ? " active" : ""}`} onClick={() => { setSelectedAlias(item.alias); setForm(item); }}>
        <span><strong>{item.name}</strong><small>{item.alias}</small></span><span className={`feishu-package-state state-${item.state}`}>{item.state}</span><span className="feishu-package-refs">引用 {item.referenceCount ?? 0}</span>
      </button>)}
    </div>
    <div className="feishu-package-editor package-editor">
      <div className="feishu-package-editor-header"><div><h2>{selectedAlias ? "编辑包" : "新增 Auto-Cut 包"}</h2>{selectedAlias && <small>状态：{form.state} · 引用：{form.referenceCount ?? "未知"}</small>}</div><div className="feishu-package-actions"><button type="button" disabled={busy || !form.alias || !form.name || !form.projectId} onClick={() => void save()}>保存草稿</button>{selectedAlias && form.state !== "enabled" && <button type="button" disabled={busy} onClick={() => void action("enable")}>启用</button>}{selectedAlias && form.state === "enabled" && <button type="button" disabled={busy} onClick={() => void action("disable")}>停用</button>}{selectedAlias && <button type="button" className="danger" disabled={busy || (form.referenceCount ?? 0) > 0} onClick={() => void action("delete")}>删除</button>}</div></div>
      {deleteReferences.length > 0 && <div className="feishu-package-reference-warning" role="alert"><strong>该包仍被以下配置引用：</strong><ul>{deleteReferences.map((reference, index) => <li key={index}>{typeof reference === "string" ? reference : JSON.stringify(reference)}</li>)}</ul></div>}
      <div className="feishu-package-form">
        <label>包别名<input value={form.alias} disabled={Boolean(selectedAlias)} onChange={(event) => update("alias", event.target.value)} /></label>
        <label>显示名称<input value={form.name} onChange={(event) => update("name", event.target.value)} /></label>
        <label>项目 ID<input value={form.projectId} onChange={(event) => update("projectId", event.target.value)} /></label>
        <label>Codex 工作区路径<input value={form.workspacePath ?? ""} onChange={(event) => update("workspacePath", event.target.value)} placeholder="绝对路径" /></label>
        <label>ZIP 获取目录<input value={form.zipSourceDirectory ?? ""} onChange={(event) => update("zipSourceDirectory", event.target.value)} placeholder="绝对路径（可选）" /></label>
        <label>GPT 模型<select value={form.model ?? ""} onChange={(event) => update("model", event.target.value || null)}><option value="">请选择模型</option>{models.map((model) => <option key={model.slug} value={model.slug}>{model.displayName ?? model.slug}</option>)}</select></label>
        <button type="button" className="secondary" disabled={busy || !form.workspacePath} onClick={() => void discover()}>发现模型</button>
        <label>推理强度<select value={form.reasoningEffort ?? ""} onChange={(event) => update("reasoningEffort", event.target.value || null)}><option value="">请选择强度</option>{[...new Set(models.flatMap((model) => model.supportedReasoningEfforts ?? []))].map((effort) => <option key={effort} value={effort}>{effort}</option>)}</select></label>
        <label>最大并发<input type="number" min={1} step={1} value={form.maxConcurrent} onChange={(event) => update("maxConcurrent", Number(event.target.value))} /></label>
        <label className="wide">启动 Prompt<textarea value={form.prompt ?? ""} onChange={(event) => update("prompt", event.target.value)} rows={6} /></label>
      </div>
    </div>
  </section>;
}

export default FeishuPackageManager;
