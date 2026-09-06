import { useMemo } from "react";
import { LinearIcon } from "./LinearIcon";

export interface AutoCutAttemptSummary {
  runId: string;
  attempt: number;
  stageId: string;
  state: string;
  manifestSha256?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface AutoCutRunSummaryProps {
  task: { id: string; version: number; status: string };
  attempts: AutoCutAttemptSummary[];
  retrying: boolean;
  onRetry: (taskId: string, version: number) => void | Promise<void>;
}

const STAGE_LABELS: Record<string, string> = {
  initial: "初稿",
  first_review: "初审修改",
  final_review: "终审修改",
};

const STATE_LABELS: Record<string, string> = {
  preparing: "准备中",
  prepared: "已准备",
  running: "剪辑中",
  blocked: "已暂停",
  reported: "已上报",
  completed: "已完成",
};

function digestPrefix(value: string | null | undefined): string {
  return value ? value.slice(0, 12) : "未生成";
}

export function AutoCutRunSummary({ task, attempts, retrying, onRetry }: AutoCutRunSummaryProps) {
  const ordered = useMemo(
    () => [...attempts].sort((left, right) => left.attempt - right.attempt),
    [attempts],
  );
  if (ordered.length === 0) return null;
  const canRetry = task.status === "blocked" && !retrying;

  return <section className="autocut-run-summary" aria-labelledby="autocut-run-summary-heading">
    <header className="autocut-run-summary-heading">
      <div>
        <h2 id="autocut-run-summary-heading">Auto-Cut 运行</h2>
        <span>{ordered.length} 次尝试</span>
      </div>
      {canRetry && <button
        type="button"
        className="button secondary"
        onClick={() => void onRetry(task.id, task.version)}
      >
        <LinearIcon name="recurrence" />
        重试 Auto-Cut
      </button>}
      {retrying && <span className="autocut-run-retrying" role="status">重试中…</span>}
    </header>
    <ol className="autocut-run-list">
      {ordered.map((attempt) => <li key={attempt.runId} className={`autocut-run-row is-${attempt.state}`}>
        <div className="autocut-run-row-main">
          <strong>第 {attempt.attempt} 次 · {STAGE_LABELS[attempt.stageId] ?? attempt.stageId}</strong>
          <span className="autocut-run-state">{STATE_LABELS[attempt.state] ?? attempt.state}</span>
        </div>
        <div className="autocut-run-row-meta">
          <span>运行 ID <code>{attempt.runId}</code></span>
          <span>清单 <code title={attempt.manifestSha256 ?? undefined}>{digestPrefix(attempt.manifestSha256)}</code></span>
        </div>
        {attempt.errorCode && <div className="autocut-run-error" role="alert">
          <code>{attempt.errorCode}</code>
          {attempt.errorMessage && <span>{attempt.errorMessage}</span>}
        </div>}
      </li>)}
    </ol>
  </section>;
}

export default AutoCutRunSummary;

