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

test("Taskboard keeps legacy upload view compatibility while using one unified board entry", async () => {
  const app = await source("web/src/App.tsx");

  assert.match(app, /type BoardView =[\s\S]*?"upload_queue"[\s\S]*?"uploading"[\s\S]*?"uploaded"/);
  assert.match(app, /view === "completed_editing"[\s\S]*?view === "upload_queue"[\s\S]*?view === "uploading"[\s\S]*?view === "uploaded"/);
  assert.match(app, /setItem\([\s\S]*?"issues"\)/);
  assert.match(app, /<ArtifactUploadView/);
  assert.match(app, /revision=\{attachmentsRevision\}/);
  assert.match(app, /onOpenTask=\{openTaskDetail\}/);
  assert.doesNotMatch(app, /onClick=\{\(\) => selectBoardView\("upload_queue"\)\}/);
  assert.doesNotMatch(app, /onClick=\{\(\) => selectBoardView\("uploading"\)\}/);
  assert.doesNotMatch(app, /onClick=\{\(\) => selectBoardView\("uploaded"\)\}/);
});
