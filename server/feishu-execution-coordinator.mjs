import { ApiError } from "./database.mjs";

const MAX_LAUNCH_RETRIES = 3;
const INITIAL_LAUNCH_RETRY_DELAY_MS = 1_000;

/**
 * Durable coordinator for Feishu Auto-Cut executions.
 *
 * The coordinator owns the small amount of orchestration between the visible
 * task status and the in-process resource scheduler.  The database is the
 * source of truth for delayed/queued records; an entry in `entries` is only a
 * wake-up handle and is rebuilt by recover() after a restart.
 */
export function createFeishuExecutionCoordinator({
  database,
  packageStore,
  scheduler,
  startClaimedTask,
  onTaskUpdated = null,
  allowAutomaticExecution = true,
  now = () => Date.now(),
  timers = globalThis,
} = {}) {
  if (!database || !packageStore || !scheduler || typeof startClaimedTask !== "function") {
    throw new TypeError("database, packageStore, scheduler, and startClaimedTask are required");
  }

  const entries = new Map();
  const backgroundLaunches = new Set();
  let closed = false;

  function clock() {
    const value = typeof now === "function" ? now() : now;
    return value instanceof Date ? value.getTime() : Number(value);
  }

  function packageAliasFor(metadata, execution) {
    return metadata?.packageAlias ?? execution?.packageAlias ?? null;
  }

  async function packageFor(alias) {
    if (!alias) return null;
    if (typeof packageStore.get === "function") return packageStore.get(alias);
    if (typeof packageStore.read === "function") {
      const catalog = await packageStore.read();
      return catalog?.[alias] ?? null;
    }
    return null;
  }

  function executionResult(taskId) {
    return {
      task: database.getTask(taskId),
      execution: database.getFeishuExecution(taskId),
    };
  }

  function updateExecution(taskId, state, patch = {}) {
    const current = database.getFeishuExecution(taskId);
    if (!current || current.state === state && Object.keys(patch).length === 0) return current;
    return database.setFeishuExecutionState(taskId, current.version, state, patch);
  }

  function updateTaskStatus(taskId, status) {
    const task = database.getTask(taskId);
    if (!task || task.status === status) return task;
    if (typeof database.transitionFeishuTaskExecution === "function") {
      const updated = database.transitionFeishuTaskExecution(taskId, task.version, status);
      onTaskUpdated?.(updated);
      return updated;
    }
    if (typeof database.setTaskStatus === "function") {
      const updated = database.setTaskStatus(taskId, status);
      onTaskUpdated?.(updated);
      return updated;
    }
    return task;
  }

  async function launch(entry, lease) {
    if (closed) {
      scheduler.release(lease);
      return executionResult(entry.task.id);
    }
    try {
      entry.launching = true;
      entry.leasePending = false;
      const currentTask = database.getTask(entry.task.id) ?? entry.task;
      const alias = packageAliasFor(entry.metadata, database.getFeishuExecution(entry.task.id));
      const packageConfig = await packageFor(alias);
      if (!packageConfig || (packageConfig.state && packageConfig.state !== "enabled")) {
        scheduler.release(lease);
        entry.launching = false;
        const current = database.getFeishuExecution(entry.task.id);
        if (current && current.state !== "queued") updateExecution(entry.task.id, "queued");
        if (currentTask.status !== "queued") updateTaskStatus(currentTask.id, "queued");
        entry.timer = timers.setTimeout(() => {
          entry.timer = null;
          void pump(entry).catch(() => {});
        }, 1_000);
        return executionResult(entry.task.id);
      }
      const result = await startClaimedTask(currentTask, entry.metadata, lease, entry.trigger, entry.actor);
      const current = database.getFeishuExecution(entry.task.id);
      if (current && current.state !== "running") {
        updateExecution(entry.task.id, "running", { leaseId: lease.leaseId ?? null });
      }
      entries.delete(entry.task.id);
      return result ?? executionResult(entry.task.id);
    } catch (error) {
      scheduler.release(lease);
      if (error?.feishuAutoCutPreparationBlocked === true) {
        try { database.clearFeishuExecution(entry.task.id); } catch {}
        entries.delete(entry.task.id);
        throw error;
      }
      try {
        updateExecution(entry.task.id, "delayed", { lastError: error?.code ?? "EXECUTION_FAILED" });
        const current = database.getTask(entry.task.id);
        if (current && (current.status === "queued" || (current.status === "in_progress" && !current.threadId))) {
          updateTaskStatus(entry.task.id, "todo");
        }
      } catch {}
      if (!closed && (entry.launchRetries ?? 0) < MAX_LAUNCH_RETRIES) {
        entry.launchRetries = (entry.launchRetries ?? 0) + 1;
        entry.launching = false;
        entry.leasePending = false;
        entry.scheduling = true;
        entry.timer = timers.setTimeout(() => {
          entry.timer = null;
          void pump(entry).catch(() => {});
        }, Math.min(
          INITIAL_LAUNCH_RETRY_DELAY_MS * (2 ** (entry.launchRetries - 1)),
          30_000,
        ));
        entries.set(entry.task.id, entry);
      } else {
        if (!closed) database.clearFeishuExecution(entry.task.id);
        entries.delete(entry.task.id);
      }
      throw error;
    }
  }

  async function pump(entry) {
    if (closed) return executionResult(entry.task.id);
    const current = database.getFeishuExecution(entry.task.id);
    if (!current || current.state === "running") return executionResult(entry.task.id);
    const task = database.getTask(entry.task.id);
    if (!task || task.archivedAt !== null || !["todo", "queued"].includes(task.status)) {
      cancel(entry.task.id);
      return executionResult(entry.task.id);
    }
    if (entry.leasePending) return executionResult(entry.task.id);
    const remaining = Number(current.readyAt) - clock();
    if (remaining > 0) {
      if (entry.timer !== null) timers.clearTimeout(entry.timer);
      entry.timer = timers.setTimeout(() => {
        entry.timer = null;
        void pump(entry).catch(() => {});
      }, remaining);
      return executionResult(entry.task.id);
    }

    const alias = packageAliasFor(entry.metadata, current);
    const packageConfig = await packageFor(alias);
    if (!packageConfig || (packageConfig.state && packageConfig.state !== "enabled")) {
      // Keep the record durable and visible as 待处理.  A later recovery or
      // package update can call recover() to retry it.
      return executionResult(entry.task.id);
    }
    const request = {
      requestId: entry.task.id,
      concurrencyGroup: `autocut:${alias}`,
      maxConcurrent: typeof entry.metadata?.stageId === "string"
        ? 1
        : Number.isSafeInteger(packageConfig.maxConcurrent) && packageConfig.maxConcurrent > 0
          ? packageConfig.maxConcurrent
          : 1,
      fixedMaxConcurrent: typeof entry.metadata?.stageId === "string",
      resourceGroups: Array.isArray(entry.metadata.resourceGroups) ? entry.metadata.resourceGroups : [],
      queuePolicy: "per-group",
    };
    let leasePromise;
    entry.leasePending = true;
    try {
      leasePromise = scheduler.request(request);
    } catch (error) {
      entry.leasePending = false;
      throw error;
    }
    const pending = scheduler.snapshot?.().pending?.some((item) => item.requestId === request.requestId);
    if (pending) {
      updateExecution(entry.task.id, "queued");
      updateTaskStatus(entry.task.id, "queued");
      const background = leasePromise
        .then((lease) => launch(entry, lease))
        .catch(() => {})
        .finally(() => { entry.leasePending = false; });
      backgroundLaunches.add(background);
      void background.finally(() => backgroundLaunches.delete(background)).catch(() => {});
      return executionResult(entry.task.id);
    }
    const lease = await leasePromise;
    return launch(entry, lease);
  }

  async function schedule(task, metadata, trigger = "manual", { actor = null } = {}) {
    if (closed) throw new Error("Execution coordinator is closed");
    if (trigger === "automatic" && !allowAutomaticExecution) {
      throw new ApiError(409, "AUTOMATIC_EXECUTION_DISABLED", "Automatic Codex execution is disabled by the local policy");
    }
    if (!task?.id) throw new TypeError("task.id is required");
    const existing = entries.get(task.id);
    if (existing) {
      // A drop can be delivered more than once before React has committed its
      // loading state. The first reservation is already durable, so a repeat
      // with the same trigger is an idempotent read rather than a conflict.
      if (existing.trigger === trigger) return executionResult(task.id);
      if (trigger !== "automatic") {
        const activeExecution = database.getFeishuExecution(task.id);
        if (
          existing.launching
          || activeExecution?.state === "running"
          || activeExecution?.state === "queued"
        ) {
          throw new ApiError(409, "TASK_START_IN_PROGRESS", "Task execution is already scheduled");
        }
      }
      if (trigger !== "automatic") {
        const current = database.getFeishuExecution(task.id);
        if (current && Number(current.readyAt) > clock()) {
          updateExecution(task.id, current.state, { readyAt: clock() });
          existing.task = database.getTask(task.id) ?? task;
          existing.trigger = trigger;
          existing.scheduling = true;
          if (existing.timer !== null) timers.clearTimeout(existing.timer);
          existing.timer = null;
          return pump(existing);
        }
      }
      return executionResult(task.id);
    }
    const persisted = database.getFeishuExecution(task.id);
    if (persisted?.trigger === trigger) {
      // The in-memory entry may already have been removed after launch while
      // the durable execution remains running. Reuse that reservation too.
      return executionResult(task.id);
    }
    const mode = metadata?.executionMode === "automatic" || metadata?.mode === "automatic"
      ? "automatic"
      : "manual";
    const readyAt = trigger === "automatic" ? clock() + 5_000 : clock();
    const snapshot = typeof database.getFeishuTaskPackageSnapshot === "function"
      ? database.getFeishuTaskPackageSnapshot(task.id)
      : null;
    database.createFeishuExecution({
      taskId: task.id,
      mode,
      readyAt,
      packageAlias: metadata?.packageAlias ?? null,
      packageRevision: metadata?.packageRevision ?? snapshot?.packageRevision ?? 1,
      trigger,
    });
    const entry = { task: database.getTask(task.id) ?? task, metadata, trigger, actor, scheduling: true, timer: null };
    entries.set(task.id, entry);
    return pump(entry);
  }

  function cancel(taskId) {
    const entry = entries.get(taskId);
    if (entry?.timer !== null) timers.clearTimeout(entry.timer);
    entries.delete(taskId);
    if (typeof scheduler.cancel === "function") scheduler.cancel(taskId);
    const execution = database.getFeishuExecution(taskId);
    if (execution && execution.state !== "running") database.clearFeishuExecution(taskId);
    return Boolean(entry || execution);
  }

  async function recover() {
    if (closed) return [];
    const restored = [];
    for (const execution of database.listPendingFeishuExecutions()) {
      if (entries.has(execution.taskId)) continue;
      const task = database.getTask(execution.taskId);
      if (!task || task.archivedAt !== null) continue;
      const metadata = typeof database.getFeishuTaskOrigin === "function"
        ? database.getFeishuTaskOrigin(execution.taskId) ?? { packageAlias: execution.packageAlias }
        : { packageAlias: execution.packageAlias };
      const entry = { task, metadata, trigger: execution.trigger ?? "manual", actor: null, timer: null };
      entries.set(task.id, entry);
      restored.push(await pump(entry));
    }
    return restored;
  }

  async function wake(packageAlias = null) {
    for (const entry of entries.values()) {
      const alias = packageAliasFor(entry.metadata, database.getFeishuExecution(entry.task.id));
      if (packageAlias && alias !== packageAlias) continue;
      const config = await packageFor(alias);
      if (config?.maxConcurrent && typeof scheduler.setConcurrencyLimit === "function") {
        scheduler.setConcurrencyLimit(
          `autocut:${alias}`,
          typeof entry.metadata?.stageId === "string" ? 1 : config.maxConcurrent,
        );
      }
      if (entry.leasePending) continue;
      void pump(entry).catch(() => {});
    }
  }

  async function close() {
    closed = true;
    for (const entry of entries.values()) {
      if (entry.timer !== null) timers.clearTimeout(entry.timer);
      if (typeof scheduler.cancel === "function") {
        try { scheduler.cancel(entry.task.id); } catch {}
      }
    }
    entries.clear();
    if (backgroundLaunches.size > 0) await Promise.allSettled([...backgroundLaunches]);
  }

  return { schedule, cancel, recover, wake, close };
}
