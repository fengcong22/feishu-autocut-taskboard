import { useEffect, useRef, useState } from "react";
import { ApiError, getBoardStageLabels, saveBoardStageLabels } from "../api";
import { useTaskboardI18n } from "../i18n";
import { TASK_STATUSES, type BoardStageLabels, type TaskStatus } from "../types";

type Props = {
  value?: BoardStageLabels | null;
  onUpdated?: (value: BoardStageLabels) => void;
  onError?: (message: string) => void;
};

const LANGUAGE_LABELS = {
  zh: ["中文显示名称", "Chinese labels"],
  en: ["English display names", "English labels"],
} as const;

export function BoardStageSettings({ value = null, onUpdated, onError }: Props) {
  const { text } = useTaskboardI18n();
  const [settings, setSettings] = useState<BoardStageLabels | null>(value);
  const [draft, setDraft] = useState<BoardStageLabels["labels"] | null>(value?.labels ?? null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(value === null);
  const [conflict, setConflict] = useState(false);
  const settingsRef = useRef(settings);
  const draftRef = useRef(draft);
  settingsRef.current = settings;
  draftRef.current = draft;

  useEffect(() => {
    if (value) {
      const currentSettings = settingsRef.current;
      const currentDraft = draftRef.current;
      const dirty = Boolean(
        currentSettings
        && currentDraft
        && JSON.stringify(currentSettings.labels) !== JSON.stringify(currentDraft),
      );
      if (dirty) {
        setConflict(true);
      } else {
        setSettings(value);
        setDraft(value.labels);
      }
      setLoading(false);
      return;
    }
    let disposed = false;
    setLoading(true);
    void getBoardStageLabels()
      .then((next) => {
        if (disposed) return;
        setSettings(next);
        setDraft(next.labels);
      })
      .catch((error) => {
        if (!disposed) onError?.(error instanceof Error ? error.message : text("加载流程栏名称失败", "Could not load stage labels"));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => { disposed = true; };
  }, [value?.version]);

  function update(language: "zh" | "en", status: TaskStatus, label: string) {
    setDraft((current) => current ? {
      ...current,
      [language]: { ...current[language], [status]: label },
    } : current);
    setConflict(false);
  }

  async function reload() {
    try {
      const next = await getBoardStageLabels();
      setSettings(next);
      setDraft(next.labels);
      setConflict(false);
      onUpdated?.(next);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : text("加载流程栏名称失败", "Could not load stage labels"));
    }
  }

  async function save() {
    if (!settings || !draft) return;
    setBusy(true);
    setConflict(false);
    try {
      const expectedVersion = settings.version;
      const next = await saveBoardStageLabels(expectedVersion, draft);
      setSettings(next);
      setDraft(next.labels);
      onUpdated?.(next);
    } catch (error) {
      if (error instanceof ApiError && error.code === "BOARD_STAGE_LABELS_CONFLICT") {
        await reload();
        setConflict(true);
      } else {
        onError?.(error instanceof Error ? error.message : text("保存流程栏名称失败", "Could not save stage labels"));
      }
    } finally {
      setBusy(false);
    }
  }

  const dirty = Boolean(settings && draft && JSON.stringify(settings.labels) !== JSON.stringify(draft));

  return (
    <section className="board-stage-settings" aria-label={text("流程栏名称", "Board stage labels")}>
      <header className="board-stage-settings-header">
        <div>
          <h2>{text("流程栏名称", "Board stage labels")}</h2>
          <p>{text("全局设置，所有多维表格和学科共用。", "Global labels shared by every Base and subject.")}</p>
        </div>
        <span>{settings ? `v${settings.version}` : "-"}</span>
      </header>
      {conflict && (
        <div className="board-stage-settings-conflict" role="alert">
          {text("设置已被其他窗口修改，已重新加载最新版本。", "Another window changed these labels. The latest version was reloaded.")}
        </div>
      )}
      {loading || !draft ? (
        <p className="board-stage-settings-loading">{text("正在加载…", "Loading…")}</p>
      ) : (
        <div className="board-stage-settings-grid">
          {(["zh", "en"] as const).map((language) => (
            <fieldset key={language}>
              <legend>{text(LANGUAGE_LABELS[language][0], LANGUAGE_LABELS[language][1])}</legend>
              {TASK_STATUSES.map((status) => (
                <label key={status}>
                  <span>{status}</span>
                  <input
                    value={draft[language][status]}
                    maxLength={80}
                    onChange={(event) => update(language, status, event.target.value)}
                  />
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      )}
      <footer className="board-stage-settings-actions">
        <button type="button" onClick={() => void reload()} disabled={busy || loading}>{text("重新加载", "Reload")}</button>
        <button type="button" className="primary" onClick={() => void save()} disabled={busy || loading || !dirty}>{text("保存名称", "Save labels")}</button>
      </footer>
    </section>
  );
}

export default BoardStageSettings;
