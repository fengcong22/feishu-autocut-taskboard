import { useEffect, useMemo, useState } from "react";
import {
  ApiError,
  discoverFeishuPackageModels,
  disableFeishuPackage,
  enableFeishuPackage,
  listFeishuPackages,
  removeFeishuPackage,
  saveFeishuPackageDraft,
} from "../api";
import type {
  AiChatModel,
  AutoCutPackageDraft,
  AutoCutPackageReference,
  FeishuPackage,
  FeishuPackageState,
  FeishuPackageSummary,
} from "../types";
import { LinearIcon } from "./LinearIcon";

type Props = {
  refreshKey?: number;
  onPackageChange?: (packages: FeishuPackageSummary[]) => void;
  onError?: (message: string) => void;
};

type PackageForm = AutoCutPackageDraft & Pick<FeishuPackage, "state" | "revision" | "updatedAt">;

const EMPTY_FORM: PackageForm = {
  alias: "",
  name: "",
  projectId: "",
  workspacePath: null,
  model: null,
  reasoningEffort: null,
  prompt: null,
  zipSourceDirectory: null,
  maxConcurrent: 1,
  state: "draft",
  revision: 1,
  updatedAt: "",
};

const DRAFT_FIELDS: Array<keyof AutoCutPackageDraft> = [
  "alias",
  "name",
  "projectId",
  "workspacePath",
  "model",
  "reasoningEffort",
  "prompt",
  "zipSourceDirectory",
  "maxConcurrent",
];

const STATE_LABELS: Record<FeishuPackageState, string> = {
  draft: "草稿",
  enabled: "已启用",
  disabled: "已停用",
};

function asForm(value: FeishuPackage): PackageForm {
  return {
    alias: value.alias,
    name: value.name,
    projectId: value.projectId,
    workspacePath: value.workspacePath,
    model: value.model,
    reasoningEffort: value.reasoningEffort,
    prompt: value.prompt,
    zipSourceDirectory: value.zipSourceDirectory,
    maxConcurrent: value.maxConcurrent,
    state: value.state,
    revision: value.revision,
    updatedAt: value.updatedAt,
  };
}

function asDraft(value: PackageForm): AutoCutPackageDraft {
  return {
    alias: value.alias,
    name: value.name,
    projectId: value.projectId,
    workspacePath: value.workspacePath,
    model: value.model,
    reasoningEffort: value.reasoningEffort,
    prompt: value.prompt,
    zipSourceDirectory: value.zipSourceDirectory,
    maxConcurrent: value.maxConcurrent,
  };
}

function packageReferences(error: unknown): AutoCutPackageReference[] {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== "object") return [];
  const references = (error.details as { references?: unknown }).references;
  if (!Array.isArray(references)) return [];
  return references.filter((reference): reference is AutoCutPackageReference => (
    Boolean(reference)
    && typeof reference === "object"
    && ((reference as { type?: unknown }).type === "subject" || (reference as { type?: unknown }).type === "task")
  ));
}

function referenceLabel(reference: AutoCutPackageReference): string {
  if (reference.type === "subject") return `${reference.baseName} / ${reference.tableName}`;
  return `${reference.identifier} · ${reference.title}`;
}

export function FeishuPackageManager({ refreshKey = 0, onPackageChange, onError }: Props) {
  const [packages, setPackages] = useState<FeishuPackageSummary[]>([]);
  const [selectedAlias, setSelectedAlias] = useState<string | null>(null);
  const [form, setForm] = useState<PackageForm>({ ...EMPTY_FORM });
  const [models, setModels] = useState<AiChatModel[]>([]);
  const [busy, setBusy] = useState(false);
  const [referenceDrawer, setReferenceDrawer] = useState<AutoCutPackageReference[]>([]);
  const selected = useMemo(
    () => packages.find((item) => item.alias === selectedAlias) ?? null,
    [packages, selectedAlias],
  );
  const dirty = Boolean(selected) && DRAFT_FIELDS.some((field) => form[field] !== selected?.[field]);
  const selectedModel = models.find((model) => model.slug === form.model) ?? null;
  const modelOptions = useMemo(() => {
    if (!form.model || models.some((model) => model.slug === form.model)) return models;
    return [{
      slug: form.model,
      displayName: `${form.model}（当前配置）`,
      description: "",
      defaultReasoningEffort: form.reasoningEffort ?? "",
      supportedReasoningEfforts: form.reasoningEffort ? [form.reasoningEffort] : [],
      serviceTiers: [],
    }, ...models];
  }, [form.model, form.reasoningEffort, models]);
  const reasoningOptions = selectedModel?.supportedReasoningEfforts
    ?? (form.reasoningEffort ? [form.reasoningEffort] : []);
  const canEditAlias = !selected || (selected.state === "draft" && selected.referenceCount === 0);

  async function refresh(preferredAlias: string | null = selectedAlias) {
    try {
      const next = await listFeishuPackages();
      setPackages(next);
      onPackageChange?.(next);
      const nextSelected = next.find((item) => item.alias === preferredAlias) ?? next[0] ?? null;
      setSelectedAlias(nextSelected?.alias ?? null);
      setForm(nextSelected ? asForm(nextSelected) : { ...EMPTY_FORM });
      setReferenceDrawer([]);
      return next;
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "加载 Auto-Cut 包失败");
      return null;
    }
  }

  useEffect(() => {
    void refresh();
    // refreshKey is incremented by local realtime package events.
  }, [refreshKey]);

  function selectPackage(item: FeishuPackageSummary) {
    setSelectedAlias(item.alias);
    setForm(asForm(item));
    setModels([]);
    setReferenceDrawer([]);
  }

  function update<K extends keyof PackageForm>(key: K, value: PackageForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function writeDraft() {
    return saveFeishuPackageDraft(selectedAlias, {
      ...asDraft(form),
      ...(selectedAlias ? { expectedRevision: form.revision } : {}),
    });
  }

  function reportMutationError(error: unknown, fallback: string) {
    const references = packageReferences(error);
    if (references.length > 0) setReferenceDrawer(references);
    onError?.(error instanceof Error ? error.message : fallback);
  }

  async function save() {
    setBusy(true);
    try {
      const saved = await writeDraft();
      await refresh(saved.alias);
    } catch (error) {
      reportMutationError(error, "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function runEditorAction(kind: "enable" | "disable" | "delete") {
    if (!selectedAlias || !selected) return;
    if (kind === "delete" && selected.referenceCount > 0) {
      setReferenceDrawer(selected.references);
      return;
    }
    if (kind === "delete" && !window.confirm(`确认删除 Auto-Cut 包“${selected.name}”吗？`)) return;
    setBusy(true);
    try {
      let target: FeishuPackage = selected;
      if (kind !== "delete" && dirty) target = await writeDraft();
      const result = kind === "enable"
        ? await enableFeishuPackage(target.alias, target.revision)
        : kind === "disable"
          ? await disableFeishuPackage(target.alias, target.revision)
          : await removeFeishuPackage(target.alias, target.revision);
      await refresh(kind === "delete" ? null : result.alias);
    } catch (error) {
      const references = packageReferences(error);
      reportMutationError(error, "操作失败");
      await refresh(selectedAlias);
      if (references.length > 0) setReferenceDrawer(references);
    } finally {
      setBusy(false);
    }
  }

  async function runRowAction(kind: "disable" | "delete", item: FeishuPackageSummary) {
    selectPackage(item);
    if (kind === "delete" && item.referenceCount > 0) {
      setReferenceDrawer(item.references);
      return;
    }
    if (kind === "delete" && !window.confirm(`确认删除 Auto-Cut 包“${item.name}”吗？`)) return;
    setBusy(true);
    try {
      const result = kind === "disable"
        ? await disableFeishuPackage(item.alias, item.revision)
        : await removeFeishuPackage(item.alias, item.revision);
      await refresh(kind === "delete" ? null : result.alias);
    } catch (error) {
      const references = packageReferences(error);
      reportMutationError(error, "操作失败");
      await refresh(item.alias);
      if (references.length > 0) setReferenceDrawer(references);
    } finally {
      setBusy(false);
    }
  }

  async function discover() {
    if (!form.workspacePath) return;
    setBusy(true);
    try {
      const result = await discoverFeishuPackageModels(form.workspacePath);
      setModels(result.models);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "模型发现失败");
    } finally {
      setBusy(false);
    }
  }

  function changeWorkspace(workspacePath: string) {
    setModels([]);
    setForm((current) => ({ ...current, workspacePath: workspacePath || null, model: null, reasoningEffort: null }));
  }

  function changeModel(slug: string) {
    const model = models.find((item) => item.slug === slug) ?? null;
    setForm((current) => ({
      ...current,
      model: slug || null,
      reasoningEffort: model?.defaultReasoningEffort || model?.supportedReasoningEfforts[0] || null,
    }));
  }

  return <section className="feishu-package-manager" aria-label="Auto-Cut 包管理">
    <div className="feishu-package-list package-list">
      <div className="feishu-package-list-header">
        <h2>Auto-Cut 包</h2>
        <button type="button" onClick={() => {
          setSelectedAlias(null);
          setForm({ ...EMPTY_FORM });
          setModels([]);
          setReferenceDrawer([]);
        }}>新增 Auto-Cut 包</button>
      </div>
      <div className="feishu-package-table-header" aria-hidden="true">
        <span>包</span><span>状态</span><span>模型 / 推理</span><span>并发</span><span>引用</span><span>操作</span>
      </div>
      {packages.length === 0 && <p className="feishu-package-empty">暂无包配置</p>}
      {packages.map((item) => <div key={item.alias} className={`feishu-package-row${item.alias === selectedAlias ? " active" : ""}`}>
        <button type="button" className="feishu-package-select" onClick={() => selectPackage(item)} aria-label={`编辑 ${item.name}`}>
          <strong>{item.name}</strong><small>{item.alias}</small>
        </button>
        <span className={`feishu-package-state state-${item.state}`}>{STATE_LABELS[item.state]}</span>
        <span className="feishu-package-model">{item.model ?? "未配置"}<small>{item.reasoningEffort ?? "-"}</small></span>
        <span className="feishu-package-concurrency">{item.maxConcurrent}</span>
        <button type="button" className="feishu-package-refs" disabled={item.referenceCount === 0} onClick={() => { selectPackage(item); setReferenceDrawer(item.references); }} aria-label={`查看 ${item.name} 的 ${item.referenceCount} 个引用`}>{item.referenceCount}</button>
        <span className="feishu-package-row-actions">
          <button type="button" title="编辑" aria-label={`编辑 ${item.name}`} onClick={() => selectPackage(item)}><LinearIcon name="write" /></button>
          {item.state === "enabled" && <button type="button" title="停用" aria-label={`停用 ${item.name}`} disabled={busy} onClick={() => void runRowAction("disable", item)}><LinearIcon name="pause" /></button>}
          <button type="button" title={item.referenceCount > 0 ? "存在引用，不能删除" : "删除"} aria-label={`删除 ${item.name}`} disabled={busy || item.referenceCount > 0} onClick={() => void runRowAction("delete", item)}><LinearIcon name="trash" /></button>
        </span>
      </div>)}
    </div>

    <div className="feishu-package-editor package-editor">
      <div className="feishu-package-editor-header">
        <div>
          <h2>{selectedAlias ? "编辑包" : "新增 Auto-Cut 包"}</h2>
          {selected && <small>状态：{STATE_LABELS[selected.state]} · 引用：{selected.referenceCount}</small>}
        </div>
        <div className="feishu-package-actions">
          <button type="button" disabled={busy || !form.alias || !form.name || !form.projectId} onClick={() => void save()}>保存草稿</button>
          {selected && selected.state !== "enabled" && <button type="button" disabled={busy} onClick={() => void runEditorAction("enable")}>启用</button>}
          {selected && selected.state === "enabled" && <button type="button" disabled={busy} onClick={() => void runEditorAction("disable")}>停用</button>}
          {selected && <button type="button" className="danger" disabled={busy || selected.referenceCount > 0} title={selected.referenceCount > 0 ? "存在引用，不能删除" : "删除"} onClick={() => void runEditorAction("delete")}>删除</button>}
        </div>
      </div>

      {referenceDrawer.length > 0 && <aside className="feishu-package-reference-warning" aria-label="包引用详情">
        <div><strong>引用详情</strong><button type="button" title="关闭" aria-label="关闭引用详情" onClick={() => setReferenceDrawer([])}><LinearIcon name="close" /></button></div>
        <ul>{referenceDrawer.map((reference) => <li key={reference.type === "subject" ? reference.subjectKey : reference.taskId}>
          <span>{reference.type === "subject" ? "学科" : "未完成任务"}</span>{referenceLabel(reference)}
        </li>)}</ul>
      </aside>}

      <div className="feishu-package-form">
        <label>包别名<input value={form.alias} disabled={!canEditAlias} onChange={(event) => update("alias", event.target.value)} /></label>
        <label>显示名称<input value={form.name} onChange={(event) => update("name", event.target.value)} /></label>
        <label>项目 ID<input value={form.projectId} onChange={(event) => update("projectId", event.target.value)} /></label>
        <label>Codex 工作区路径<input value={form.workspacePath ?? ""} onChange={(event) => changeWorkspace(event.target.value)} placeholder="绝对路径" /></label>
        <label>ZIP 获取目录<input value={form.zipSourceDirectory ?? ""} onChange={(event) => update("zipSourceDirectory", event.target.value || null)} placeholder="绝对路径（可选）" /></label>
        <label>GPT 模型<select value={form.model ?? ""} onChange={(event) => changeModel(event.target.value)}>
          <option value="">请选择模型</option>
          {modelOptions.map((model) => <option key={model.slug} value={model.slug}>{model.displayName || model.slug}</option>)}
        </select></label>
        <button type="button" className="secondary" disabled={busy || !form.workspacePath} onClick={() => void discover()}>发现模型</button>
        <label>推理强度<select value={form.reasoningEffort ?? ""} disabled={!form.model} onChange={(event) => update("reasoningEffort", event.target.value || null)}>
          <option value="">请选择强度</option>
          {reasoningOptions.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
        </select></label>
        <label>最大并发<input type="number" min={1} step={1} value={form.maxConcurrent} onChange={(event) => update("maxConcurrent", Number(event.target.value))} /></label>
        <label className="wide">启动 Prompt<textarea value={form.prompt ?? ""} onChange={(event) => update("prompt", event.target.value || null)} rows={6} /></label>
      </div>
    </div>
  </section>;
}

export default FeishuPackageManager;
