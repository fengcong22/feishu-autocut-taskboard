import { randomUUID } from "node:crypto";

const DEFAULT_CONCURRENCY_GROUP = "default";

function schedulerError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function timestamp(now) {
  const value = typeof now === "function" ? now() : now;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string" && value.trim() !== "") return value;
  return new Date().toISOString();
}

function normalizeRequest(input, extra = {}) {
  const value = typeof input === "string"
    ? { ...extra, requestId: input }
    : { ...(input ?? {}), ...extra };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw schedulerError("INVALID_REQUEST", "Resource request must be an object");
  }
  const requestId = value.requestId ?? value.id ?? value.taskId;
  if (typeof requestId !== "string" || requestId.trim() === "") {
    throw schedulerError("INVALID_REQUEST_ID", "requestId is required");
  }
  const concurrencyGroup = value.concurrencyGroup ?? DEFAULT_CONCURRENCY_GROUP;
  if (typeof concurrencyGroup !== "string" || concurrencyGroup.trim() === "") {
    throw schedulerError("INVALID_CONCURRENCY_GROUP", "concurrencyGroup is required");
  }
  const maxConcurrent = value.maxConcurrent ?? 1;
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
    throw schedulerError("INVALID_MAX_CONCURRENT", "maxConcurrent must be a positive integer");
  }
  if (value.resourceGroups !== undefined && !Array.isArray(value.resourceGroups)) {
    throw schedulerError("INVALID_RESOURCE_GROUPS", "resourceGroups must be an array");
  }
  const resourceGroups = [...new Set((value.resourceGroups ?? []).map((group) => {
    if (typeof group !== "string" || group.trim() === "") {
      throw schedulerError("INVALID_RESOURCE_GROUP", "resourceGroups must contain non-empty strings");
    }
    return group.trim();
  }))];
  return {
    requestId: requestId.trim(),
    concurrencyGroup: concurrencyGroup.trim(),
    maxConcurrent,
    resourceGroups,
    queuePolicy: value.queuePolicy === "per-group" ? "per-group" : "fifo",
  };
}

function leaseView(lease) {
  return {
    requestId: lease.requestId,
    leaseId: lease.leaseId,
    concurrencyGroup: lease.concurrencyGroup,
    maxConcurrent: lease.maxConcurrent,
    resourceGroups: [...lease.resourceGroups],
    grantedAt: lease.grantedAt,
  };
}

/**
 * Creates the in-process resource scheduler used by execution runners.
 *
 * A concurrency group is a counted semaphore.  A resource group is an
 * exclusive semaphore (one running request at a time).  Requests are FIFO;
 * a blocked request at the head intentionally prevents later requests from
 * overtaking it.
 */
export function createResourceScheduler({ database = null, now = () => new Date().toISOString() } = {}) {
  // The database argument is reserved for a future durable lease store.  The
  // first version deliberately keeps ownership in this process so callers can
  // inject a TaskboardDatabase without changing the scheduling contract.
  void database;

  const activeByRequest = new Map();
  const pendingByRequest = new Map();
  const queue = [];
  const concurrencyGroups = new Map();
  const resourceGroups = new Map();

  function groupState(name, maxConcurrent, { update = true } = {}) {
    let state = concurrencyGroups.get(name);
    if (!state) {
      state = { name, maxConcurrent, active: 0 };
      concurrencyGroups.set(name, state);
    } else if (update) {
      // The package registry is the live source of the limit.  Updating the
      // value never interrupts existing leases; it only affects the next
      // drain/grant decision.
      state.maxConcurrent = maxConcurrent;
    }
    return state;
  }

  function canStart(entry) {
    const group = groupState(entry.concurrencyGroup, entry.maxConcurrent, { update: false });
    if (group.active >= group.maxConcurrent) return false;
    return entry.resourceGroups.every((name) => (resourceGroups.get(name) ?? 0) === 0);
  }

  function createLease(entry, existing = {}) {
    const lease = {
      requestId: entry.requestId,
      leaseId: existing.leaseId ?? randomUUID(),
      concurrencyGroup: entry.concurrencyGroup,
      maxConcurrent: entry.maxConcurrent,
      resourceGroups: [...entry.resourceGroups],
      grantedAt: existing.grantedAt ?? timestamp(now),
    };
    Object.defineProperty(lease, "release", {
      enumerable: false,
      value: () => release(lease),
    });
    return lease;
  }

  function grant(entry, recovered = {}) {
    pendingByRequest.delete(entry.requestId);
    const group = groupState(entry.concurrencyGroup, entry.maxConcurrent, { update: false });
    group.active += 1;
    for (const name of entry.resourceGroups) {
      resourceGroups.set(name, (resourceGroups.get(name) ?? 0) + 1);
    }
    const lease = createLease(entry, recovered);
    const active = { entry, lease, promise: entry.promise ?? Promise.resolve(lease) };
    activeByRequest.set(entry.requestId, active);
    if (entry.resolve) entry.resolve(lease);
    return lease;
  }

  function drain() {
    // Preserve FIFO for requests that share a package/resource group while
    // allowing an unrelated package to make progress independently.
    while (queue.length > 0) {
      const index = queue.findIndex((entry, entryIndex) => {
        if (!canStart(entry)) return false;
        if (entry.queuePolicy !== "per-group") return entryIndex === 0;
        return !queue.slice(0, entryIndex).some((earlier) => (
          earlier.queuePolicy !== "per-group"
          || earlier.concurrencyGroup === entry.concurrencyGroup
        ));
      });
      if (index < 0) break;
      const [entry] = queue.splice(index, 1);
      grant(entry);
    }
  }

  function request(input, extra = {}) {
    const normalized = normalizeRequest(input, extra);
    const active = activeByRequest.get(normalized.requestId);
    if (active) return active.promise;
    const pending = pendingByRequest.get(normalized.requestId);
    if (pending) return pending.promise;

    groupState(normalized.concurrencyGroup, normalized.maxConcurrent);

    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const entry = { ...normalized, promise, resolve, reject };
    pendingByRequest.set(entry.requestId, entry);
    queue.push(entry);
    drain();
    return promise;
  }

  function leaseFor(value) {
    if (value && typeof value === "object") {
      if (typeof value.leaseId === "string") {
        for (const active of activeByRequest.values()) {
          if (active.lease.leaseId === value.leaseId) return active;
        }
      }
      if (typeof value.requestId === "string") return activeByRequest.get(value.requestId) ?? null;
    }
    if (typeof value === "string") {
      const byRequest = activeByRequest.get(value);
      if (byRequest) return byRequest;
      for (const active of activeByRequest.values()) {
        if (active.lease.leaseId === value) return active;
      }
    }
    return null;
  }

  function release(value) {
    const active = leaseFor(value);
    if (!active) return false;
    // A stale lease object must not release a newer lease for the same request.
    if (value && typeof value === "object"
      && typeof value.leaseId === "string"
      && value.leaseId !== active.lease.leaseId) return false;
    activeByRequest.delete(active.entry.requestId);
    const group = concurrencyGroups.get(active.entry.concurrencyGroup);
    if (group) group.active = Math.max(0, group.active - 1);
    for (const name of active.entry.resourceGroups) {
      const count = (resourceGroups.get(name) ?? 0) - 1;
      if (count > 0) resourceGroups.set(name, count);
      else resourceGroups.delete(name);
    }
    drain();
    return true;
  }

  function cancel(value) {
    const requestId = typeof value === "string"
      ? value
      : value && typeof value === "object" ? value.requestId : null;
    if (typeof requestId !== "string" || requestId.trim() === "") return false;
    const pending = pendingByRequest.get(requestId);
    if (!pending) return false;
    pendingByRequest.delete(requestId);
    const index = queue.indexOf(pending);
    if (index >= 0) queue.splice(index, 1);
    pending.reject(schedulerError("REQUEST_CANCELLED", "Resource request was cancelled before it started"));
    drain();
    return true;
  }

  function recover(input) {
    if (input === undefined || input === null) return snapshot();
    const entries = Array.isArray(input)
      ? input
      : Array.isArray(input.active) ? input.active : [input];
    const recovered = [];
    for (const candidate of entries) {
      const normalized = normalizeRequest(candidate);
      const active = activeByRequest.get(normalized.requestId);
      if (active) {
        recovered.push(active.lease);
        continue;
      }
      const pending = pendingByRequest.get(normalized.requestId);
      if (pending) {
        // External recovery is authoritative: remove the queued entry and let
        // the recovered lease represent the already-running request.
        pendingByRequest.delete(normalized.requestId);
        const index = queue.indexOf(pending);
        if (index >= 0) queue.splice(index, 1);
        pending.reject(schedulerError("REQUEST_RECOVERED", "Request was recovered while queued"));
      }
      recovered.push(grant({ ...normalized }, {
        leaseId: candidate.leaseId,
        grantedAt: candidate.grantedAt,
      }));
    }
    return Array.isArray(input) || Array.isArray(input.active) ? recovered : recovered[0];
  }

  function snapshot() {
    return {
      activeCount: activeByRequest.size,
      pendingCount: queue.length,
      active: [...activeByRequest.values()].map(({ lease }) => leaseView(lease)),
      pending: queue.map(({ requestId, concurrencyGroup, maxConcurrent, resourceGroups }) => ({
        requestId,
        concurrencyGroup,
        maxConcurrent,
        resourceGroups: [...resourceGroups],
      })),
      concurrencyGroups: [...concurrencyGroups.values()].map((group) => ({ ...group })),
      resourceGroups: [...resourceGroups.entries()].map(([name, active]) => ({ name, active })),
    };
  }

  function setConcurrencyLimit(name, maxConcurrent) {
    if (typeof name !== "string" || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) return false;
    const state = groupState(name, maxConcurrent);
    state.maxConcurrent = maxConcurrent;
    drain();
    return true;
  }

  return { request, release, cancel, recover, snapshot, wake: drain, setConcurrencyLimit };
}
