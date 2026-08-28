import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = async (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("artifact upload API uses task-scoped queue routes without exposing the configured target path", async () => {
  const api = await source("web/src/api.ts");
  const types = await source("web/src/types.ts");

  assert.match(types, /export interface ArtifactUpload/);
  assert.match(types, /status: "queued" \| "uploading" \| "uploaded" \| "failed"/);
  assert.doesNotMatch(types, /export interface ArtifactUpload[\s\S]{0,500}targetPath/);
  assert.match(api, /export async function listTaskArtifactUploads/);
  assert.match(api, /\/api\/local\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/upload/);
  assert.match(api, /export async function enqueueTaskArtifactUpload/);
  assert.match(api, /\/api\/local\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/upload-queue/);
  assert.match(api, /export async function retryTaskArtifactUpload/);
  assert.match(api, /\/api\/local\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/upload\/retry/);
  assert.doesNotMatch(api, /enqueueTaskArtifactUpload[\s\S]{0,400}targetPath/);
});

test("Task Detail lets completed verified artifacts join and retry the independent upload queue", async () => {
  const detail = await source("web/src/components/TaskDetail.tsx");

  assert.match(detail, /listTaskArtifactUploads/);
  assert.match(detail, /enqueueTaskArtifactUpload/);
  assert.match(detail, /retryTaskArtifactUpload/);
  assert.match(detail, /currentTask\.status === "done"/);
  assert.match(detail, /artifact\.validationStatus === "verified"/);
  assert.match(detail, /加入上传队列/);
  assert.match(detail, /重新上传/);
  assert.match(detail, /enqueueTaskArtifactUpload\(currentTask\.id, artifact\.id\)/);
  assert.match(detail, /retryTaskArtifactUpload\(currentTask\.id, upload\.id\)/);
  assert.doesNotMatch(detail, /upload\.targetPath/);
  assert.match(detail, /upload\.status/);
});

test("Task Detail summarizes upload states and locks ZIP deletion while upload work is active", async () => {
  const detail = await source("web/src/components/TaskDetail.tsx");

  assert.match(detail, /const uploadSummary = useMemo/);
  assert.match(detail, /uploadSummary\.queued/);
  assert.match(detail, /uploadSummary\.uploading/);
  assert.match(detail, /uploadSummary\.uploaded/);
  assert.match(detail, /uploadSummary\.failed/);
  assert.match(detail, /artifactUploadActive/);
  assert.match(detail, /artifactUpload\?\.status === "queued" \|\| artifactUpload\?\.status === "uploading"/);
  assert.match(detail, /disabled=\{[\s\S]{0,250}artifactUploadActive/);
  assert.doesNotMatch(detail, /上传不会改变任务状态|Uploading does not change the issue status/);
  assert.match(detail, /验证后待验收/);
  assert.match(detail, /验证后完成/);
});

test("Task Detail keeps validation results and upload counts compact on narrow layouts", async () => {
  const styles = await source("web/src/styles.css");

  assert.match(styles, /\.artifact-mode-result\s*\{/);
  assert.match(styles, /\.artifact-upload-summary\s*\{[\s\S]{0,300}flex-wrap:\s*wrap/);
  assert.match(styles, /\.artifact-upload-summary span\s*\{/);
});

test("local realtime sync refreshes the detail upload queue after worker status changes", async () => {
  const app = await source("web/src/App.tsx");
  const detail = await source("web/src/components/TaskDetail.tsx");

  assert.match(app, /"artifact\.upload\.updated"/);
  assert.match(app, /event\.type\.startsWith\("attachment\."\) \|\| event\.type\.startsWith\("artifact\."\)/);
  assert.match(app, /setAttachmentsRevision\(\(current\) => current \+ 1\)/);
  assert.match(detail, /void listTaskArtifactUploads\(task\.id, controller\.signal\)/);
  assert.match(detail, /\}, \[attachmentsRevision, isFeishuAutoCutTask, task\.id\]\);/);
});
