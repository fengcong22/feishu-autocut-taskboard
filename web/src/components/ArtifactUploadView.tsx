import { useEffect, useMemo, useState } from "react";
import { listArtifactUploads, retryTaskArtifactUpload } from "../api";
import { useTaskboardI18n } from "../i18n";
import type { ArtifactUpload, ArtifactUploadListItem, Task } from "../types";
import { LinearIcon, type LinearIconName } from "./LinearIcon";

export type ArtifactUploadBoardView = "upload_queue" | "uploading" | "uploaded";

interface ArtifactUploadViewProps {
  projectId: string;
  view: ArtifactUploadBoardView;
  revision: number;
  search: string;
  onOpenTask: (task: Task) => void;
}

const VIEW_STATUSES: Record<ArtifactUploadBoardView, readonly ArtifactUpload["status"][]> = {
  upload_queue: ["queued", "failed"],
  uploading: ["uploading"],
  uploaded: ["uploaded"],
};

const STATUS_ICONS: Record<ArtifactUpload["status"], LinearIconName> = {
  queued: "file",
  uploading: "play",
  uploaded: "check",
  failed: "alert",
};

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestampFor(upload: ArtifactUpload): string {
  if (upload.status === "uploaded") return upload.completedAt ?? upload.updatedAt;
  if (upload.status === "uploading") return upload.startedAt ?? upload.updatedAt;
  if (upload.status === "failed") return upload.updatedAt;
  return upload.createdAt;
}

function formatTimestamp(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function shaSummary(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}...` : value;
}

export function ArtifactUploadView({
  projectId,
  view,
  revision,
  search,
  onOpenTask,
}: ArtifactUploadViewProps) {
  const { locale, text } = useTaskboardI18n();
  const [items, setItems] = useState<ArtifactUploadListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retryingIds, setRetryingIds] = useState<Set<string>>(() => new Set());
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setActionError(null);
    void listArtifactUploads(projectId, controller.signal).then(
      (nextItems) => {
        setItems(nextItems);
        setLoading(false);
      },
      (error) => {
        if ((error as Error).name === "AbortError") return;
        setLoadError(messageFor(error));
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [projectId, revision, reloadKey]);

  const visibleItems = useMemo(() => {
    const statuses = VIEW_STATUSES[view];
    const query = search.trim().toLocaleLowerCase(locale);
    return items.filter((item) => {
      if (!statuses.includes(item.upload.status)) return false;
      if (!query) return true;
      const searchable = [
        item.task.identifier,
        item.task.title,
        item.upload.filename,
      ];
      return searchable.some((value) => value.toLocaleLowerCase(locale).includes(query));
    });
  }, [items, locale, search, view]);

  async function retryUpload(item: ArtifactUploadListItem) {
    const { upload } = item;
    setRetryingIds((current) => {
      const next = new Set(current);
      next.add(upload.id);
      return next;
    });
    setActionError(null);
    try {
      const nextUpload = await retryTaskArtifactUpload(item.task.id, upload.id);
      setItems((current) => current.map((currentItem) => (
        currentItem.upload.id === upload.id
          ? { ...currentItem, upload: nextUpload }
          : currentItem
      )));
    } catch (error) {
      setActionError(messageFor(error));
    } finally {
      setRetryingIds((current) => {
        const next = new Set(current);
        next.delete(upload.id);
        return next;
      });
    }
  }

  function statusLabel(status: ArtifactUpload["status"]): string {
    const labels: Record<ArtifactUpload["status"], string> = {
      queued: text("排队中", "Queued"),
      uploading: text("上传中", "Uploading"),
      uploaded: text("已上传", "Uploaded"),
      failed: text("上传失败", "Upload failed"),
    };
    return labels[status];
  }

  function emptyLabel(): string {
    if (search.trim()) return text("没有匹配的上传任务", "No uploads match your search");
    if (view === "upload_queue") return text("上传队列为空", "The upload queue is empty");
    if (view === "uploading") return text("当前没有正在上传的任务", "No uploads are in progress");
    return text("还没有已上传的任务", "No uploads have completed yet");
  }

  if (loading) {
    return (
      <div className="artifact-upload-view artifact-upload-loading" role="status" aria-busy="true">
        <LinearIcon name="recurrence" aria-hidden="true" />
        <span>{text("正在加载上传任务...", "Loading uploads...")}</span>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="artifact-upload-view artifact-upload-view-error" role="alert">
        <span aria-hidden="true"><LinearIcon name="alert" /></span>
        <div>
          <strong>{text("无法加载上传任务", "Could not load uploads")}</strong>
          <p>{loadError}</p>
        </div>
        <button
          type="button"
          title={text("重新加载", "Reload")}
          aria-label={text("重新加载", "Reload")}
          onClick={() => setReloadKey((current) => current + 1)}
        >
          <LinearIcon name="recurrence" />
        </button>
      </div>
    );
  }

  return (
    <div className={`artifact-upload-view artifact-upload-${view}`} aria-busy="false">
      {actionError && (
        <div className="artifact-upload-action-error" role="alert">
          <LinearIcon name="alert" aria-hidden="true" />
          <span>{text(`无法重新上传：${actionError}`, `Could not retry upload: ${actionError}`)}</span>
        </div>
      )}

      {visibleItems.length === 0 ? (
        <div className="artifact-upload-empty">
          <LinearIcon name={search.trim() ? "search" : "file"} aria-hidden="true" />
          <span>{emptyLabel()}</span>
        </div>
      ) : (
        <div className="artifact-upload-list" role="list">
          {visibleItems.map((item) => {
            const { upload } = item;
            const timestamp = timestampFor(upload);
            const retrying = retryingIds.has(upload.id);
            return (
              <article className={`artifact-upload-row status-${upload.status}`} role="listitem" key={upload.id}>
                <button
                  className="artifact-upload-task"
                  type="button"
                  onClick={() => onOpenTask(item.task)}
                  title={`${item.task.identifier} ${item.task.title}`}
                >
                  <small>{item.task.identifier}</small>
                  <strong>{item.task.title}</strong>
                </button>

                <span className="artifact-upload-file" title={upload.filename}>
                  <LinearIcon name="file" aria-hidden="true" />
                  <span>{upload.filename}</span>
                </span>

                <span className="artifact-upload-metadata">
                  <span className="artifact-upload-view-status">
                    <LinearIcon name={STATUS_ICONS[upload.status]} aria-hidden="true" />
                    <span>{statusLabel(upload.status)}</span>
                  </span>
                  <span className="artifact-upload-sha" title={`SHA-256 ${upload.sha256}`}>
                    SHA {shaSummary(upload.sha256)}
                  </span>
                  <span className="artifact-upload-attempts">
                    {text(`尝试 ${upload.attemptCount} 次`, `${upload.attemptCount} attempts`)}
                  </span>
                </span>

                <time dateTime={timestamp} title={new Date(timestamp).toLocaleString(locale)}>
                  {formatTimestamp(timestamp, locale)}
                </time>

                <span className="artifact-upload-action">
                  {upload.status === "failed" && (
                    <button
                      type="button"
                      title={text("重新上传", "Retry upload")}
                      aria-label={text("重新上传", "Retry upload")}
                      disabled={retrying}
                      onClick={() => void retryUpload(item)}
                    >
                      <LinearIcon name="recurrence" />
                    </button>
                  )}
                </span>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
