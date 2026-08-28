import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const componentSource = () => readFile(
  new URL("../web/src/components/ArtifactUploadView.tsx", import.meta.url),
  "utf8",
);

test("upload view maps the three tabs to their independent worker states", async () => {
  const source = await componentSource();

  assert.match(source, /upload_queue:\s*\["queued",\s*"failed"\]/);
  assert.match(source, /uploading:\s*\["uploading"\]/);
  assert.match(source, /uploaded:\s*\["uploaded"\]/);
  assert.match(source, /VIEW_STATUSES\[view\]/);
});

test("upload view refreshes project data and filters searchable task and ZIP fields", async () => {
  const source = await componentSource();

  assert.match(source, /listArtifactUploads\(projectId,\s*controller\.signal\)/);
  assert.match(source, /\[projectId,\s*revision/);
  assert.match(source, /task\.identifier/);
  assert.match(source, /task\.title/);
  assert.match(source, /upload\.filename/);
});

test("upload rows expose operational metadata without exposing local destinations", async () => {
  const source = await componentSource();

  assert.match(source, /upload\.sha256/);
  assert.match(source, /upload\.attemptCount/);
  assert.match(source, /upload\.createdAt/);
  assert.match(source, /upload\.startedAt/);
  assert.match(source, /upload\.completedAt/);
  assert.match(source, /onOpenTask\(item\.task\)/);
  assert.doesNotMatch(source, /targetPath|storageKey/);
});

test("upload view provides loading, error, empty, and failed retry interactions", async () => {
  const source = await componentSource();

  assert.match(source, /artifact-upload-loading/);
  assert.match(source, /artifact-upload-view-error/);
  assert.match(source, /artifact-upload-empty/);
  assert.match(source, /upload\.status === "failed"/);
  assert.match(source, /retryTaskArtifactUpload\(item\.task\.id,\s*upload\.id\)/);
  assert.match(source, /<LinearIcon name="recurrence"/);
  assert.match(source, /title=\{text\("重新上传",\s*"Retry upload"\)\}/);
  assert.match(source, /aria-label=\{text\("重新上传",\s*"Retry upload"\)\}/);
});

test("upload view state classes stay isolated from Task Detail upload styles", async () => {
  const source = await componentSource();

  assert.match(source, /artifact-upload-view-status/);
  assert.match(source, /artifact-upload-view-error/);
  assert.doesNotMatch(source, /className="artifact-upload-status"/);
  assert.doesNotMatch(source, /className="artifact-upload-error"/);
});

test("failed uploads show their latest failure time", async () => {
  const source = await componentSource();

  assert.match(source, /upload\.status === "failed"\) return upload\.updatedAt/);
});

test("parallel retries retain independent pending button state", async () => {
  const source = await componentSource();

  assert.match(source, /useState<Set<string>>/);
  assert.match(source, /next\.add\(upload\.id\)/);
  assert.match(source, /next\.delete\(upload\.id\)/);
  assert.match(source, /retryingIds\.has\(upload\.id\)/);
});
