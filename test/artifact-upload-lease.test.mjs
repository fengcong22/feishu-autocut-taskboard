import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import {
  ARTIFACT_UPLOAD_LEASE_DURATION_MS,
} from "../server/artifact-upload-lease.mjs";
import { TaskboardDatabase } from "../server/database.mjs";
import { createArtifactUploadWorker } from "../server/upload-worker.mjs";

const actor = {
  type: "user",
  id: "local-user",
  name: "Local User",
  avatarUrl: null,
};

async function createUploadLeaseFixture({ count = 8, uploadConcurrency = 7 } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-upload-lease-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  database.createProject({ id: "lease-project", name: "Lease Project", workspacePath: null });

  const timestamp = new Date().toISOString();
  database.database.prepare(`
    INSERT INTO feishu_bases (
      base_token, base_name, source_url_label, metadata_refreshed_at, created_at, updated_at
    ) VALUES (?, ?, NULL, NULL, ?, ?)
  `).run("base-lease", "Lease Base", timestamp, timestamp);
  database.database.prepare(`
    INSERT INTO feishu_subjects (
      subject_key, base_token, table_id, table_name, project_id, display_enabled,
      lifecycle, config_version, config_json, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, 'enabled', 1, '{}', '{}', ?, ?)
  `).run(
    "base-lease:table-lease",
    "base-lease",
    "table-lease",
    "Lease Subject",
    "lease-project",
    timestamp,
    timestamp,
  );

  const uploads = [];
  for (let index = 0; index < count; index += 1) {
    const task = database.createTask({
      projectId: "lease-project",
      title: `Lease task ${index}`,
      description: "",
      status: "done",
      priority: "none",
      labels: [],
      actor,
      assignee: actor,
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    const artifact = database.createTaskArtifact(task.id, {
      id: `artifact-${index}`,
      storageKey: `storage-${index}`,
      filename: `draft-${index}.zip`,
      contentType: "application/zip",
      size: 1,
      sha256: `${index}`.repeat(64),
      sourceMode: "manual_select",
      validationStatus: "verified",
      entryCount: 2,
      draftRoot: "draft",
      createdAt: timestamp,
      updatedAt: timestamp,
      actor,
    });
    uploads.push(database.createArtifactUpload({
      taskId: task.id,
      artifactId: artifact.id,
      subjectKey: "base-lease:table-lease",
      storageKey: `storage-${index}`,
      targetId: "lease-target",
      targetPath: path.join(directory, "target"),
      filename: artifact.filename,
      sha256: artifact.sha256,
      uploadConcurrency,
    }));
  }

  return {
    database,
    directory,
    uploads,
    async close() {
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("invalid, missing, expired, and unreasonably future upload leases release subject slots", async () => {
  const fixture = await createUploadLeaseFixture();
  try {
    const validClaim = fixture.database.claimNextArtifactUpload();
    assert.equal(validClaim.id, fixture.uploads[0].id);
    const validLease = fixture.database.database.prepare(
      "SELECT lease_until FROM artifact_uploads WHERE id = ?",
    ).get(validClaim.id).lease_until;
    assert.match(validLease, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);

    const setUploading = fixture.database.database.prepare(`
      UPDATE artifact_uploads
      SET status = 'uploading', claim_token = ?, lease_until = ?
      WHERE id = ?
    `);
    setUploading.run("claim-invalid", "not-a-date", fixture.uploads[1].id);
    setUploading.run("claim-future", "9999-12-31T23:59:59.999Z", fixture.uploads[2].id);
    setUploading.run("claim-missing", null, fixture.uploads[3].id);
    setUploading.run("claim-expired", "2000-01-01T00:00:00.000Z", fixture.uploads[4].id);
    const futureIso = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    setUploading.run("claim-no-zone", futureIso.replace("T", " ").replace("Z", ""), fixture.uploads[5].id);
    const julian = String(fixture.database.database.prepare(
      "SELECT julianday(?) AS value",
    ).get(futureIso).value);
    setUploading.run("claim-julian", julian, fixture.uploads[6].id);

    assert.equal(fixture.database.claimNextArtifactUpload(), null);
    assert.equal(fixture.database.recoverUploadingArtifactUploads(), 6);
    assert.equal(fixture.database.getArtifactUpload(fixture.uploads[0].id).status, "uploading");
    assert.ok(fixture.database.claimNextArtifactUpload());
  } finally {
    await fixture.close();
  }
});

test("a default upload lease survives a small backwards clock adjustment", async () => {
  const fixture = await createUploadLeaseFixture({ count: 2, uploadConcurrency: 1 });
  const originalDateNow = Date.now;
  try {
    const claimed = fixture.database.claimNextArtifactUpload();
    const row = fixture.database.database.prepare(
      "SELECT started_at, lease_until FROM artifact_uploads WHERE id = ?",
    ).get(claimed.id);
    Date.now = () => Date.parse(row.started_at) - 1;
    assert.equal(fixture.database.recoverUploadingArtifactUploads(), 0);
    assert.equal(fixture.database.getArtifactUpload(claimed.id).status, "uploading");
  } finally {
    Date.now = originalDateNow;
    await fixture.close();
  }
});

test("renews an owned upload lease and fences stale claims", async () => {
  const fixture = await createUploadLeaseFixture({ count: 1, uploadConcurrency: 1 });
  try {
    const claimed = fixture.database.claimNextArtifactUpload();
    const original = fixture.database.database.prepare(
      "SELECT lease_until FROM artifact_uploads WHERE id = ?",
    ).get(claimed.id).lease_until;
    const renewed = fixture.database.renewArtifactUploadLease(
      claimed.id,
      claimed.claimToken,
    );
    assert.ok(renewed);
    const renewedLease = fixture.database.database.prepare(
      "SELECT lease_until FROM artifact_uploads WHERE id = ?",
    ).get(claimed.id).lease_until;
    assert.ok(Date.parse(renewedLease) > Date.parse(original));
    assert.equal(
      fixture.database.renewArtifactUploadLease(claimed.id, "stale-claim"),
      null,
    );
    assert.equal(
      fixture.database.getArtifactUpload(claimed.id).status,
      "uploading",
    );
  } finally {
    await fixture.close();
  }
});

test("an invalid upload lease cannot schedule a rapid recovery loop", async () => {
  let recoveryCalls = 0;
  const timers = [];
  const database = {
    claimNextArtifactUpload() { return null; },
    getNextArtifactUploadLeaseExpiry() { return "not-a-date"; },
    recoverUploadingArtifactUploads() {
      recoveryCalls += 1;
      return 0;
    },
  };
  const worker = createArtifactUploadWorker({
    database,
    artifactService: {
      createDownloadStream() {
        throw new Error("No upload should be claimed");
      },
    },
    now: () => 1_800_000_000_000,
    setTimer(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer() {},
  });

  try {
    await worker.start();
    assert.ok(recoveryCalls <= 2, `expected at most two recoveries, received ${recoveryCalls}`);
    assert.equal(timers.length, 0);
  } finally {
    await worker.close();
  }
});

test("worker schedules a canonical lease against its injected clock", async () => {
  const now = 1_800_000_000_000;
  const timers = [];
  const worker = createArtifactUploadWorker({
    database: {
      claimNextArtifactUpload() { return null; },
      getNextArtifactUploadLeaseExpiry() { return new Date(now + 2_500).toISOString(); },
      recoverUploadingArtifactUploads() { return 0; },
    },
    artifactService: {
      createDownloadStream() { throw new Error("No upload should be claimed"); },
    },
    now: () => now,
    setTimer(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer() {},
  });
  try {
    await worker.start();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 2_500);
  } finally {
    await worker.close();
  }
});

test("worker renews an active upload before its lease expires", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-upload-lease-renew-"));
  const targetPath = path.join(directory, "target");
  const bytes = Buffer.from("renewed upload bytes", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let releaseCopy;
  const copyGate = new Promise((resolve) => { releaseCopy = resolve; });
  let signalCopyStarted;
  const copyStarted = new Promise((resolve) => { signalCopyStarted = resolve; });
  let claimed = false;
  const renewals = [];
  const timers = [];
  const database = {
    claimNextArtifactUpload() {
      if (claimed) return null;
      claimed = true;
      return {
        id: "upload-renewed",
        claimToken: "claim-renewed",
        filename: "renewed.zip",
        targetPath,
        storageKey: "artifact-renewed",
        sha256,
      };
    },
    getNextArtifactUploadLeaseExpiry() { return null; },
    recoverUploadingArtifactUploads() { return 0; },
    renewArtifactUploadLease(id, claimToken) {
      renewals.push({ id, claimToken });
      return { id, claimToken, status: "uploading" };
    },
    markArtifactUploadUploaded(id, claimToken) {
      return { id, claimToken, status: "uploaded" };
    },
    markArtifactUploadFailed() {
      throw new Error("the fixture should not fail an upload");
    },
  };
  const worker = createArtifactUploadWorker({
    database,
    artifactService: {
      createDownloadStream() {
        return (async function* gatedStream() {
          signalCopyStarted();
          await copyGate;
          yield bytes;
        }());
      },
    },
    setTimer(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer() {},
  });

  try {
    const started = worker.start();
    await copyStarted;
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, Math.floor(ARTIFACT_UPLOAD_LEASE_DURATION_MS / 3));
    timers[0].callback();
    for (let attempt = 0; attempt < 20 && renewals.length === 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(renewals, [{ id: "upload-renewed", claimToken: "claim-renewed" }]);
    releaseCopy();
    await started;
  } finally {
    releaseCopy?.();
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("worker restart reclaims an expired lease and completes the persisted upload", async () => {
  const fixture = await createUploadLeaseFixture({ count: 1, uploadConcurrency: 1 });
  const bytes = Buffer.from("persisted upload after lease recovery", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const targetPath = path.join(fixture.directory, "recovered-target");
  const upload = fixture.uploads[0];
  fixture.database.database.prepare(
    "UPDATE task_artifacts SET sha256 = ? WHERE id = ?",
  ).run(sha256, upload.artifactId);
  fixture.database.database.prepare(`
    UPDATE artifact_uploads
    SET sha256 = ?, target_path = ?, status = 'uploading', claim_token = 'crashed-worker',
        started_at = '2000-01-01T00:00:00.000Z', lease_until = '2000-01-01T00:15:00.000Z'
    WHERE id = ?
  `).run(sha256, targetPath, upload.id);
  const worker = createArtifactUploadWorker({
    database: fixture.database,
    artifactService: { createDownloadStream: () => Readable.from([bytes]) },
  });
  try {
    await worker.start();
    assert.equal(fixture.database.getArtifactUpload(upload.id).status, "uploaded");
    assert.deepEqual(await readFile(path.join(targetPath, upload.filename)), bytes);
  } finally {
    await worker.close();
    await fixture.close();
  }
});

test("worker fences and reclaims an expired lease while the original upload is still active", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-upload-lease-fence-"));
  const targetPath = path.join(directory, "target");
  const bytes = Buffer.from("same upload bytes", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let releaseOriginal;
  const originalGate = new Promise((resolve) => { releaseOriginal = resolve; });
  let signalOriginalStarted;
  const originalStarted = new Promise((resolve) => { signalOriginalStarted = resolve; });
  let claimCount = 0;
  let recovered = false;
  const recoveryArguments = [];
  const completionClaims = [];
  const upload = (claimToken) => ({
    id: "upload-fenced",
    claimToken,
    filename: "fenced.zip",
    targetPath,
    storageKey: "artifact-fenced",
    sha256,
  });
  const database = {
    claimNextArtifactUpload() {
      if (claimCount === 0) {
        claimCount += 1;
        return upload("old-claim");
      }
      if (recovered && claimCount === 1) {
        claimCount += 1;
        return upload("new-claim");
      }
      return null;
    },
    getNextArtifactUploadLeaseExpiry(excludedIds = []) {
      recoveryArguments.push({ method: "expiry", excludedIds });
      if (!recovered && claimCount > 0) return new Date(2_000).toISOString();
      return null;
    },
    recoverUploadingArtifactUploads(excludedIds = []) {
      recoveryArguments.push({ method: "recover", excludedIds });
      if (
        !recovered
        && claimCount > 0
        && !excludedIds.includes("upload-fenced")
      ) {
        recovered = true;
        return 1;
      }
      return 0;
    },
    markArtifactUploadUploaded(id, claimToken) {
      completionClaims.push({ id, claimToken });
      return claimToken === "new-claim"
        ? { id, claimToken, status: "uploaded" }
        : null;
    },
    markArtifactUploadFailed() {
      throw new Error("the fixture should not fail an upload");
    },
  };
  const timers = [];
  const worker = createArtifactUploadWorker({
    database,
    artifactService: {
      createDownloadStream() {
        if (claimCount === 1 && !recovered) {
          return (async function* gatedStream() {
            signalOriginalStarted();
            await originalGate;
            yield bytes;
          }());
        }
        return Readable.from([bytes]);
      },
    },
    now: () => 1_000,
    setTimer(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer() {},
  });

  try {
    const started = worker.start();
    for (let attempt = 0; attempt < 20 && timers.length === 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 1_000);
    await originalStarted;

    timers[0].callback();
    for (let attempt = 0; attempt < 20 && claimCount < 2; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(claimCount, 2, "an expired active lease should be reclaimed");
    assert.ok(recoveryArguments.some((entry) => entry.method === "recover" && entry.excludedIds.length === 0));

    releaseOriginal();
    await started;
    assert.deepEqual(
      completionClaims.toSorted((left, right) => left.claimToken.localeCompare(right.claimToken)),
      [
        { id: "upload-fenced", claimToken: "new-claim" },
        { id: "upload-fenced", claimToken: "old-claim" },
      ],
    );
  } finally {
    releaseOriginal?.();
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("fallback copy interruption never leaves a partial destination ZIP", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-upload-atomic-fallback-"));
  const targetPath = path.join(directory, "target");
  const bytes = Buffer.from("atomic fallback upload bytes", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let claimed = false;
  let failure = null;
  const database = {
    claimNextArtifactUpload() {
      if (claimed) return null;
      claimed = true;
      return {
        id: "upload-atomic-fallback",
        claimToken: "claim-atomic-fallback",
        filename: "fallback.zip",
        targetPath,
        storageKey: "artifact-atomic-fallback",
        sha256,
      };
    },
    getNextArtifactUploadLeaseExpiry() { return null; },
    recoverUploadingArtifactUploads() { return 0; },
    markArtifactUploadFailed(id, claimToken, error) {
      failure = { id, claimToken, ...error };
      return { id, claimToken, status: "failed", errorCode: error.code };
    },
    markArtifactUploadUploaded() {
      throw new Error("the interrupted copy must not complete");
    },
  };
  const worker = createArtifactUploadWorker({
    database,
    artifactService: { createDownloadStream: () => Readable.from([bytes]) },
    fileSystem: {
      async link() { throw Object.assign(new Error("hard links unavailable"), { code: "EXDEV" }); },
      async copyFile(_source, destination) {
        await writeFile(destination, bytes.subarray(0, 5));
        throw new Error("simulated NAS interruption");
      },
      async rename() {
        throw new Error("rename should not run after an interrupted copy");
      },
    },
  });
  try {
    await worker.start();
    assert.equal(failure?.code, "UPLOAD_COPY_FAILED");
    await assert.rejects(access(path.join(targetPath, "fallback.zip")));
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});
