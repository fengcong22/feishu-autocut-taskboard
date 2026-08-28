import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TextDecoder } from "node:util";
import { crc32, createInflateRaw } from "node:zlib";

import { ApiError } from "./database.mjs";

const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_FILE_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_CENTRAL_DIRECTORY_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_NAME_BYTES = 4_096;
const MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const MAX_DRAFT_JSON_BYTES = 64 * 1024 * 1024;

export class ArtifactServiceError extends ApiError {
  constructor(status, code, message) {
    super(status, code, message);
    this.name = "ArtifactServiceError";
  }
}

function artifactError(status, code, message) {
  return new ArtifactServiceError(status, code, message);
}

function safeStorageKey(value) {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/i.test(value)) {
    throw artifactError(500, "INVALID_ARTIFACT_STORAGE", "Artifact storage is unavailable");
  }
  return value;
}

function draftRootForEntry(name, expectedFilename) {
  const parts = name.split("/");
  if (parts.at(-1).toLowerCase() !== expectedFilename) return null;
  return parts.slice(0, -1).join("/");
}

function normalizeEntryName(rawName) {
  if (!rawName || Buffer.byteLength(rawName, "utf8") > MAX_NAME_BYTES) {
    throw artifactError(400, "INVALID_ZIP_ENTRY", "ZIP contains an invalid entry path");
  }
  if (/\uFFFD|[\u0000-\u001f\u007f]/u.test(rawName)) {
    throw artifactError(400, "INVALID_ZIP_ENTRY", "ZIP contains an invalid entry path");
  }
  const normalized = rawName.replaceAll("\\", "/");
  const name = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  if (
    !name
    || normalized.startsWith("/")
    || /^[A-Za-z]:\//u.test(normalized)
    || name.split("/").some((part) => part === "." || part === ".." || part === "")
  ) {
    throw artifactError(400, "INVALID_ZIP_ENTRY", "ZIP contains an invalid entry path");
  }
  return name;
}

async function readExactly(handle, length, position) {
  if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(position) || position < 0) {
    throw artifactError(400, "INVALID_ZIP", "ZIP structure is invalid");
  }
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw artifactError(400, "INVALID_ZIP", "ZIP is truncated");
    offset += bytesRead;
  }
  return buffer;
}

function locateEndOfCentralDirectory(tail, tailOffset, size) {
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) !== ZIP_END_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(index + 20);
    if (index + 22 + commentLength !== tail.length) continue;
    const diskNumber = tail.readUInt16LE(index + 4);
    const centralDirectoryDisk = tail.readUInt16LE(index + 6);
    const entriesOnDisk = tail.readUInt16LE(index + 8);
    const entryCount = tail.readUInt16LE(index + 10);
    const centralDirectorySize = tail.readUInt32LE(index + 12);
    const centralDirectoryOffset = tail.readUInt32LE(index + 16);
    if (
      diskNumber !== 0
      || centralDirectoryDisk !== 0
      || entriesOnDisk !== entryCount
      || entryCount === 0xffff
      || centralDirectorySize === 0xffffffff
      || centralDirectoryOffset === 0xffffffff
    ) {
      throw artifactError(400, "UNSUPPORTED_ZIP", "ZIP64 and multi-disk ZIP files are not supported");
    }
    const endOffset = tailOffset + index;
    if (
      entryCount > MAX_ENTRIES
      || centralDirectorySize > MAX_CENTRAL_DIRECTORY_BYTES
      || centralDirectoryOffset + centralDirectorySize > endOffset
      || endOffset + 22 + commentLength !== size
    ) {
      throw artifactError(400, "INVALID_ZIP", "ZIP central directory is invalid");
    }
    return { entryCount, centralDirectorySize, centralDirectoryOffset };
  }
  if (tail.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])) || tail.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07]))) {
    throw artifactError(400, "UNSUPPORTED_ZIP", "ZIP64 and multi-disk ZIP files are not supported");
  }
  throw artifactError(400, "INVALID_ZIP", "ZIP central directory is missing");
}

function validateEntryMetrics(compressedSize, uncompressedSize) {
  if (uncompressedSize > MAX_UNCOMPRESSED_BYTES) {
    throw artifactError(400, "INVALID_ZIP", "ZIP uncompressed content is too large");
  }
  const permittedUncompressed = (compressedSize * MAX_COMPRESSION_RATIO) + (1024 * 1024);
  if (uncompressedSize > permittedUncompressed) {
    throw artifactError(400, "INVALID_ZIP", "ZIP compression ratio is too large");
  }
}

function invalidZipPayload() {
  return artifactError(400, "INVALID_ZIP", "ZIP entry payload is invalid");
}

function invalidDraftJson() {
  return artifactError(
    400,
    "INVALID_DRAFT_ZIP",
    "draft_content.json and draft_meta_info.json must contain valid UTF-8 JSON",
  );
}

function validateDraftJson(bytes) {
  if (bytes.length === 0) throw invalidDraftJson();
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    JSON.parse(text);
  } catch {
    throw invalidDraftJson();
  }
}

async function validateEntryPayload(filename, entry, state, captureDraftJson) {
  if (captureDraftJson && entry.uncompressedSize > MAX_DRAFT_JSON_BYTES) {
    throw invalidDraftJson();
  }
  if (entry.compression === 8 && entry.compressedSize === 0) {
    throw invalidZipPayload();
  }

  let actualSize = 0;
  let actualCrc32 = 0;
  const chunks = [];
  const permittedUncompressed = (entry.compressedSize * MAX_COMPRESSION_RATIO) + (1024 * 1024);
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      actualSize += chunk.length;
      state.totalUncompressed += chunk.length;
      if (
        actualSize > entry.uncompressedSize
        || actualSize > permittedUncompressed
        || state.totalUncompressed > MAX_UNCOMPRESSED_BYTES
      ) {
        callback(invalidZipPayload());
        return;
      }
      if (captureDraftJson && actualSize > MAX_DRAFT_JSON_BYTES) {
        callback(invalidDraftJson());
        return;
      }
      actualCrc32 = crc32(chunk, actualCrc32);
      if (captureDraftJson) chunks.push(Buffer.from(chunk));
      callback();
    },
  });

  if (entry.compressedSize > 0) {
    const source = createReadStream(filename, {
      start: entry.dataOffset,
      end: entry.dataOffset + entry.compressedSize - 1,
    });
    try {
      if (entry.compression === 8) {
        const inflater = createInflateRaw();
        await pipeline(source, inflater, sink);
        if (inflater.bytesWritten !== entry.compressedSize) throw invalidZipPayload();
      } else {
        await pipeline(source, sink);
      }
    } catch (error) {
      if (error instanceof ArtifactServiceError) throw error;
      throw invalidZipPayload();
    }
  }

  if (actualSize !== entry.uncompressedSize || actualCrc32 !== entry.expectedCrc32) {
    throw invalidZipPayload();
  }
  return captureDraftJson ? Buffer.concat(chunks, actualSize) : null;
}

async function parseZipFile(filename) {
  const details = await stat(filename);
  if (!details.isFile() || details.size < 22) {
    throw artifactError(400, "INVALID_ZIP", "Artifact is not a valid ZIP file");
  }
  const handle = await open(filename, "r");
  try {
    const tailLength = Math.min(details.size, 22 + 65_535 + 20);
    const tailOffset = details.size - tailLength;
    const tail = await readExactly(handle, tailLength, tailOffset);
    const directory = locateEndOfCentralDirectory(tail, tailOffset, details.size);
    const central = await readExactly(
      handle,
      directory.centralDirectorySize,
      directory.centralDirectoryOffset,
    );
    const entries = [];
    const names = new Set();
    let totalUncompressed = 0;
    let offset = 0;

    for (let index = 0; index < directory.entryCount; index += 1) {
      if (offset + 46 > central.length || central.readUInt32LE(offset) !== ZIP_CENTRAL_FILE_SIGNATURE) {
        throw artifactError(400, "INVALID_ZIP", "ZIP central directory entry is invalid");
      }
      const flags = central.readUInt16LE(offset + 8);
      const compression = central.readUInt16LE(offset + 10);
      const expectedCrc32 = central.readUInt32LE(offset + 16);
      const compressedSize = central.readUInt32LE(offset + 20);
      const uncompressedSize = central.readUInt32LE(offset + 24);
      const nameLength = central.readUInt16LE(offset + 28);
      const extraLength = central.readUInt16LE(offset + 30);
      const commentLength = central.readUInt16LE(offset + 32);
      const diskNumber = central.readUInt16LE(offset + 34);
      const localOffset = central.readUInt32LE(offset + 42);
      const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
      if (entryEnd > central.length) {
        throw artifactError(400, "INVALID_ZIP", "ZIP central directory entry is truncated");
      }
      if (
        flags & 0x1
        || diskNumber !== 0
        || compressedSize === 0xffffffff
        || uncompressedSize === 0xffffffff
        || localOffset === 0xffffffff
      ) {
        throw artifactError(400, "UNSUPPORTED_ZIP", "Encrypted, ZIP64, and multi-disk ZIP files are not supported");
      }
      if (compression !== 0 && compression !== 8) {
        throw artifactError(400, "UNSUPPORTED_ZIP", "ZIP uses an unsupported compression method");
      }
      const rawName = central.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
      const name = normalizeEntryName(rawName);
      if (!name) {
        throw artifactError(400, "INVALID_ZIP_ENTRY", "ZIP contains an invalid entry path");
      }
      const normalizedKey = name.toLowerCase();
      if (names.has(normalizedKey)) {
        throw artifactError(400, "INVALID_ZIP_ENTRY", "ZIP contains duplicate entry paths");
      }
      names.add(normalizedKey);
      validateEntryMetrics(compressedSize, uncompressedSize);
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
        throw artifactError(400, "INVALID_ZIP", "ZIP uncompressed content is too large");
      }

      if (localOffset + 30 > directory.centralDirectoryOffset) {
        throw artifactError(400, "INVALID_ZIP", "ZIP local entry is invalid");
      }
      const localHeader = await readExactly(handle, 30, localOffset);
      if (localHeader.readUInt32LE(0) !== ZIP_LOCAL_FILE_SIGNATURE) {
        throw artifactError(400, "INVALID_ZIP", "ZIP local entry is invalid");
      }
      const localFlags = localHeader.readUInt16LE(6);
      const localCompression = localHeader.readUInt16LE(8);
      const localCrc32 = localHeader.readUInt32LE(14);
      const localCompressedSize = localHeader.readUInt32LE(18);
      const localUncompressedSize = localHeader.readUInt32LE(22);
      const localNameLength = localHeader.readUInt16LE(26);
      const localExtraLength = localHeader.readUInt16LE(28);
      const localNameOffset = localOffset + 30;
      const dataOffset = localNameOffset + localNameLength + localExtraLength;
      if (
        localFlags & 0x1
        || localFlags !== flags
        || localCompression !== compression
        || (!(flags & 0x8) && (
          localCrc32 !== expectedCrc32
          || localCompressedSize !== compressedSize
          || localUncompressedSize !== uncompressedSize
        ))
        || dataOffset + compressedSize > directory.centralDirectoryOffset
      ) {
        throw artifactError(400, "INVALID_ZIP", "ZIP local entry is invalid");
      }
      const localName = normalizeEntryName(
        (await readExactly(handle, localNameLength, localNameOffset)).toString("utf8"),
      );
      if (localName !== name) {
        throw artifactError(400, "INVALID_ZIP", "ZIP entry names do not match");
      }
      entries.push({
        name,
        isDirectory: rawName.endsWith("/"),
        compression,
        expectedCrc32,
        compressedSize,
        uncompressedSize,
        dataOffset,
      });
      offset = entryEnd;
    }
    if (offset !== central.length || entries.length === 0) {
      throw artifactError(400, "INVALID_ZIP", "ZIP contains no valid entries");
    }

    const contentRoots = new Set(entries.flatMap((entry) => {
      if (entry.isDirectory) return [];
      const root = draftRootForEntry(entry.name, "draft_content.json");
      return root === null ? [] : [root];
    }));
    const draftRoot = entries.flatMap((entry) => {
      if (entry.isDirectory) return [];
      const root = draftRootForEntry(entry.name, "draft_meta_info.json");
      return root !== null && contentRoots.has(root) ? [root] : [];
    })[0];
    if (draftRoot === undefined) {
      throw artifactError(
        400,
        "INVALID_DRAFT_ZIP",
        "ZIP must contain draft_content.json and draft_meta_info.json in the same draft folder",
      );
    }

    const validationState = { totalUncompressed: 0 };
    for (const entry of entries) {
      const draftFilename = ["draft_content.json", "draft_meta_info.json"].find(
        (expectedFilename) => draftRootForEntry(entry.name, expectedFilename) === draftRoot,
      );
      const draftJson = await validateEntryPayload(
        filename,
        entry,
        validationState,
        !entry.isDirectory && draftFilename !== undefined,
      );
      if (draftJson !== null) validateDraftJson(draftJson);
    }
    return { entryCount: entries.length, draftRoot };
  } finally {
    await handle.close();
  }
}

async function removeIfPresent(filename) {
  try {
    await unlink(filename);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function writeFully(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) {
      throw new Error("Unable to write artifact data");
    }
    offset += bytesWritten;
  }
}

export function createArtifactService({ rootDirectory, now = () => new Date().toISOString() } = {}) {
  if (typeof rootDirectory !== "string" || !path.isAbsolute(rootDirectory)) {
    throw new TypeError("rootDirectory must be an absolute path");
  }
  const root = path.resolve(rootDirectory);

  function filenameFor(storageKey) {
    return path.join(root, safeStorageKey(storageKey));
  }

  async function acceptUpload({ filename, contentType, stream }) {
    if (typeof filename !== "string" || !filename.toLowerCase().endsWith(".zip")) {
      throw artifactError(400, "INVALID_ARTIFACT_TYPE", "Artifact must be a .zip file");
    }
    if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
      throw new TypeError("Artifact stream is required");
    }
    await mkdir(root, { recursive: true });
    const id = randomUUID();
    const storageKey = randomUUID();
    const destination = filenameFor(storageKey);
    const temporary = `${destination}.part`;
    const hash = createHash("sha256");
    let size = 0;
    const handle = await open(temporary, "wx");
    try {
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_ARTIFACT_BYTES) {
          throw artifactError(413, "ARTIFACT_TOO_LARGE", "ZIP artifact cannot exceed 20 GiB");
        }
        hash.update(bytes);
        await writeFully(handle, bytes);
      }
      if (size === 0) throw artifactError(400, "EMPTY_ARTIFACT", "ZIP artifact cannot be empty");
    } catch (error) {
      await handle.close();
      await removeIfPresent(temporary);
      throw error;
    }
    await handle.close();
    try {
      const validation = await parseZipFile(temporary);
      await rename(temporary, destination);
      const timestamp = now();
      return {
        id,
        storageKey,
        filename,
        contentType: contentType || "application/zip",
        size,
        sha256: hash.digest("hex"),
        sourceMode: "manual_select",
        validationStatus: "verified",
        entryCount: validation.entryCount,
        draftRoot: validation.draftRoot,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    } catch (error) {
      await removeIfPresent(temporary);
      await removeIfPresent(destination);
      throw error;
    }
  }

  async function removeStoredArtifact(storageKey) {
    await removeIfPresent(filenameFor(storageKey));
  }

  async function getStoredArtifactStats(storageKey) {
    try {
      return await stat(filenameFor(storageKey));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  function createDownloadStream(storageKey) {
    return createReadStream(filenameFor(storageKey));
  }

  return {
    acceptUpload,
    createDownloadStream,
    getStoredArtifactStats,
    removeStoredArtifact,
  };
}
