import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTaskboardI18n } from "../i18n";
import type { FeishuBaseCatalog, FeishuSubjectConfig } from "../types";
import { LinearIcon } from "./LinearIcon";

export interface FeishuBaseNavigatorProps {
  catalog: FeishuBaseCatalog[];
  selectedSubjectKey: string | null;
  onAddBase: (url: string) => Promise<void> | void;
  onSelectSubject: (subjectKey: string) => void;
  onOpenConfiguration: (baseToken?: string, subjectKey?: string) => void;
  onToggleSubjectDisplay: (subject: FeishuSubjectConfig, displayEnabled: boolean) => Promise<void> | void;
  onDisableSubject: (subject: FeishuSubjectConfig) => Promise<void> | void;
  onRemoveBase: (baseToken: string) => Promise<void> | void;
  onRemoveSubject: (subjectKey: string) => Promise<void> | void;
  onError?: (message: string) => void;
}

export function FeishuBaseNavigator({
  catalog,
  selectedSubjectKey,
  onAddBase,
  onSelectSubject,
  onOpenConfiguration,
  onToggleSubjectDisplay,
  onDisableSubject,
  onRemoveBase,
  onRemoveSubject,
  onError,
}: FeishuBaseNavigatorProps) {
  const { text } = useTaskboardI18n();
  const [expandedBaseTokens, setExpandedBaseTokens] = useState<Set<string>>(() => {
    const selectedBase = catalog.find((base) => (
      base.subjects.some((subject) => subject.subjectKey === selectedSubjectKey)
    ));
    const initialBase = selectedBase ?? catalog[0];
    return new Set(initialBase ? [initialBase.baseToken] : []);
  });
  const [addOpen, setAddOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [busyActionKey, setBusyActionKey] = useState<string | null>(null);
  const lifecycleLabel = (lifecycle: "draft" | "enabled" | "disabled") => {
    if (lifecycle === "enabled") return text("已启用", "Enabled");
    if (lifecycle === "disabled") return text("已停用", "Disabled");
    return text("草稿", "Draft");
  };

  const selectedBaseToken = useMemo(() => (
    catalog.find((base) => base.subjects.some((subject) => (
      subject.subjectKey === selectedSubjectKey
    )))?.baseToken ?? null
  ), [catalog, selectedSubjectKey]);

  useEffect(() => {
    if (!selectedBaseToken) return;
    setExpandedBaseTokens((current) => {
      if (current.has(selectedBaseToken)) return current;
      const next = new Set(current);
      next.add(selectedBaseToken);
      return next;
    });
  }, [selectedBaseToken]);

  useEffect(() => {
    if (catalog.length === 0) return;
    setExpandedBaseTokens((current) => {
      const available = new Set(catalog.map((base) => base.baseToken));
      const next = new Set([...current].filter((token) => available.has(token)));
      if (next.size === 0) next.add(selectedBaseToken ?? catalog[0].baseToken);
      if (next.size === current.size && [...next].every((token) => current.has(token))) return current;
      return next;
    });
  }, [catalog, selectedBaseToken]);

  useEffect(() => {
    if (!openMenuKey) return;
    const closeMenu = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest(".feishu-nav-actions, .feishu-nav-menu")) return;
      setOpenMenuKey(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenuKey(null);
    };
    const closeOnViewportChange = () => setOpenMenuKey(null);
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [openMenuKey]);

  function toggleBase(baseToken: string) {
    setExpandedBaseTokens((current) => {
      const next = new Set(current);
      if (next.has(baseToken)) next.delete(baseToken);
      else next.add(baseToken);
      return next;
    });
  }

  function toggleMenu(key: string, trigger: HTMLButtonElement, itemCount: number) {
    if (openMenuKey === key) {
      setOpenMenuKey(null);
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const width = 180;
    const height = 8 + (itemCount * 29);
    const margin = 6;
    const top = rect.bottom + 4 + height <= window.innerHeight - margin
      ? rect.bottom + 4
      : Math.max(margin, rect.top - height - 4);
    setMenuPosition({
      top,
      left: Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin)),
    });
    setOpenMenuKey(key);
  }

  async function addBase() {
    const url = baseUrl.trim();
    if (!url || adding) return;
    setAdding(true);
    try {
      await onAddBase(url);
      setBaseUrl("");
      setAddOpen(false);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : text("无法读取多维表格", "Unable to read Base"));
    } finally {
      setAdding(false);
    }
  }

  async function runAction(key: string, action: () => Promise<void> | void) {
    if (busyActionKey) return;
    setBusyActionKey(key);
    setOpenMenuKey(null);
    try {
      await action();
    } catch (error) {
      onError?.(error instanceof Error ? error.message : text("操作失败", "Action failed"));
    } finally {
      setBusyActionKey(null);
    }
  }

  function confirmBaseRemoval(base: FeishuBaseCatalog): boolean {
    return window.confirm(text(
      `从 Taskboard 移除“${base.baseName}”？其子表将停止接收新任务；已有任务和剪辑、上传历史会保留，飞书数据不会被删除。`,
      `Remove “${base.baseName}” from Taskboard? Its subjects will stop receiving new tasks. Existing task, editing, and upload history will remain, and Feishu data will not be deleted.`,
    ));
  }

  function confirmSubjectRemoval(subject: FeishuSubjectConfig): boolean {
    return window.confirm(text(
      `从 Taskboard 移除“${subject.tableName}”？它将停止接收新任务；已有任务和剪辑、上传历史会保留，飞书数据不会被删除。`,
      `Remove “${subject.tableName}” from Taskboard? It will stop receiving new tasks. Existing task, editing, and upload history will remain, and Feishu data will not be deleted.`,
    ));
  }

  return (
    <section className="feishu-base-nav" aria-label={text("多维表格", "Feishu Bases")}>
      <header className="feishu-base-nav-header">
        <span>{text("多维表格", "Feishu Bases")}</span>
        <div>
          <button
            type="button"
            aria-label={text("新增多维表格", "Add Feishu Base")}
            title={text("新增多维表格", "Add Feishu Base")}
            aria-expanded={addOpen}
            onClick={() => setAddOpen((current) => !current)}
          >
            <LinearIcon name="plus" />
          </button>
          <button
            type="button"
            aria-label={text("配置多维表格", "Configure Feishu Bases")}
            title={text("配置多维表格", "Configure Feishu Bases")}
            onClick={() => onOpenConfiguration(selectedBaseToken ?? catalog[0]?.baseToken, selectedSubjectKey ?? undefined)}
          >
            <LinearIcon name="displayOptions" />
          </button>
        </div>
      </header>

      {addOpen && (
        <form
          className="feishu-base-nav-add"
          onSubmit={(event) => {
            event.preventDefault();
            void addBase();
          }}
        >
          <input
            aria-label={text("多维表格链接", "Feishu Base link")}
            value={baseUrl}
            placeholder={text("粘贴 Base 或 Wiki 链接", "Paste a Base or Wiki link")}
            autoFocus
            disabled={adding}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <button
            type="submit"
            aria-label={text("确认新增", "Add Base")}
            title={text("确认新增", "Add Base")}
            disabled={adding || !baseUrl.trim()}
          >
            <LinearIcon name="check" />
          </button>
        </form>
      )}

      <div className="feishu-base-nav-tree">
        {catalog.length === 0 && <p className="feishu-base-nav-empty">{text("暂无多维表格", "No Feishu Bases")}</p>}
        {catalog.map((base) => {
          const expanded = expandedBaseTokens.has(base.baseToken);
          const visibleSubjects = base.subjects.filter((subject) => subject.displayEnabled);
          return (
            <div className="feishu-base-nav-group" key={base.baseToken}>
              <div className="feishu-base-nav-row-shell">
                <button
                  type="button"
                  className="feishu-base-nav-row"
                  aria-expanded={expanded}
                  title={base.baseName}
                  onClick={() => toggleBase(base.baseToken)}
                >
                  <LinearIcon className="feishu-base-nav-chevron" name="chevronRight" />
                  <LinearIcon className="feishu-base-nav-icon" name="project" />
                  <span>{base.baseName}</span>
                  <small>{visibleSubjects.length}</small>
                </button>
                <div className="feishu-nav-actions">
                  <button
                    type="button"
                    className="feishu-nav-more"
                    aria-label={text(`管理 ${base.baseName}`, `Manage ${base.baseName}`)}
                    title={text("更多操作", "More actions")}
                    aria-haspopup="menu"
                    aria-expanded={openMenuKey === `base:${base.baseToken}`}
                    disabled={busyActionKey === `base:${base.baseToken}`}
                    onClick={(event) => toggleMenu(`base:${base.baseToken}`, event.currentTarget, 2)}
                  >
                    <LinearIcon name="more" />
                  </button>
                  {openMenuKey === `base:${base.baseToken}` && menuPosition && createPortal(
                    <div className="feishu-nav-menu" role="menu" style={menuPosition}>
                      <button type="button" role="menuitem" onClick={() => {
                        setOpenMenuKey(null);
                        const preferred = base.subjects.find((subject) => subject.subjectKey === selectedSubjectKey)
                          ?? visibleSubjects[0]
                          ?? base.subjects[0];
                        onOpenConfiguration(base.baseToken, preferred?.subjectKey);
                      }}>
                        <LinearIcon name="displayOptions" />
                        <span>{text("配置", "Configure")}</span>
                      </button>
                      <button type="button" role="menuitem" className="danger" onClick={() => {
                        if (!confirmBaseRemoval(base)) return;
                        void runAction(`base:${base.baseToken}`, () => onRemoveBase(base.baseToken));
                      }}>
                        <LinearIcon name="trash" />
                        <span>{text("从 Taskboard 移除", "Remove from Taskboard")}</span>
                      </button>
                    </div>,
                    document.body,
                  )}
                </div>
              </div>
              {expanded && (
                <div className="feishu-subject-nav-list">
                  {visibleSubjects.map((subject) => (
                    <div className="feishu-subject-nav-row" key={subject.subjectKey}>
                      <button
                        type="button"
                        className={`feishu-subject-nav-item${subject.subjectKey === selectedSubjectKey ? " active" : ""}`}
                        aria-current={subject.subjectKey === selectedSubjectKey ? "page" : undefined}
                        title={`${subject.tableName} · ${lifecycleLabel(subject.lifecycle)}`}
                        onClick={() => onSelectSubject(subject.subjectKey)}
                      >
                        <span className="feishu-subject-nav-branch" aria-hidden="true" />
                        <span>{subject.tableName}</span>
                        <i data-lifecycle={subject.lifecycle} aria-hidden="true" />
                        <span className="sr-only">{lifecycleLabel(subject.lifecycle)}</span>
                      </button>
                      <div className="feishu-nav-actions">
                        <button
                          type="button"
                          className="feishu-nav-more"
                          aria-label={text(`管理 ${subject.tableName}`, `Manage ${subject.tableName}`)}
                          title={text("更多操作", "More actions")}
                          aria-haspopup="menu"
                          aria-expanded={openMenuKey === `subject:${subject.subjectKey}`}
                          disabled={busyActionKey === `subject:${subject.subjectKey}`}
                          onClick={(event) => toggleMenu(
                            `subject:${subject.subjectKey}`,
                            event.currentTarget,
                            subject.lifecycle === "disabled" ? 3 : 4,
                          )}
                        >
                          <LinearIcon name="more" />
                        </button>
                        {openMenuKey === `subject:${subject.subjectKey}` && menuPosition && createPortal(
                          <div className="feishu-nav-menu" role="menu" style={menuPosition}>
                            <button type="button" role="menuitem" onClick={() => {
                              setOpenMenuKey(null);
                              onOpenConfiguration(base.baseToken, subject.subjectKey);
                            }}>
                              <LinearIcon name="displayOptions" />
                              <span>{text("配置", "Configure")}</span>
                            </button>
                            <button type="button" role="menuitem" onClick={() => void runAction(
                              `subject:${subject.subjectKey}`,
                              () => onToggleSubjectDisplay(subject, false),
                            )}>
                              <LinearIcon name="linkOff" />
                              <span>{text("从左侧隐藏", "Hide from sidebar")}</span>
                            </button>
                            {subject.lifecycle !== "disabled" && (
                              <button type="button" role="menuitem" onClick={() => void runAction(
                                `subject:${subject.subjectKey}`,
                                () => onDisableSubject(subject),
                              )}>
                                <LinearIcon name="pause" />
                                <span>{text("停用接入", "Disable intake")}</span>
                              </button>
                            )}
                            <button type="button" role="menuitem" className="danger" onClick={() => {
                              if (!confirmSubjectRemoval(subject)) return;
                              void runAction(`subject:${subject.subjectKey}`, () => onRemoveSubject(subject.subjectKey));
                            }}>
                              <LinearIcon name="trash" />
                              <span>{text("从 Taskboard 移除", "Remove from Taskboard")}</span>
                            </button>
                          </div>,
                          document.body,
                        )}
                      </div>
                    </div>
                  ))}
                  {visibleSubjects.length === 0 && (
                    <button
                      type="button"
                      className="feishu-subject-nav-empty"
                      onClick={() => onOpenConfiguration(base.baseToken, base.subjects[0]?.subjectKey)}
                    >
                      {text("选择要显示的子表", "Choose subjects to show")}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
