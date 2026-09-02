import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-api-"));
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
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, baseUrl: `http://127.0.0.1:${address.port}`, directory };
}

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, body: await response.json() };
}

async function createViewSubjects(baseUrl, baseToken = "bas_views") {
  const created = await request(baseUrl, "/api/local/feishu/workflow/catalog", {
    method: "POST",
    body: {
      baseToken,
      baseName: "Views Base",
      tables: [
        { tableId: "tbl_a", tableName: "Subject A", fields: [] },
        { tableId: "tbl_b", tableName: "Subject B", fields: [] },
      ],
    },
  });
  assert.equal(created.response.status, 201);
  return created.body.catalog[0].subjects;
}

test("workflow views GET requires one subjectKey and rejects unknown query parameters", async () => {
  const fixtureData = await fixture();
  try {
    const missing = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/views");
    assert.equal(missing.response.status, 400);
    assert.equal(missing.body.error.code, "INVALID_QUERY_PARAMETER");

    const duplicate = await request(
      fixtureData.baseUrl,
      "/api/local/feishu/workflow/views?subjectKey=one&subjectKey=two",
    );
    assert.equal(duplicate.response.status, 400);
    assert.equal(duplicate.body.error.code, "INVALID_QUERY_PARAMETER");

    const unknown = await request(
      fixtureData.baseUrl,
      "/api/local/feishu/workflow/views?subjectKey=one&extra=true",
    );
    assert.equal(unknown.response.status, 400);
    assert.equal(unknown.body.error.code, "UNKNOWN_QUERY_PARAMETER");
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("workflow view mutations validate bodies and remain isolated by subject", async () => {
  const fixtureData = await fixture();
  try {
    const [subjectA, subjectB] = await createViewSubjects(fixtureData.baseUrl);
    const stateA = (await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views?subjectKey=${encodeURIComponent(subjectA.subjectKey)}`,
    )).body.state;
    const stateB = (await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views?subjectKey=${encodeURIComponent(subjectB.subjectKey)}`,
    )).body.state;

    const unknown = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/views", {
      method: "POST",
      body: {
        subjectKey: subjectA.subjectKey,
        name: "剪辑",
        stageIds: ["todo"],
        stateRevision: stateA.revision,
        extra: true,
      },
    });
    assert.equal(unknown.response.status, 400);
    assert.equal(unknown.body.error.code, "UNKNOWN_FIELD");

    const created = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/views", {
      method: "POST",
      body: {
        subjectKey: subjectA.subjectKey,
        name: "剪辑",
        stageIds: ["todo", "in_progress"],
        stateRevision: stateA.revision,
      },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.state.subjectKey, subjectA.subjectKey);
    assert.deepEqual(created.body.state.views.map((view) => view.name), ["全部流程", "剪辑"]);

    const unchangedB = (await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views?subjectKey=${encodeURIComponent(subjectB.subjectKey)}`,
    )).body.state;
    assert.deepEqual(unchangedB, stateB);
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("workflow view name limits count Unicode characters consistently", async () => {
  const fixtureData = await fixture();
  try {
    const [subject] = await createViewSubjects(fixtureData.baseUrl, "bas_view_unicode");
    const initial = (await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views?subjectKey=${encodeURIComponent(subject.subjectKey)}`,
    )).body.state;
    const accepted = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/views", {
      method: "POST",
      body: {
        subjectKey: subject.subjectKey,
        name: "😀".repeat(64),
        stageIds: ["todo"],
        stateRevision: initial.revision,
      },
    });
    assert.equal(accepted.response.status, 201);

    const rejected = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/views", {
      method: "POST",
      body: {
        subjectKey: subject.subjectKey,
        name: "😀".repeat(65),
        stageIds: ["todo"],
        stateRevision: accepted.body.state.revision,
      },
    });
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.body.error.code, "INVALID_FIELD");
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("workflow view reads repair the system row and discard damaged custom rows", async () => {
  const fixtureData = await fixture();
  try {
    const [subject] = await createViewSubjects(fixtureData.baseUrl, "bas_view_repair");
    const initial = (await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views?subjectKey=${encodeURIComponent(subject.subjectKey)}`,
    )).body.state;
    const timestamp = new Date().toISOString();
    const sqlite = fixtureData.app.database.database;
    sqlite.prepare(`
      UPDATE feishu_unified_views
      SET name = 'Damaged all', stage_ids_json = '["todo"]', is_system = 0
      WHERE subject_key = ? AND id = 'all'
    `).run(subject.subjectKey);
    sqlite.prepare(`
      INSERT INTO feishu_unified_views
        (id, subject_key, name, stage_ids_json, is_system, revision, created_at, updated_at)
      VALUES ('bad-json', ?, 'Bad JSON', '{', 0, 1, ?, ?)
    `).run(subject.subjectKey, timestamp, timestamp);
    sqlite.prepare(`
      INSERT INTO feishu_unified_views
        (id, subject_key, name, stage_ids_json, is_system, revision, created_at, updated_at)
      VALUES ('bad-stage', ?, 'Bad stage', '["unknown"]', 0, 1, ?, ?)
    `).run(subject.subjectKey, timestamp, timestamp);
    sqlite.prepare(`
      INSERT INTO feishu_unified_views
        (id, subject_key, name, stage_ids_json, is_system, revision, created_at, updated_at)
      VALUES ('duplicate-stage', ?, 'Duplicate stage', '["todo","todo"]', 0, 1, ?, ?)
    `).run(subject.subjectKey, timestamp, timestamp);
    sqlite.prepare(`
      INSERT INTO feishu_unified_views
        (id, subject_key, name, stage_ids_json, is_system, revision, created_at, updated_at)
      VALUES ('reserved-name', ?, '全部流程', '["todo"]', 0, 1, ?, ?)
    `).run(subject.subjectKey, timestamp, timestamp);
    sqlite.prepare(`
      INSERT INTO feishu_unified_views
        (id, subject_key, name, stage_ids_json, is_system, revision, created_at, updated_at)
      VALUES ('fake-system', ?, 'Fake system', '["todo"]', 1, 1, ?, ?)
    `).run(subject.subjectKey, timestamp, timestamp);
    sqlite.prepare(`
      UPDATE feishu_unified_view_sets
      SET default_view_id = 'bad-json', active_view_id = 'bad-stage'
      WHERE subject_key = ?
    `).run(subject.subjectKey);

    const repaired = await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views?subjectKey=${encodeURIComponent(subject.subjectKey)}`,
    );
    assert.equal(repaired.response.status, 200);
    assert.equal(repaired.body.state.revision, initial.revision + 1);
    assert.equal(repaired.body.state.defaultViewId, "all");
    assert.equal(repaired.body.state.activeViewId, "all");
    assert.deepEqual(repaired.body.state.views.map((view) => view.id), ["all"]);
    assert.deepEqual(repaired.body.state.views[0], {
      ...initial.views[0],
      name: "全部流程",
      stageIds: [
        "todo", "queued", "in_progress", "blocked", "in_review",
        "completed_editing", "upload_queue", "uploading", "uploaded",
      ],
      isSystem: true,
      revision: initial.views[0].revision + 1,
      updatedAt: repaired.body.state.views[0].updatedAt,
    });
    assert.deepEqual(sqlite.prepare(`
      SELECT view_id, name, stage_ids_json, is_system, reason
      FROM feishu_unified_view_quarantine
      WHERE subject_key = ?
      ORDER BY view_id
    `).all(subject.subjectKey).map((row) => ({ ...row })), [
      {
        view_id: "bad-json",
        name: "Bad JSON",
        stage_ids_json: "{",
        is_system: 0,
        reason: "invalid_definition",
      },
      {
        view_id: "bad-stage",
        name: "Bad stage",
        stage_ids_json: '["unknown"]',
        is_system: 0,
        reason: "invalid_definition",
      },
      {
        view_id: "duplicate-stage",
        name: "Duplicate stage",
        stage_ids_json: '["todo","todo"]',
        is_system: 0,
        reason: "invalid_definition",
      },
      {
        view_id: "fake-system",
        name: "Fake system",
        stage_ids_json: '["todo"]',
        is_system: 1,
        reason: "unexpected_system_flag",
      },
      {
        view_id: "reserved-name",
        name: "全部流程",
        stage_ids_json: '["todo"]',
        is_system: 0,
        reason: "reserved_name",
      },
    ]);
    assert.deepEqual(sqlite.prepare(`
      SELECT id FROM feishu_unified_views
      WHERE subject_key = ? AND id <> 'all'
      ORDER BY id
    `).all(subject.subjectKey), []);

    const reread = await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views?subjectKey=${encodeURIComponent(subject.subjectKey)}`,
    );
    assert.deepEqual(reread.body.state, repaired.body.state);

    const reusedName = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/views", {
      method: "POST",
      body: {
        subjectKey: subject.subjectKey,
        name: "Bad JSON",
        stageIds: ["todo"],
        stateRevision: repaired.body.state.revision,
      },
    });
    assert.equal(reusedName.response.status, 201);

    const protectedSystem = await request(
      fixtureData.baseUrl,
      "/api/local/feishu/workflow/views/all",
      {
        method: "DELETE",
        body: {
          subjectKey: subject.subjectKey,
          stateRevision: reusedName.body.state.revision,
        },
      },
    );
    assert.equal(protectedSystem.response.status, 409);
    assert.equal(protectedSystem.body.error.code, "SYSTEM_VIEW_PROTECTED");
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("workflow view repair quarantines conflicting definitions without losing their data", async () => {
  const fixtureData = await fixture();
  try {
    const [subject] = await createViewSubjects(fixtureData.baseUrl, "bas_view_quarantine");
    await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views?subjectKey=${encodeURIComponent(subject.subjectKey)}`,
    );
    const timestamp = new Date().toISOString();
    const sqlite = fixtureData.app.database.database;
    sqlite.prepare(`
      UPDATE feishu_unified_views
      SET name = 'Damaged all'
      WHERE subject_key = ? AND id = 'all'
    `).run(subject.subjectKey);
    sqlite.prepare(`
      INSERT INTO feishu_unified_views
        (id, subject_key, name, stage_ids_json, is_system, revision, created_at, updated_at)
      VALUES ('reserved-name', ?, '全部流程', '["todo","in_progress"]', 0, 3, ?, ?)
    `).run(subject.subjectKey, timestamp, timestamp);

    const repaired = await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views?subjectKey=${encodeURIComponent(subject.subjectKey)}`,
    );
    assert.equal(repaired.response.status, 200);
    assert.deepEqual(repaired.body.state.views.map((view) => view.id), ["all"]);

    const quarantineTable = sqlite.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'feishu_unified_view_quarantine'
    `).get();
    assert.ok(quarantineTable);
    assert.deepEqual({ ...sqlite.prepare(`
      SELECT view_id, name, stage_ids_json, is_system, revision, reason
      FROM feishu_unified_view_quarantine
      WHERE subject_key = ? AND view_id = 'reserved-name'
    `).get(subject.subjectKey) }, {
      view_id: "reserved-name",
      name: "全部流程",
      stage_ids_json: '["todo","in_progress"]',
      is_system: 0,
      revision: 3,
      reason: "reserved_name",
    });
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("workflow view repair canonicalizes persisted names before uniqueness checks", async () => {
  const fixtureData = await fixture();
  try {
    const [subject] = await createViewSubjects(fixtureData.baseUrl, "bas_view_name_repair");
    const initial = (await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views?subjectKey=${encodeURIComponent(subject.subjectKey)}`,
    )).body.state;
    const timestamp = new Date().toISOString();
    const sqlite = fixtureData.app.database.database;
    sqlite.prepare(`
      UPDATE feishu_unified_views
      SET name = 'Visible'
      WHERE subject_key = ? AND id = 'all'
    `).run(subject.subjectKey);
    sqlite.prepare(`
      INSERT INTO feishu_unified_views
        (id, subject_key, name, stage_ids_json, is_system, revision, created_at, updated_at)
      VALUES ('spaced-name', ?, '  Visible  ', '["todo"]', 0, 1, ?, ?)
    `).run(subject.subjectKey, timestamp, timestamp);

    const repaired = (await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views?subjectKey=${encodeURIComponent(subject.subjectKey)}`,
    )).body.state;
    assert.equal(repaired.revision, initial.revision + 1);
    assert.equal(repaired.views.find((view) => view.id === "spaced-name").name, "Visible");
    assert.deepEqual({ ...sqlite.prepare(`
      SELECT name, revision FROM feishu_unified_views
      WHERE subject_key = ? AND id = 'spaced-name'
    `).get(subject.subjectKey) }, { name: "Visible", revision: 2 });

    const duplicate = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/views", {
      method: "POST",
      body: {
        subjectKey: subject.subjectKey,
        name: "Visible",
        stageIds: ["queued"],
        stateRevision: repaired.revision,
      },
    });
    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.body.error.code, "VIEW_NAME_EXISTS");

    const reread = (await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views?subjectKey=${encodeURIComponent(subject.subjectKey)}`,
    )).body.state;
    assert.deepEqual(reread, repaired);
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("restoring a subject falls back to all when its frozen view is damaged", async () => {
  const fixtureData = await fixture();
  try {
    const [subject] = await createViewSubjects(fixtureData.baseUrl, "bas_view_invalid_restore");
    const initial = (await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views?subjectKey=${encodeURIComponent(subject.subjectKey)}`,
    )).body.state;
    const created = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/views", {
      method: "POST",
      body: {
        subjectKey: subject.subjectKey,
        name: "Will be damaged",
        stageIds: ["todo"],
        stateRevision: initial.revision,
      },
    });
    const custom = created.body.state.views.find((view) => view.name === "Will be damaged");
    const selected = await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views/${encodeURIComponent(custom.id)}`,
      {
        method: "PATCH",
        body: {
          subjectKey: subject.subjectKey,
          stateRevision: created.body.state.revision,
          activeViewId: custom.id,
        },
      },
    );
    await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/subjects/${encodeURIComponent(subject.subjectKey)}`,
      { method: "DELETE", body: {} },
    );

    const sqlite = fixtureData.app.database.database;
    sqlite.prepare(`
      UPDATE feishu_unified_views
      SET stage_ids_json = '["unknown"]'
      WHERE subject_key = ? AND id = ?
    `).run(subject.subjectKey, custom.id);

    await createViewSubjects(fixtureData.baseUrl, "bas_view_invalid_restore");
    const stored = sqlite.prepare(`
      SELECT active_view_id, frozen_active_view_id, read_only, revision
      FROM feishu_unified_view_sets
      WHERE subject_key = ?
    `).get(subject.subjectKey);
    assert.equal(stored.active_view_id, "all");
    assert.equal(stored.frozen_active_view_id, null);
    assert.equal(stored.read_only, 0);
    assert.equal(stored.revision, selected.body.state.revision + 2);

    const restored = (await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views?subjectKey=${encodeURIComponent(subject.subjectKey)}`,
    )).body.state;
    assert.equal(restored.activeViewId, "all");
    assert.equal(restored.revision, stored.revision);
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("workflow view routes preserve optimistic conflicts and protect removed or system views", async () => {
  const fixtureData = await fixture();
  try {
    const [subject] = await createViewSubjects(fixtureData.baseUrl, "bas_view_guards");
    const initial = (await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views?subjectKey=${encodeURIComponent(subject.subjectKey)}`,
    )).body.state;
    const system = initial.views.find((view) => view.id === "all");

    const renameSystem = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/views/all", {
      method: "PATCH",
      body: {
        subjectKey: subject.subjectKey,
        stateRevision: initial.revision,
        viewRevision: system.revision,
        name: "Renamed",
      },
    });
    assert.equal(renameSystem.response.status, 409);
    assert.equal(renameSystem.body.error.code, "SYSTEM_VIEW_PROTECTED");

    const deleteSystem = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/views/all", {
      method: "DELETE",
      body: { subjectKey: subject.subjectKey, stateRevision: initial.revision },
    });
    assert.equal(deleteSystem.response.status, 409);
    assert.equal(deleteSystem.body.error.code, "SYSTEM_VIEW_PROTECTED");

    const created = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/views", {
      method: "POST",
      body: {
        subjectKey: subject.subjectKey,
        name: "Custom",
        stageIds: ["todo"],
        stateRevision: initial.revision,
      },
    });
    const custom = created.body.state.views.find((view) => view.name === "Custom");
    const stale = await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views/${encodeURIComponent(custom.id)}`,
      {
        method: "PATCH",
        body: {
          subjectKey: subject.subjectKey,
          stateRevision: initial.revision,
          viewRevision: custom.revision,
          name: "Stale",
        },
      },
    );
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.error.code, "VERSION_CONFLICT");

    const updated = await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views/${encodeURIComponent(custom.id)}`,
      {
        method: "PATCH",
        body: {
          subjectKey: subject.subjectKey,
          stateRevision: created.body.state.revision,
          viewRevision: custom.revision,
          name: "Updated",
          defaultViewId: custom.id,
          activeViewId: custom.id,
        },
      },
    );
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.state.revision, created.body.state.revision + 1);
    assert.equal(updated.body.state.defaultViewId, custom.id);
    assert.equal(updated.body.state.activeViewId, custom.id);
    const updatedCustom = updated.body.state.views.find((view) => view.id === custom.id);
    assert.equal(updatedCustom.name, "Updated");
    assert.equal(updatedCustom.revision, custom.revision + 1);

    const staleView = await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views/${encodeURIComponent(custom.id)}`,
      {
        method: "PATCH",
        body: {
          subjectKey: subject.subjectKey,
          stateRevision: updated.body.state.revision,
          viewRevision: custom.revision,
          name: "Stale view row",
        },
      },
    );
    assert.equal(staleView.response.status, 409);
    assert.equal(staleView.body.error.code, "VERSION_CONFLICT");
    assert.deepEqual(staleView.body.error.details, {
      expectedVersion: custom.revision,
      actualVersion: updatedCustom.revision,
    });

    const deleted = await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views/${encodeURIComponent(custom.id)}`,
      {
        method: "DELETE",
        body: { subjectKey: subject.subjectKey, stateRevision: updated.body.state.revision },
      },
    );
    assert.equal(deleted.response.status, 200);
    assert.deepEqual(deleted.body.state.views.map((view) => view.id), ["all"]);
    assert.equal(deleted.body.state.defaultViewId, "all");
    assert.equal(deleted.body.state.activeViewId, "all");

    await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/subjects/${encodeURIComponent(subject.subjectKey)}`,
      { method: "DELETE", body: {} },
    );
    const removedWrite = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/views", {
      method: "POST",
      body: {
        subjectKey: subject.subjectKey,
        name: "Removed",
        stageIds: ["todo"],
        stateRevision: deleted.body.state.revision,
      },
    });
    assert.equal(removedWrite.response.status, 409);
    assert.equal(removedWrite.body.error.code, "SUBJECT_REMOVED");
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("pointer-only workflow view updates validate the path view in the body subject", async () => {
  const fixtureData = await fixture();
  try {
    const [subjectA, subjectB] = await createViewSubjects(fixtureData.baseUrl, "bas_view_pointer_scope");
    const initialA = (await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views?subjectKey=${encodeURIComponent(subjectA.subjectKey)}`,
    )).body.state;
    const initialB = (await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views?subjectKey=${encodeURIComponent(subjectB.subjectKey)}`,
    )).body.state;
    const createdA = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/views", {
      method: "POST",
      body: {
        subjectKey: subjectA.subjectKey,
        name: "Subject A only",
        stageIds: ["todo"],
        stateRevision: initialA.revision,
      },
    });
    const customA = createdA.body.state.views.find((view) => view.name === "Subject A only");

    const foreignPath = await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views/${encodeURIComponent(customA.id)}`,
      {
        method: "PATCH",
        body: {
          subjectKey: subjectB.subjectKey,
          stateRevision: initialB.revision,
          activeViewId: "all",
        },
      },
    );
    assert.equal(foreignPath.response.status, 404);
    assert.equal(foreignPath.body.error.code, "VIEW_NOT_FOUND");

    const missingPath = await request(
      fixtureData.baseUrl,
      "/api/local/feishu/workflow/views/missing-view",
      {
        method: "PATCH",
        body: {
          subjectKey: subjectA.subjectKey,
          stateRevision: createdA.body.state.revision,
          activeViewId: "all",
        },
      },
    );
    assert.equal(missingPath.response.status, 404);
    assert.equal(missingPath.body.error.code, "VIEW_NOT_FOUND");

    const unchangedB = (await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views?subjectKey=${encodeURIComponent(subjectB.subjectKey)}`,
    )).body.state;
    assert.deepEqual(unchangedB, initialB);
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("workflow view lifecycle preserves active refreshes and versions real freeze transitions", async () => {
  const fixtureData = await fixture();
  try {
    const [subject] = await createViewSubjects(fixtureData.baseUrl, "bas_view_lifecycle");
    const initial = (await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views?subjectKey=${encodeURIComponent(subject.subjectKey)}`,
    )).body.state;
    const created = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/views", {
      method: "POST",
      body: {
        subjectKey: subject.subjectKey,
        name: "My workflow",
        stageIds: ["todo", "in_progress"],
        stateRevision: initial.revision,
      },
    });
    const custom = created.body.state.views.find((view) => view.name === "My workflow");
    const selected = await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views/${encodeURIComponent(custom.id)}`,
      {
        method: "PATCH",
        body: {
          subjectKey: subject.subjectKey,
          stateRevision: created.body.state.revision,
          defaultViewId: custom.id,
          activeViewId: custom.id,
        },
      },
    );
    assert.equal(selected.response.status, 200);

    await createViewSubjects(fixtureData.baseUrl, "bas_view_lifecycle");
    const refreshed = (await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views?subjectKey=${encodeURIComponent(subject.subjectKey)}`,
    )).body.state;
    assert.equal(refreshed.revision, selected.body.state.revision);
    assert.equal(refreshed.defaultViewId, custom.id);
    assert.equal(refreshed.activeViewId, custom.id);
    assert.deepEqual(refreshed.views, selected.body.state.views);

    await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/subjects/${encodeURIComponent(subject.subjectKey)}`,
      { method: "DELETE", body: {} },
    );
    const removed = (await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views?subjectKey=${encodeURIComponent(subject.subjectKey)}`,
    )).body.state;
    assert.equal(removed.readOnly, true);
    assert.equal(removed.activeViewId, "all");
    assert.equal(removed.defaultViewId, custom.id);
    assert.equal(removed.revision, refreshed.revision + 1);

    const removedAgain = (await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views?subjectKey=${encodeURIComponent(subject.subjectKey)}`,
    )).body.state;
    assert.deepEqual(removedAgain, removed);

    await createViewSubjects(fixtureData.baseUrl, "bas_view_lifecycle");
    const restored = (await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/views?subjectKey=${encodeURIComponent(subject.subjectKey)}`,
    )).body.state;
    assert.equal(restored.readOnly, false);
    assert.equal(restored.activeViewId, custom.id);
    assert.equal(restored.defaultViewId, custom.id);
    assert.equal(restored.revision, removed.revision + 1);

    const staleWrite = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/views", {
      method: "POST",
      body: {
        subjectKey: subject.subjectKey,
        name: "Stale client",
        stageIds: ["queued"],
        stateRevision: refreshed.revision,
      },
    });
    assert.equal(staleWrite.response.status, 409);
    assert.equal(staleWrite.body.error.code, "VERSION_CONFLICT");
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("local Feishu workflow API persists preview and subject lifecycle", async () => {
  const fixtureData = await fixture();
  try {
    const preview = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/catalog", {
      method: "POST",
      body: {
        baseToken: "bas_api",
        baseName: "API Base",
        tables: [{
          tableId: "tbl_a",
          tableName: "语文",
          fields: [{
            fieldId: "fld_status",
            fieldName: "状态",
            type: 3,
            uiType: "SingleSelect",
            options: [{ id: "opt_ready", name: "待剪辑" }],
          }],
        }],
      },
    });
    assert.equal(preview.response.status, 201);
    assert.equal(preview.body.catalog[0].subjects[0].lifecycle, "draft");
    const key = encodeURIComponent("bas_api:tbl_a");
    const subjects = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/subjects");
    assert.equal(subjects.response.status, 200);
    assert.equal(subjects.body.subjects[0].subjectKey, "bas_api:tbl_a");
    const single = await request(fixtureData.baseUrl, `/api/local/feishu/workflow/subjects/${key}`);
    assert.equal(single.response.status, 200);
    assert.equal(single.body.subject.subjectKey, "bas_api:tbl_a");
    const draft = await request(fixtureData.baseUrl, `/api/local/feishu/workflow/subjects/${key}`, {
      method: "PATCH",
      body: { trigger: { fieldId: "fld_status", fieldName: "状态", startValue: "待剪辑", optionId: "opt_ready" }, title: { fieldId: null, fieldName: null }, execution: { mode: "manual", concurrencyGroup: "g", maxConcurrent: 1, resourceGroups: [] }, packageRoute: { routeMode: "fixed", packageAlias: "Auto-cut-A", subjectCodeFieldId: null, branchMap: null }, upload: { enqueueMode: "manual", artifactSourceMode: "manual_select", artifactSourcePath: null, targetId: null, targetPath: null, uploadConcurrency: 1 } },
    });
    assert.equal(draft.response.status, 200);
    const enabled = await request(fixtureData.baseUrl, `/api/local/feishu/workflow/subjects/${key}/enable`, { method: "POST", body: { expectedVersion: draft.body.subject.configVersion } });
    assert.equal(enabled.response.status, 200);
    assert.equal(enabled.body.subject.lifecycle, "enabled");
    const catalog = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/catalog");
    assert.equal(catalog.body.catalog[0].subjects[0].lifecycle, "enabled");
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("Feishu removal archives its source project and preview restoration reactivates it", async () => {
  const fixtureData = await fixture();
  try {
    const previewBody = {
      baseToken: "bas_project_lifecycle",
      baseName: "Lifecycle Base",
      tables: [
        { tableId: "tbl_a", tableName: "Subject A", fields: [] },
        { tableId: "tbl_b", tableName: "Subject B", fields: [] },
      ],
    };
    const created = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/catalog", {
      method: "POST",
      body: previewBody,
    });
    const subjectA = created.body.catalog[0].subjects.find((subject) => subject.tableId === "tbl_a");
    const subjectB = created.body.catalog[0].subjects.find((subject) => subject.tableId === "tbl_b");

    const removed = await request(
      fixtureData.baseUrl,
      `/api/local/feishu/workflow/subjects/${encodeURIComponent(subjectA.subjectKey)}`,
      { method: "DELETE", body: {} },
    );
    assert.equal(removed.response.status, 200);
    assert.equal(removed.body.catalog[0].subjects.some((subject) => subject.subjectKey === subjectA.subjectKey), false);

    const active = await request(fixtureData.baseUrl, "/api/projects");
    assert.equal(active.body.projects.some((project) => project.id === subjectA.projectId), false);
    assert.equal(active.body.projects.some((project) => project.id === subjectB.projectId), true);
    const history = await request(fixtureData.baseUrl, "/api/projects?includeArchived=true");
    const archivedProject = history.body.projects.find((project) => project.id === subjectA.projectId);
    assert.notEqual(archivedProject.archivedAt, null);
    assert.equal(archivedProject.source, "feishu");

    const restored = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/catalog", {
      method: "POST",
      body: { ...previewBody, tables: [previewBody.tables[0]] },
    });
    assert.equal(restored.response.status, 201);
    const restoredProjects = await request(fixtureData.baseUrl, "/api/projects");
    const restoredProject = restoredProjects.body.projects.find((project) => project.id === subjectA.projectId);
    assert.equal(restoredProject.archivedAt, null);
    assert.equal(restoredProject.source, "feishu");
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});
