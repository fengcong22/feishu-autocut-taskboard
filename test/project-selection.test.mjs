import assert from "node:assert/strict";
import { test } from "node:test";

const selectionModule = import("../web/src/projectSelection.mjs").catch(() => null);

test("an explicitly selected archived project remains open after a catalog refresh", async () => {
  const module = await selectionModule;
  assert.ok(module, "project selection helpers must be available");

  const projects = [
    { id: "local", archivedAt: null },
    { id: "temp-history", archivedAt: "2026-09-03T01:00:00.000Z" },
  ];

  assert.equal(module.resolveProjectIdAfterRefresh(projects, {
    requestedProjectId: "temp-history",
    currentProjectId: "temp-history",
    globalProjectId: "local",
  }), "temp-history");
});

test("an unavailable project falls back to an active project, never an archived one", async () => {
  const module = await selectionModule;
  assert.ok(module, "project selection helpers must be available");

  const projects = [
    { id: "temp-old", archivedAt: "2026-09-03T01:00:00.000Z" },
    { id: "temp-active", archivedAt: null },
  ];

  assert.equal(module.resolveProjectIdAfterRefresh(projects, {
    requestedProjectId: "missing",
    currentProjectId: "missing",
    globalProjectId: "local",
  }), "temp-active");
});

test("a removed Feishu project's trusted history restores its subject scope", async () => {
  const module = await selectionModule;
  assert.ok(module, "project selection helpers must be available");

  const tasks = [{
    id: "task-1",
    projectId: "feishu-history",
    feishuOrigin: {
      source: "feishu-base",
      subjectKey: "bas_history:tbl_chinese",
    },
  }];

  assert.equal(module.findFeishuSubjectKeyForProject(
    "feishu-history",
    null,
    [],
    tasks,
  ), "bas_history:tbl_chinese");
  assert.equal(module.findFeishuSubjectKeyForProject(
    "another-project",
    null,
    [],
    tasks,
  ), null);
});

test("a removed Feishu project restores its subject scope before any task exists", async () => {
  const module = await selectionModule;
  assert.ok(module, "project selection helpers must be available");

  assert.equal(module.findFeishuSubjectKeyForProject(
    "feishu-empty-history",
    null,
    [],
    [],
    "bas_history:tbl_empty",
  ), "bas_history:tbl_empty");
});
