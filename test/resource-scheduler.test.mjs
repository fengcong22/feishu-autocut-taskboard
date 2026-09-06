import assert from "node:assert/strict";
import { test } from "node:test";

import { createResourceScheduler } from "../server/resource-scheduler.mjs";

function request(scheduler, requestId, overrides = {}) {
  return scheduler.request({
    requestId,
    concurrencyGroup: "autocut",
    maxConcurrent: 1,
    resourceGroups: [],
    ...overrides,
  });
}

test("requests in one concurrency group wait until an active lease is released", async () => {
  const scheduler = createResourceScheduler();
  const first = await request(scheduler, "task-1");
  let secondStarted = false;
  const secondPromise = request(scheduler, "task-2").then((lease) => {
    secondStarted = true;
    return lease;
  });

  await Promise.resolve();
  assert.equal(secondStarted, false);
  assert.equal(scheduler.snapshot().pendingCount, 1);

  assert.equal(scheduler.release(first), true);
  const second = await secondPromise;
  assert.equal(second.requestId, "task-2");
  assert.equal(scheduler.snapshot().activeCount, 1);
  assert.equal(scheduler.release(second), true);
});

test("a wider legacy request cannot raise the limit while a phased package lease is active", async () => {
  const scheduler = createResourceScheduler();
  const phased = await request(scheduler, "phased-task", {
    concurrencyGroup: "autocut:Auto-cut-lite",
    maxConcurrent: 1,
  });
  let legacyStarted = false;
  const legacyPromise = request(scheduler, "legacy-task", {
    concurrencyGroup: "autocut:Auto-cut-lite",
    maxConcurrent: 3,
  }).then((lease) => {
    legacyStarted = true;
    return lease;
  });

  await Promise.resolve();
  assert.equal(legacyStarted, false);
  assert.equal(scheduler.snapshot().pendingCount, 1);
  assert.equal(
    scheduler.snapshot().concurrencyGroups.find(({ name }) => name === "autocut:Auto-cut-lite").maxConcurrent,
    1,
  );

  scheduler.release(phased);
  const legacy = await legacyPromise;
  assert.equal(legacyStarted, true);
  assert.equal(legacy.requestId, "legacy-task");
  assert.equal(
    scheduler.snapshot().concurrencyGroups.find(({ name }) => name === "autocut:Auto-cut-lite").maxConcurrent,
    3,
  );
  scheduler.release(legacy);
});

test("a live limit refresh cannot override a phased package's fixed serial lease", async () => {
  const scheduler = createResourceScheduler();
  const phased = await request(scheduler, "phased-task", {
    concurrencyGroup: "autocut:Auto-cut-lite",
    maxConcurrent: 1,
    fixedMaxConcurrent: true,
  });
  let legacyStarted = false;
  const legacyPromise = request(scheduler, "legacy-task", {
    concurrencyGroup: "autocut:Auto-cut-lite",
    maxConcurrent: 3,
  }).then((lease) => {
    legacyStarted = true;
    return lease;
  });

  await Promise.resolve();
  assert.equal(legacyStarted, false);
  assert.equal(scheduler.setConcurrencyLimit("autocut:Auto-cut-lite", 3), true);
  await Promise.resolve();
  assert.equal(legacyStarted, false);
  assert.equal(
    scheduler.snapshot().concurrencyGroups.find(({ name }) => name === "autocut:Auto-cut-lite").maxConcurrent,
    1,
  );

  scheduler.release(phased);
  const legacy = await legacyPromise;
  assert.equal(legacyStarted, true);
  assert.equal(
    scheduler.snapshot().concurrencyGroups.find(({ name }) => name === "autocut:Auto-cut-lite").maxConcurrent,
    3,
  );
  scheduler.release(legacy);
});

test("snapshot recovery preserves a phased package's fixed serial lease", async () => {
  const original = createResourceScheduler();
  const originalLease = await request(original, "phased-task", {
    concurrencyGroup: "autocut:Auto-cut-lite",
    maxConcurrent: 1,
    fixedMaxConcurrent: true,
  });
  const snapshot = original.snapshot();
  const recovered = createResourceScheduler();
  const [phased] = recovered.recover(snapshot);

  assert.equal(recovered.setConcurrencyLimit("autocut:Auto-cut-lite", 3), true);
  let legacyStarted = false;
  const legacyPromise = request(recovered, "legacy-task", {
    concurrencyGroup: "autocut:Auto-cut-lite",
    maxConcurrent: 3,
  }).then((lease) => {
    legacyStarted = true;
    return lease;
  });

  await Promise.resolve();
  assert.equal(legacyStarted, false);
  assert.equal(snapshot.active[0].fixedMaxConcurrent, true);
  assert.equal(
    recovered.snapshot().concurrencyGroups.find(({ name }) => name === "autocut:Auto-cut-lite").maxConcurrent,
    1,
  );

  recovered.release(phased);
  const legacy = await legacyPromise;
  assert.equal(legacyStarted, true);
  recovered.release(legacy);
  original.release(originalLease);
});

test("resource groups serialize otherwise independent concurrency groups", async () => {
  const scheduler = createResourceScheduler();
  const first = await request(scheduler, "task-1", {
    concurrencyGroup: "subject-a",
    resourceGroups: ["Auto-cut-A"],
  });
  let blocked = true;
  const sameResource = request(scheduler, "task-2", {
    concurrencyGroup: "subject-b",
    resourceGroups: ["Auto-cut-A"],
  }).then((lease) => {
    blocked = false;
    return lease;
  });
  const independent = request(scheduler, "task-3", {
    concurrencyGroup: "subject-c",
    resourceGroups: ["Auto-cut-B"],
  });

  // The queue is FIFO: a later request does not jump over the blocked head,
  // even when it needs a different resource group.
  assert.equal(blocked, true);
  assert.equal(scheduler.snapshot().pendingCount, 2);

  scheduler.release(first);
  const second = await sameResource;
  assert.equal(second.requestId, "task-2");
  const third = await independent;
  assert.equal(third.requestId, "task-3");
  scheduler.release(second);
  scheduler.release(third);
  assert.equal(scheduler.snapshot().activeCount, 0);
});

test("repeated requests for the same request id share one queued claim", async () => {
  const scheduler = createResourceScheduler();
  const first = await request(scheduler, "task-1");
  const queued = request(scheduler, "task-2");
  const duplicate = request(scheduler, "task-2");

  assert.strictEqual(queued, duplicate);
  scheduler.release(first);
  const [leaseA, leaseB] = await Promise.all([queued, duplicate]);
  assert.strictEqual(leaseA.leaseId, leaseB.leaseId);
  assert.equal(scheduler.snapshot().activeCount, 1);
  scheduler.release(leaseA);
});

test("recover re-registers running requests without creating duplicate capacity", async () => {
  const scheduler = createResourceScheduler({ now: () => "2026-08-21T00:00:00.000Z" });
  const recovered = scheduler.recover({
    requestId: "task-running",
    concurrencyGroup: "autocut",
    maxConcurrent: 1,
    resourceGroups: ["Auto-cut-A"],
    leaseId: "lease-existing",
    grantedAt: "2026-08-20T23:59:00.000Z",
  });

  assert.equal(recovered.requestId, "task-running");
  assert.equal(recovered.leaseId, "lease-existing");
  const duplicate = await request(scheduler, "task-running", {
    resourceGroups: ["Auto-cut-A"],
  });
  assert.strictEqual(duplicate.leaseId, recovered.leaseId);
  assert.equal(scheduler.snapshot().activeCount, 1);

  const queued = request(scheduler, "task-next", {
    resourceGroups: ["Auto-cut-A"],
  });
  assert.equal(scheduler.snapshot().pendingCount, 1);
  scheduler.release(recovered);
  await queued;
});

test("a released lease cannot release a newly acquired lease for the same request", async () => {
  const scheduler = createResourceScheduler();
  const first = await request(scheduler, "task-1");
  assert.equal(scheduler.release(first), true);
  const second = await request(scheduler, "task-1");

  assert.equal(scheduler.release(first), false);
  assert.equal(scheduler.snapshot().activeCount, 1);
  assert.equal(scheduler.release(second), true);
});

test("a queued request can be cancelled without consuming capacity when an active lease is released", async () => {
  const scheduler = createResourceScheduler();
  const first = await request(scheduler, "task-1");
  const queued = request(scheduler, "task-2");

  assert.equal(scheduler.cancel("task-2"), true);
  await assert.rejects(queued, (error) => error?.code === "REQUEST_CANCELLED");
  assert.equal(scheduler.snapshot().pendingCount, 0);

  assert.equal(scheduler.release(first), true);
  assert.equal(scheduler.snapshot().activeCount, 0);
});

test("raising a concurrency limit drains queued requests immediately", async () => {
  const scheduler = createResourceScheduler();
  const first = await request(scheduler, "task-1");
  let started = false;
  const secondPromise = request(scheduler, "task-2").then((lease) => {
    started = true;
    return lease;
  });

  assert.equal(started, false);
  assert.equal(scheduler.setConcurrencyLimit("autocut", 2), true);
  const second = await secondPromise;
  assert.equal(started, true);
  assert.equal(scheduler.snapshot().activeCount, 2);
  scheduler.release(first);
  scheduler.release(second);
  assert.equal(scheduler.snapshot().activeCount, 0);
});
