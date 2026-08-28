import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, link, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

import {
  ARTIFACT_UPLOAD_LEASE_DURATION_MS,
  parseArtifactUploadTimestamp,
} from "./artifact-upload-lease.mjs";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

class UploadFailure extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UploadFailure";
    this.code = code;
  }
}

function publicUpload(upload) {
  const { storageKey: _storageKey, targetPath: _targetPath, ...safe } = upload;
  return safe;
}

function safeFilename(filename) {
  return typeof filename === "string"
    && filename.length > 0
    && filename.length <= 240
    && filename !== "."
    && filename !== ".."
    && path.basename(filename) === filename
    && !/[<>:"/\\|?*\u0000-\u001f]/u.test(filename);
}

async function removeIfPresent(filename) {
  try {
    await unlink(filename);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function hashFile(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

async function destinationHash(filename) {
  try {
    const details = await stat(filename);
    if (!details.isFile()) {
      throw new UploadFailure("TARGET_FILE_CONFLICT", "The destination name is already in use");
    }
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return hashFile(filename);
}

async function writeStreamToTemporary(artifactService, storageKey, temporaryPath) {
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    const hash = createHash("sha256");
    const stream = artifactService.createDownloadStream(storageKey);
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
        if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) {
          throw new Error("Unable to write upload artifact");
        }
        offset += bytesWritten;
      }
    }
    return hash.digest("hex");
  } finally {
    await handle?.close();
  }
}

function hardLinkIsUnsupported(error) {
  return ["EPERM", "EXDEV", "EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code);
}

async function promoteTemporaryFile(temporary, destination, expectedHash, fileSystem = {}) {
  const linkFile = fileSystem.link ?? link;
  const copyFileImpl = fileSystem.copyFile ?? copyFile;
  const renameFile = fileSystem.rename ?? rename;
  const statFile = fileSystem.stat ?? stat;
  try {
    await linkFile(temporary, destination);
    return { created: true, identity: await statFile(destination) };
  } catch (error) {
    if (error?.code === "EEXIST") {
      const concurrentHash = await destinationHash(destination);
      if (concurrentHash === expectedHash) return { created: false, identity: null };
      throw new UploadFailure("TARGET_FILE_CONFLICT", "The destination already contains a different ZIP");
    }
    if (!hardLinkIsUnsupported(error)) throw error;
  }

  const publishTemporary = `${destination}.${randomUUID()}.part`;
  try {
    await copyFileImpl(temporary, publishTemporary, constants.COPYFILE_EXCL);
    const copiedHash = await hashFile(publishTemporary);
    if (copiedHash !== expectedHash) {
      throw new UploadFailure("ARTIFACT_HASH_MISMATCH", "The local ZIP no longer matches its verified checksum");
    }
    try {
      await renameFile(publishTemporary, destination);
      return { created: true, identity: await statFile(destination) };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const concurrentHash = await destinationHash(destination);
      if (concurrentHash === expectedHash) return { created: false, identity: null };
      throw new UploadFailure("TARGET_FILE_CONFLICT", "The destination already contains a different ZIP");
    }
  } catch (error) {
    throw error;
  } finally {
    await removeIfPresent(publishTemporary);
  }
}

async function copyArtifact(upload, artifactService, fileSystem = {}) {
  if (!safeFilename(upload.filename)) {
    throw new UploadFailure("INVALID_ARTIFACT_FILENAME", "The artifact filename is invalid");
  }
  if (
    typeof upload.targetPath !== "string"
    || upload.targetPath.includes("\0")
    || !path.isAbsolute(upload.targetPath)
  ) {
    throw new UploadFailure("TARGET_PATH_INVALID", "The configured upload destination is invalid");
  }

  const targetDirectory = path.resolve(upload.targetPath);
  const destination = path.join(targetDirectory, upload.filename);
  if (path.dirname(destination) !== targetDirectory) {
    throw new UploadFailure("INVALID_ARTIFACT_FILENAME", "The artifact filename is invalid");
  }

  try {
    await mkdir(targetDirectory, { recursive: true });
  } catch {
    throw new UploadFailure("TARGET_DIRECTORY_UNAVAILABLE", "The upload destination is unavailable");
  }

  let existingHash;
  try {
    existingHash = await destinationHash(destination);
  } catch (error) {
    if (error instanceof UploadFailure) throw error;
    throw new UploadFailure("TARGET_DIRECTORY_UNAVAILABLE", "The upload destination is unavailable");
  }
  if (existingHash === upload.sha256) return { destination, created: false, identity: null };
  if (existingHash !== null) {
    throw new UploadFailure("TARGET_FILE_CONFLICT", "The destination already contains a different ZIP");
  }

  const temporary = path.join(targetDirectory, `.${upload.filename}.${randomUUID()}.part`);
  try {
    let copiedHash;
    try {
      copiedHash = await writeStreamToTemporary(artifactService, upload.storageKey, temporary);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new UploadFailure("ARTIFACT_CONTENT_MISSING", "The verified ZIP is no longer available locally");
      }
      throw error;
    }
    if (copiedHash !== upload.sha256) {
      throw new UploadFailure("ARTIFACT_HASH_MISMATCH", "The local ZIP no longer matches its verified checksum");
    }

    const publication = await promoteTemporaryFile(temporary, destination, upload.sha256, fileSystem);
    return { destination, ...publication };
  } finally {
    await removeIfPresent(temporary);
  }
}

async function removePublishedFile(publication, expectedHash, fileSystem = {}) {
  if (!publication?.created || !publication.identity) return;
  const statFile = fileSystem.stat ?? stat;
  let current;
  try {
    current = await statFile(publication.destination);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    return;
  }
  if (current.dev !== publication.identity.dev || current.ino !== publication.identity.ino) return;
  try {
    if (await hashFile(publication.destination) === expectedHash) {
      await removeIfPresent(publication.destination);
    }
  } catch {
    // A failed cleanup is safer than deleting a file that may belong to another upload.
  }
}

function safeFailure(error) {
  if (error instanceof UploadFailure) return error;
  return new UploadFailure("UPLOAD_COPY_FAILED", "The ZIP upload could not be completed");
}

export function createArtifactUploadWorker({
  database,
  artifactService,
  onUpdate = () => {},
  validateTaskForCompletion = null,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  fileSystem = {},
} = {}) {
  if (!database || typeof database.claimNextArtifactUpload !== "function") {
    throw new TypeError("database is required");
  }
  if (!artifactService || typeof artifactService.createDownloadStream !== "function") {
    throw new TypeError("artifactService is required");
  }

  let closed = false;
  let drainPromise = null;
  let wakeRequested = false;
  let wakeWaiter = null;
  let leaseTimer = null;
  // A lease can expire while its original stream is still being consumed. Keep
  // each claim alive independently so a re-claimed upload cannot hide the old
  // promise or have it remove the new claim from the active set.
  const active = new Map();

  function publish(upload) {
    if (!upload) return;
    try {
      onUpdate(publicUpload(upload));
    } catch (error) {
      console.error("Artifact upload update subscriber failed", error);
    }
  }

  async function processUpload(upload) {
    publish(upload);
    const renewal = startLeaseRenewal(upload);
    try {
      const publication = await copyArtifact(upload, artifactService, fileSystem);
      const completed = database.markArtifactUploadUploaded(
        upload.id,
        upload.claimToken,
        validateTaskForCompletion,
      );
      if (completed?.status === "failed" && completed.errorCode === "TASK_PROVENANCE_CHANGED") {
        await removePublishedFile(publication, upload.sha256, fileSystem);
      }
      publish(completed);
    } catch (error) {
      const failure = safeFailure(error);
      publish(database.markArtifactUploadFailed(upload.id, upload.claimToken, failure));
    } finally {
      renewal.stop();
    }
  }

  function startLeaseRenewal(upload) {
    if (typeof database.renewArtifactUploadLease !== "function") {
      return { stop() {} };
    }
    const intervalMs = Math.max(1, Math.floor(ARTIFACT_UPLOAD_LEASE_DURATION_MS / 3));
    let timer = null;
    let stopped = false;
    const schedule = () => {
      if (stopped || closed) return;
      timer = setTimer(() => {
        timer = null;
        if (stopped || closed) return;
        try {
          const renewed = database.renewArtifactUploadLease(upload.id, upload.claimToken);
          if (renewed === null) {
            stopped = true;
            return;
          }
        } catch (error) {
          console.error(
            `Artifact upload lease renewal failed: ${error?.code ?? "UPLOAD_LEASE_RENEWAL_FAILED"}`,
          );
        }
        schedule();
      }, intervalMs);
      timer.unref?.();
    };
    schedule();
    return {
      stop() {
        stopped = true;
        if (timer) clearTimer(timer);
        timer = null;
      },
    };
  }

  function scheduleLeaseRecovery() {
    if (leaseTimer) clearTimer(leaseTimer);
    leaseTimer = null;
    if (closed) return;

    const leaseExpiry = database.getNextArtifactUploadLeaseExpiry();
    if (!leaseExpiry) return;
    const leaseExpiryMs = parseArtifactUploadTimestamp(leaseExpiry);
    if (leaseExpiryMs === null) return;
    const delay = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(0, leaseExpiryMs - now()),
    );
    leaseTimer = setTimer(() => {
      leaseTimer = null;
      if (closed) return;
      try {
        const recovered = database.recoverUploadingArtifactUploads();
        scheduleLeaseRecovery();
        if (recovered > 0) void wake();
      } catch (error) {
        console.error(
          `Artifact upload lease recovery failed: ${error?.code ?? "UPLOAD_LEASE_RECOVERY_FAILED"}`,
        );
      }
    }, delay);
    leaseTimer.unref?.();
  }

  async function waitForProgress() {
    let resolveWake;
    const wakePromise = new Promise((resolve) => { resolveWake = resolve; });
    const waiter = { resolve: resolveWake };
    wakeWaiter = waiter;
    if (closed || wakeRequested) waiter.resolve();
    try {
      await Promise.race([...active.values(), wakePromise]);
    } finally {
      if (wakeWaiter === waiter) wakeWaiter = null;
    }
  }

  async function drain() {
    try {
      while (!closed) {
        wakeRequested = false;
        let upload;
        while (!closed && (upload = database.claimNextArtifactUpload())) {
          const running = processUpload(upload);
          const claimKey = upload.claimToken || `${upload.id}:${randomUUID()}`;
          active.set(claimKey, running);
          scheduleLeaseRecovery();
          void running.then(
            () => {
              if (active.get(claimKey) === running) active.delete(claimKey);
              scheduleLeaseRecovery();
            },
            () => {
              if (active.get(claimKey) === running) active.delete(claimKey);
              scheduleLeaseRecovery();
            },
          );
        }
        if (wakeRequested) continue;
        if (active.size === 0) {
          return;
        }
        await waitForProgress();
      }
    } finally {
      await Promise.allSettled([...active.values()]);
    }
  }

  function wake() {
    if (closed) return Promise.resolve();
    wakeRequested = true;
    wakeWaiter?.resolve();
    database.recoverUploadingArtifactUploads();
    scheduleLeaseRecovery();
    if (!drainPromise) {
      const running = drain();
      drainPromise = running;
      void running.then(
        () => {
          if (drainPromise !== running) return;
          drainPromise = null;
          if (!closed && wakeRequested) void wake();
        },
        () => {
          if (drainPromise === running) drainPromise = null;
        },
      );
    }
    return drainPromise;
  }

  function start() {
    if (closed) return Promise.resolve();
    return wake();
  }

  async function close() {
    closed = true;
    if (leaseTimer) clearTimer(leaseTimer);
    leaseTimer = null;
    wakeWaiter?.resolve();
    await drainPromise;
    await Promise.allSettled([...active.values()]);
  }

  return { close, start, wake };
}
