import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { crc32, deflateRawSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createArtifactService } from "../server/artifact-service.mjs";
import { createStoredZip } from "./stored-zip-fixture.mjs";

function createDeflatedZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const { name, content } of entries) {
    const filename = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const compressed = deflateRawSync(data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    localParts.push(local, filename, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, filename);
    localOffset += local.length + filename.length + compressed.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, central, end]);
}

test("artifact service stores a verified ZIP with a SHA-256 checksum", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-artifact-service-"));
  try {
    const service = createArtifactService({ rootDirectory: directory });
    const zip = createStoredZip([
      { name: "draft/draft_content.json", content: "{}" },
      { name: "draft/draft_meta_info.json", content: "{}" },
    ]);
    const artifact = await service.acceptUpload({
      filename: "剪映草稿.zip",
      contentType: "application/zip",
      stream: Readable.from([zip]),
    });
    assert.equal(artifact.validationStatus, "verified");
    assert.equal(artifact.sha256, createHash("sha256").update(zip).digest("hex"));
    assert.equal((await readdir(directory)).length, 1);
    assert.deepEqual(await readFile(path.join(directory, artifact.storageKey)), zip);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact service accepts deflated Jianying draft ZIP entries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-artifact-service-deflated-"));
  try {
    const service = createArtifactService({ rootDirectory: directory });
    const zip = createDeflatedZip([
      { name: "draft/draft_content.json", content: JSON.stringify({ clips: ["video"] }) },
      { name: "draft/draft_meta_info.json", content: JSON.stringify({ version: 1 }) },
    ]);
    const artifact = await service.acceptUpload({
      filename: "压缩剪映草稿.zip",
      contentType: "application/zip",
      stream: Readable.from([zip]),
    });
    assert.equal(artifact.validationStatus, "verified");
    assert.equal(artifact.sha256, createHash("sha256").update(zip).digest("hex"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact service rejects ZIP traversal entries and leaves no partial artifact", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-artifact-service-invalid-"));
  try {
    const service = createArtifactService({ rootDirectory: directory });
    await assert.rejects(
      () => service.acceptUpload({
        filename: "unsafe.zip",
        contentType: "application/zip",
        stream: Readable.from([createStoredZip([{ name: "../draft_content.json", content: "x" }])]),
      }),
      (error) => error.code === "INVALID_ZIP_ENTRY",
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact service verifies ZIP payload CRC before accepting a draft", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-artifact-service-crc-"));
  try {
    const service = createArtifactService({ rootDirectory: directory });
    const zip = createStoredZip([
      { name: "draft/draft_content.json", content: "{}" },
      { name: "draft/draft_meta_info.json", content: "{}" },
    ]);
    const payload = zip.indexOf(Buffer.from("{}", "utf8"));
    assert.notEqual(payload, -1);
    zip[payload] ^= 0xff;
    await assert.rejects(
      () => service.acceptUpload({
        filename: "corrupt.zip",
        contentType: "application/zip",
        stream: Readable.from([zip]),
      }),
      (error) => error.code === "INVALID_ZIP",
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact service requires the two draft metadata files to contain JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-artifact-service-json-"));
  try {
    const service = createArtifactService({ rootDirectory: directory });
    await assert.rejects(
      () => service.acceptUpload({
        filename: "not-json.zip",
        contentType: "application/zip",
        stream: Readable.from([createStoredZip([
          { name: "draft/draft_content.json", content: "not json" },
          { name: "draft/draft_meta_info.json", content: "{}" },
        ])]),
      }),
      (error) => error.code === "INVALID_DRAFT_ZIP",
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
