import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = async (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("project upload API returns task-bound upload rows without local paths", async () => {
  const api = await source("web/src/api.ts");
  const types = await source("web/src/types.ts");

  assert.match(types, /export interface ArtifactUploadListItem/);
  assert.match(types, /upload: ArtifactUpload/);
  assert.match(types, /task: Task/);
  assert.match(api, /export async function listArtifactUploads/);
  assert.match(api, /\/api\/local\/artifact-uploads/);
  assert.match(api, /projectId/);
  assert.doesNotMatch(api, /listArtifactUploads[\s\S]{0,500}targetPath/);
  assert.doesNotMatch(api, /listArtifactUploads[\s\S]{0,500}storageKey/);
});

test("Taskboard persists three independent upload status views", async () => {
  const app = await source("web/src/App.tsx");

  assert.match(app, /type BoardView =[\s\S]*?"upload_queue"[\s\S]*?"uploading"[\s\S]*?"uploaded"/);
  assert.match(app, /view === "upload_queue"/);
  assert.match(app, /view === "uploading"/);
  assert.match(app, /view === "uploaded"/);
  assert.match(app, /上传队列/);
  assert.match(app, /上传中/);
  assert.match(app, /已经上传/);
  assert.match(app, /<ArtifactUploadView/);
  assert.match(app, /revision=\{attachmentsRevision\}/);
  assert.match(app, /onOpenTask=\{openTaskDetail\}/);
});
