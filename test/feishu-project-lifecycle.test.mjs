import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { createFeishuWorkflowStore } from "../server/feishu-workflow-store.mjs";

const fixtures = [];

async function createFeishuFixture(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-project-lifecycle-"));
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    feishuPackages: {
      packages: {
        "Auto-cut-A": {
          projectId: "auto-cut-a",
          workspacePath: directory,
          prompt: "fixture prompt",
        },
      },
    },
    feishuWorkflowSync: async () => ({ ok: true }),
  });
  const store = createFeishuWorkflowStore({
    database: app.database,
    packageAliases: async () => ["Auto-cut-A"],
    syncSubject: options.syncSubject ?? (async () => ({ ok: true })),
  });
  const fixture = { app, database: app.database, directory, store };
  fixtures.push(fixture);
  return fixture;
}

function baseWithSubjects(ids) {
  return {
    baseToken: "base-lifecycle",
    baseName: "Lifecycle Base",
    sourceUrlLabel: "https://example.feishu.cn/base/base-lifecycle",
    metadataRefreshedAt: 1,
    tables: ids.map((tableId) => ({
      tableId,
      tableName: `Subject ${tableId}`,
      fields: [{
        fieldId: `status-${tableId}`,
        fieldName: "Status",
        type: 3,
        uiType: "SingleSelect",
        options: [{ id: `ready-${tableId}`, name: "Ready" }],
      }],
    })),
  };
}

function createViewState(database, subjectKey) {
  const initial = database.getUnifiedWorkflowViews(subjectKey);
  const created = database.createUnifiedWorkflowView({
    subjectKey,
    stateRevision: initial.revision,
    name: "Custom lifecycle view",
    stageIds: ["todo"],
  });
  const customView = created.views.find((view) => !view.isSystem);
  database.setUnifiedWorkflowViewState(subjectKey, {
    stateRevision: created.revision,
    activeViewId: customView.id,
  });
  return customView.id;
}

function viewState(database, subjectKey) {
  return { ...database.database.prepare(`SELECT active_view_id, read_only
    FROM feishu_unified_view_sets WHERE subject_key = ?`).get(subjectKey) };
}

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("removing one subject archives only that subject project", async () => {
  const fixture = await createFeishuFixture();
  const catalog = await fixture.store.upsertBasePreview(baseWithSubjects(["table-a", "table-b"]));
  const subject = catalog.subjects.find((item) => item.tableId === "table-a");
  const sibling = catalog.subjects.find((item) => item.tableId === "table-b");

  await fixture.store.removeSubject(subject.subjectKey);

  assert.notEqual(fixture.database.getProject(subject.projectId).archivedAt, null);
  assert.equal(fixture.database.getProject(sibling.projectId).archivedAt, null);
  assert.equal(fixture.database.listProjects().some((item) => item.id === subject.projectId), false);
  assert.equal(fixture.database.listProjects({ includeArchived: true }).some((item) => item.id === subject.projectId), true);
});

test("re-adding a removed subject restores its Feishu project", async () => {
  const fixture = await createFeishuFixture();
  const first = await fixture.store.upsertBasePreview(baseWithSubjects(["table-a"]));
  const subject = first.subjects[0];
  await fixture.store.removeSubject(subject.subjectKey);

  await fixture.store.upsertBasePreview(baseWithSubjects(["table-a"]));

  const restored = fixture.database.getProject(subject.projectId);
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.source, "feishu");
});

test("disable and display-hide do not archive a subject project", async () => {
  const fixture = await createFeishuFixture();
  const catalog = await fixture.store.upsertBasePreview(baseWithSubjects(["table-a"]));
  const subject = catalog.subjects[0];

  const disabled = await fixture.store.disableSubject(subject.subjectKey, subject.configVersion);
  assert.equal(fixture.database.getProject(subject.projectId).archivedAt, null);
  await fixture.store.setSubjectDisplayEnabled(subject.subjectKey, false);
  assert.equal(fixture.database.getProject(disabled.projectId).archivedAt, null);
});

test("removing and restoring Base subjects synchronizes project and view lifecycle", async () => {
  const fixture = await createFeishuFixture();
  const catalog = await fixture.store.upsertBasePreview(baseWithSubjects(["table-a", "table-b"]));
  const activeViewIds = new Map(catalog.subjects.map((subject) => [
    subject.subjectKey,
    createViewState(fixture.database, subject.subjectKey),
  ]));

  await fixture.store.removeBase(catalog.baseToken);

  for (const subject of catalog.subjects) {
    assert.notEqual(fixture.database.getProject(subject.projectId).archivedAt, null);
    assert.deepEqual(viewState(fixture.database, subject.subjectKey), {
      active_view_id: "all",
      read_only: 1,
    });
  }

  await fixture.store.upsertBasePreview(baseWithSubjects(["table-a"]));

  assert.equal(fixture.database.getProject(catalog.subjects[0].projectId).archivedAt, null);
  assert.deepEqual(viewState(fixture.database, catalog.subjects[0].subjectKey), {
    active_view_id: activeViewIds.get(catalog.subjects[0].subjectKey),
    read_only: 0,
  });
  assert.notEqual(fixture.database.getProject(catalog.subjects[1].projectId).archivedAt, null);
  assert.deepEqual(viewState(fixture.database, catalog.subjects[1].subjectKey), {
    active_view_id: "all",
    read_only: 1,
  });
});

test("failed Bridge lifecycle sync leaves Base subjects, projects, and views unchanged", async () => {
  let syncCalls = 0;
  const fixture = await createFeishuFixture({
    syncSubject: async () => {
      syncCalls += 1;
      if (syncCalls === 2) throw new Error("bridge unavailable");
      return { ok: true };
    },
  });
  const catalog = await fixture.store.upsertBasePreview(baseWithSubjects(["table-a", "table-b"]));
  const activeViewIds = new Map(catalog.subjects.map((subject) => [
    subject.subjectKey,
    createViewState(fixture.database, subject.subjectKey),
  ]));

  await assert.rejects(() => fixture.store.removeBase(catalog.baseToken), /bridge unavailable/);
  assert.equal(syncCalls, 2);

  const active = await fixture.store.listCatalog();
  assert.deepEqual(active[0].subjects.map((subject) => subject.lifecycle), ["draft", "draft"]);
  for (const subject of catalog.subjects) {
    assert.equal(fixture.database.getProject(subject.projectId).archivedAt, null);
    assert.deepEqual(viewState(fixture.database, subject.subjectKey), {
      active_view_id: activeViewIds.get(subject.subjectKey),
      read_only: 0,
    });
  }
});

test("Base removal rolls back every subject when a later project freeze fails", async () => {
  const fixture = await createFeishuFixture();
  const catalog = await fixture.store.upsertBasePreview(baseWithSubjects(["table-a", "table-b"]));
  const activeViewIds = new Map(catalog.subjects.map((subject) => [
    subject.subjectKey,
    createViewState(fixture.database, subject.subjectKey),
  ]));
  const originalFreeze = fixture.database.freezeSourceWorkflowState.bind(fixture.database);
  fixture.database.freezeSourceWorkflowState = (subjectKey, transaction) => {
    if (subjectKey.endsWith(":table-b")) throw new Error("freeze failed");
    return originalFreeze(subjectKey, transaction);
  };

  await assert.rejects(() => fixture.store.removeBase(catalog.baseToken), /freeze failed/);

  const active = await fixture.store.listCatalog();
  assert.deepEqual(active[0].subjects.map((subject) => subject.lifecycle), ["draft", "draft"]);
  for (const subject of catalog.subjects) {
    assert.equal(fixture.database.getProject(subject.projectId).archivedAt, null);
    assert.deepEqual(viewState(fixture.database, subject.subjectKey), {
      active_view_id: activeViewIds.get(subject.subjectKey),
      read_only: 0,
    });
  }
});
