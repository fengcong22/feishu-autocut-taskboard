import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = () => readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");

test("App refreshes project upload summaries and reacts to upload events", async () => {
  const app = await source();
  assert.match(app, /listArtifactUploads\(projectId/);
  assert.match(app, /artifactUploadItems/);
  assert.match(app, /refreshArtifactUploads/);
  assert.match(app, /artifact\.upload\.updated/);
});

test("unified board renders all editing and upload stages", async () => {
  const board = await readFile(
    new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url),
    "utf8",
  );
  for (const stage of ["待处理", "排队中", "处理中", "待验收", "已完成剪辑", "上传队列", "上传中", "已上传"]) {
    assert.match(board, new RegExp(stage));
  }
  assert.match(board, /groupUnifiedWorkflowItems/);
  assert.match(board, /readOnly/);
  assert.match(board, /retry/);
});

test("TaskCard can be rendered without starting a status drag", async () => {
  const card = await readFile(
    new URL("../web/src/components/TaskCard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(card, /dragEnabled\?: boolean/);
  assert.match(card, /draggable=\{dragEnabled/);
});
