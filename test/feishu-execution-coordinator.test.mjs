import assert from "node:assert/strict";
import { test } from "node:test";

import { createFeishuExecutionCoordinator } from "../server/feishu-execution-coordinator.mjs";

function createClock(start = 1_000) {
  let current = start;
  const timers = new Map();
  let nextId = 1;
  return {
    now: () => current,
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, at: current + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      current += ms;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= current)
        .sort(([, left], [, right]) => left.at - right.at);
      for (const [id, timer] of due) {
        timers.delete(id);
        await timer.callback();
      }
    },
  };
}

function task(id, packageAlias = "Auto-cut-copyA") {
  return { id, version: 1, status: "todo", archivedAt: null, packageAlias };
}

function metadata(packageAlias) {
  return {
    packageAlias,
    packageRevision: 1,
    executionMode: "manual",
    concurrencyGroup: `autocut:${packageAlias}`,
    resourceGroups: [],
  };
}

function createFixture({ packages = {}, maxConcurrent = 1, allowAutomaticExecution = true, failStarts = 0 } = {}) {
  const clock = createClock();
  const tasks = new Map();
  const executions = new Map();
  const starts = [];
  const waiters = new Map();
  const active = new Map();
  let requestCount = 0;
  let leaseNumber = 0;
  let remainingStartFailures = failStarts;

  const database = {
    createFeishuExecution(input) {
      if (executions.has(input.taskId)) {
        throw Object.assign(new Error("execution already exists"), { code: "EXECUTION_EXISTS" });
      }
      const row = {
        taskId: input.taskId,
        state: "delayed",
        mode: input.mode,
        readyAt: input.readyAt,
        packageAlias: input.packageAlias,
        packageRevision: input.packageRevision,
        trigger: input.trigger,
        leaseId: null,
        version: 1,
      };
      executions.set(input.taskId, row);
      return { ...row };
    },
    getFeishuExecution(taskId) { return executions.get(taskId) ? { ...executions.get(taskId) } : null; },
    listPendingFeishuExecutions() { return [...executions.values()].filter((row) => row.state !== "running").map((row) => ({ ...row })); },
    setFeishuExecutionState(taskId, expectedVersion, state, patch = {}) {
      const row = executions.get(taskId);
      assert.equal(row?.version, expectedVersion);
      Object.assign(row, patch, { state, version: row.version + 1 });
      return { ...row };
    },
    clearFeishuExecution(taskId) { executions.delete(taskId); },
    getTask(taskId) { return tasks.get(taskId) ?? null; },
    setTaskStatus(taskId, status) {
      const current = tasks.get(taskId);
      current.status = status;
      current.version += 1;
      return { ...current };
    },
  };

  const scheduler = {
    request(request) {
      requestCount += 1;
      const existing = active.get(request.requestId);
      if (existing) return Promise.resolve(existing.lease);
      const pending = waiters.get(request.requestId);
      if (pending) return pending.promise;
      const limit = packages[request.concurrencyGroup.slice("autocut:".length)]?.maxConcurrent ?? maxConcurrent;
      const count = [...active.values()].filter((entry) => entry.request.concurrencyGroup === request.concurrencyGroup).length;
      if (count < limit) {
        const lease = { requestId: request.requestId, leaseId: `lease-${++leaseNumber}`, concurrencyGroup: request.concurrencyGroup, resourceGroups: [] };
        active.set(request.requestId, { request, lease });
        return Promise.resolve(lease);
      }
      let resolve;
      let reject;
      const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      waiters.set(request.requestId, { request, resolve, reject, promise });
      return promise;
    },
    release(lease) {
      active.delete(lease.requestId);
      const next = [...waiters.values()].find((entry) => entry.request.concurrencyGroup === lease.concurrencyGroup);
      if (!next) return;
      waiters.delete(next.request.requestId);
      const nextLease = { requestId: next.request.requestId, leaseId: `lease-${++leaseNumber}`, concurrencyGroup: next.request.concurrencyGroup, resourceGroups: [] };
      active.set(next.request.requestId, { request: next.request, lease: nextLease });
      next.resolve(nextLease);
    },
    cancel(value) {
      const requestId = typeof value === "string" ? value : value?.requestId;
      const pending = waiters.get(requestId);
      if (!pending) return false;
      waiters.delete(requestId);
      pending.reject(Object.assign(new Error("cancelled"), { code: "REQUEST_CANCELLED" }));
      return true;
    },
    snapshot() {
      return {
        active: [...active.values()].map(({ lease }) => lease),
        pending: [...waiters.values()].map(({ request }) => request),
      };
    },
    setConcurrencyLimit(group, limit) {
      const matching = [...active.values()].filter((entry) => entry.request.concurrencyGroup === group);
      if (!Number.isSafeInteger(limit) || limit < 1) return false;
      packages[group.slice("autocut:".length)].maxConcurrent = limit;
      for (const [requestId, waiter] of [...waiters.entries()]) {
        if (waiter.request.concurrencyGroup !== group) continue;
        if (matching.length >= limit) break;
        waiters.delete(requestId);
        const lease = {
          requestId,
          leaseId: `lease-${++leaseNumber}`,
          concurrencyGroup: group,
          resourceGroups: [],
        };
        active.set(requestId, { request: waiter.request, lease });
        matching.push({ request: waiter.request, lease });
        waiter.resolve(lease);
      }
      return true;
    },
  };

  const packageStore = { async get(alias) { return packages[alias] ?? null; } };
  const coordinator = createFeishuExecutionCoordinator({
    database,
    packageStore,
    scheduler,
    now: clock.now,
    timers: clock,
    allowAutomaticExecution,
    startClaimedTask: async (currentTask, currentMetadata, lease, trigger) => {
      starts.push({ taskId: currentTask.id, packageAlias: currentMetadata.packageAlias, lease, trigger });
      if (remainingStartFailures > 0) {
        remainingStartFailures -= 1;
        throw Object.assign(new Error("fixture start failure"), { code: "FIXTURE_START_FAILED" });
      }
      database.setTaskStatus(currentTask.id, "in_progress");
      database.setFeishuExecutionState(currentTask.id, database.getFeishuExecution(currentTask.id).version, "running", { leaseId: lease.leaseId });
      return { task: database.getTask(currentTask.id), execution: database.getFeishuExecution(currentTask.id) };
    },
  });
  return { clock, database, scheduler, coordinator, starts, tasks, executions, packages, get requestCount() { return requestCount; } };
}

test("automatic registration persists a five-second deadline", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
  fixture.tasks.set("task-1", task("task-1"));
  await fixture.coordinator.schedule(fixture.tasks.get("task-1"), metadata("Auto-cut-copyA"), "automatic");
  const execution = fixture.database.getFeishuExecution("task-1");
  assert.equal(execution.state, "delayed");
  assert.equal(execution.readyAt, 6_000);
  assert.equal(fixture.starts.length, 0);
});

test("automatic scheduling respects the local execution policy", async () => {
  const fixture = createFixture({
    allowAutomaticExecution: false,
    packages: { "Auto-cut-copyA": { maxConcurrent: 1 } },
  });
  fixture.tasks.set("task-1", task("task-1"));
  await assert.rejects(
    () => fixture.coordinator.schedule(fixture.tasks.get("task-1"), metadata("Auto-cut-copyA"), "automatic"),
    (error) => error?.code === "AUTOMATIC_EXECUTION_DISABLED",
  );
});

test("manual immediate start skips the delay", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
  fixture.tasks.set("task-1", task("task-1"));
  const result = await fixture.coordinator.schedule(fixture.tasks.get("task-1"), metadata("Auto-cut-copyA"), "manual");
  assert.equal(result.task.status, "in_progress");
  assert.equal(fixture.starts.length, 1);
});

test("a saturated package queues FIFO while another package starts independently", async () => {
  const fixture = createFixture({
    packages: {
      "Auto-cut-copyA": { maxConcurrent: 1 },
      "Auto-cut-B": { maxConcurrent: 1 },
    },
  });
  for (const id of ["a-1", "a-2", "b-1"]) fixture.tasks.set(id, task(id, id.startsWith("b") ? "Auto-cut-B" : "Auto-cut-copyA"));
  const a1 = await fixture.coordinator.schedule(fixture.tasks.get("a-1"), metadata("Auto-cut-copyA"), "manual");
  const a2 = await fixture.coordinator.schedule(fixture.tasks.get("a-2"), metadata("Auto-cut-copyA"), "manual");
  const b1 = await fixture.coordinator.schedule(fixture.tasks.get("b-1"), metadata("Auto-cut-B"), "manual");
  assert.equal(a1.execution.state, "running");
  assert.equal(a2.execution.state, "queued");
  assert.equal(b1.execution.state, "running");
  assert.deepEqual(fixture.starts.map((entry) => entry.taskId), ["a-1", "b-1"]);
  fixture.scheduler.release(fixture.scheduler.snapshot().active.find((lease) => lease.requestId === "a-1"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(fixture.starts.map((entry) => entry.taskId), ["a-1", "b-1", "a-2"]);
});

test("disabled packages remain waiting and do not start", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { state: "disabled", maxConcurrent: 1 } } });
  fixture.tasks.set("task-1", task("task-1"));
  const result = await fixture.coordinator.schedule(fixture.tasks.get("task-1"), metadata("Auto-cut-copyA"), "manual");
  assert.equal(result.task.status, "todo");
  assert.equal(result.execution.state, "delayed");
  assert.equal(fixture.starts.length, 0);
});

test("recovery restores delayed and queued executions once", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
  fixture.tasks.set("task-1", task("task-1"));
  fixture.database.createFeishuExecution({ taskId: "task-1", mode: "manual", readyAt: 1_000, packageAlias: "Auto-cut-copyA", packageRevision: 1, trigger: "manual" });
  await fixture.coordinator.recover();
  await fixture.coordinator.recover();
  assert.equal(fixture.starts.length, 1);
  assert.equal(fixture.database.getFeishuExecution("task-1").state, "running");
});

test("waking a queued execution after a package limit increase starts it once", async () => {
  const fixture = createFixture({
    packages: { "Auto-cut-copyA": { maxConcurrent: 1 } },
  });
  fixture.tasks.set("task-1", task("task-1"));
  fixture.tasks.set("task-2", task("task-2"));
  await fixture.coordinator.schedule(fixture.tasks.get("task-1"), metadata("Auto-cut-copyA"), "manual");
  await fixture.coordinator.schedule(fixture.tasks.get("task-2"), metadata("Auto-cut-copyA"), "manual");
  assert.equal(fixture.requestCount, 2);
  fixture.packages["Auto-cut-copyA"].maxConcurrent = 2;
  await fixture.coordinator.wake("Auto-cut-copyA");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(fixture.starts.map((entry) => entry.taskId), ["task-1", "task-2"]);
  assert.equal(fixture.requestCount, 2);
  assert.equal(fixture.scheduler.snapshot().pending.length, 0);
});

test("closing cancels queued leases and settles the coordinator", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
  fixture.tasks.set("task-1", task("task-1"));
  fixture.tasks.set("task-2", task("task-2"));
  await fixture.coordinator.schedule(fixture.tasks.get("task-1"), metadata("Auto-cut-copyA"), "manual");
  await fixture.coordinator.schedule(fixture.tasks.get("task-2"), metadata("Auto-cut-copyA"), "manual");
  assert.equal(fixture.scheduler.snapshot().pending.length, 1);

  await Promise.race([
    fixture.coordinator.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("coordinator close timed out")), 100)),
  ]);
  assert.equal(fixture.scheduler.snapshot().pending.length, 0);
});

test("a transient launch failure retries with a bounded delay", async () => {
  const fixture = createFixture({
    failStarts: 1,
    packages: { "Auto-cut-copyA": { maxConcurrent: 1 } },
  });
  fixture.tasks.set("task-1", task("task-1"));
  await assert.rejects(
    () => fixture.coordinator.schedule(fixture.tasks.get("task-1"), metadata("Auto-cut-copyA"), "manual"),
    (error) => error?.code === "FIXTURE_START_FAILED",
  );
  assert.equal(fixture.database.getTask("task-1").status, "todo");
  assert.equal(fixture.database.getFeishuExecution("task-1").state, "delayed");
  assert.equal(fixture.starts.length, 1);

  await fixture.clock.advance(1_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.starts.length, 2);
  assert.equal(fixture.database.getTask("task-1").status, "in_progress");
  assert.equal(fixture.database.getFeishuExecution("task-1").state, "running");
});

test("retry exhaustion releases the durable execution so a manual retry can start", async () => {
  const fixture = createFixture({
    failStarts: 4,
    packages: { "Auto-cut-copyA": { maxConcurrent: 1 } },
  });
  fixture.tasks.set("task-1", task("task-1"));

  await assert.rejects(
    () => fixture.coordinator.schedule(fixture.tasks.get("task-1"), metadata("Auto-cut-copyA"), "manual"),
    (error) => error?.code === "FIXTURE_START_FAILED",
  );
  for (const delay of [1_000, 2_000, 4_000]) {
    await fixture.clock.advance(delay);
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(fixture.starts.length, 4);
  assert.equal(fixture.database.getTask("task-1").status, "todo");
  assert.equal(fixture.database.getFeishuExecution("task-1"), null);

  const retried = await fixture.coordinator.schedule(
    fixture.tasks.get("task-1"),
    metadata("Auto-cut-copyA"),
    "manual",
  );
  assert.equal(retried.task.status, "in_progress");
  assert.equal(retried.execution.state, "running");
  assert.equal(fixture.starts.length, 5);
});
