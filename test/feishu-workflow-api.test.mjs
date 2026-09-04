import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
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
    const hidden = await request(fixtureData.baseUrl, `/api/local/feishu/workflow/subjects/${key}/display`, {
      method: "PATCH", body: { displayEnabled: false },
    });
    assert.equal(hidden.response.status, 200);
    assert.equal(hidden.body.subject.displayEnabled, false);
    assert.equal(hidden.body.subject.lifecycle, "enabled");
    assert.equal(hidden.body.subject.configVersion, enabled.body.subject.configVersion);
    const shown = await request(fixtureData.baseUrl, `/api/local/feishu/workflow/subjects/${key}/display`, {
      method: "PATCH", body: { displayEnabled: true },
    });
    assert.equal(shown.response.status, 200);
    assert.equal(shown.body.subject.displayEnabled, true);
    assert.equal(shown.body.subject.lifecycle, "enabled");
    assert.equal(shown.body.subject.configVersion, enabled.body.subject.configVersion);
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

test("preview API does not return credentials or query secrets from source URLs", async () => {
  const fixtureData = await fixture();
  try {
    const created = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/catalog", {
      method: "POST",
      body: {
        baseToken: "bas_api_url",
        baseName: "URL Base",
        sourceUrlLabel: "https://user:secret@example.test/base?token=secret#fragment",
        tables: [{ tableId: "tbl_url", tableName: "语文", fields: [] }],
      },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.catalog[0].sourceUrlLabel, "https://example.test/base");

    const listed = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/catalog");
    const base = listed.body.catalog.find((entry) => entry.baseToken === "bas_api_url");
    assert.equal(base.sourceUrlLabel, "https://example.test/base");
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("Wiki Base preview is proxied unchanged and stored under the resolved Base token", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-wiki-preview-"));
  let receivedUrl = null;
  const bridge = createServer(async (incoming, response) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    receivedUrl = body.url;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      baseToken: "bas_resolved",
      baseName: "知识库课程",
      tables: [{ tableId: "tbl_math", tableName: "小学数学", fields: [] }],
    }));
  });
  await new Promise((resolve, reject) => {
    bridge.once("error", reject);
    bridge.listen(0, "127.0.0.1", resolve);
  });
  const bridgeAddress = bridge.address();
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    feishuBridgeUrl: `http://127.0.0.1:${bridgeAddress.port}`,
    feishuPackages: { packages: {} },
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const wikiUrl = "https://example.feishu.cn/wiki/wik_demo?table=tbl_math";
    const result = await request(baseUrl, "/api/local/feishu/workflow/catalog", {
      method: "POST",
      body: { url: wikiUrl },
    });

    assert.equal(result.response.status, 201);
    assert.equal(receivedUrl, wikiUrl);
    assert.equal(result.body.catalog[0].baseToken, "bas_resolved");
    assert.equal(result.body.catalog[0].subjects[0].subjectKey, "bas_resolved:tbl_math");
    assert.equal(
      result.body.catalog[0].sourceUrlLabel,
      "https://example.feishu.cn/wiki/wik_demo",
    );
  } finally {
    await app.close();
    await new Promise((resolve) => bridge.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("Wiki Base preview maps a known Bridge error without exposing its message", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-wiki-error-"));
  const bridge = createServer(async (incoming, response) => {
    for await (const _chunk of incoming) { /* drain */ }
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: {
        code: "FEISHU_WIKI_NOT_BASE",
        message: "private Wiki node title and token",
      },
    }));
  });
  await new Promise((resolve, reject) => {
    bridge.once("error", reject);
    bridge.listen(0, "127.0.0.1", resolve);
  });
  const bridgeAddress = bridge.address();
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    feishuBridgeUrl: `http://127.0.0.1:${bridgeAddress.port}`,
    feishuPackages: { packages: {} },
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const result = await request(baseUrl, "/api/local/feishu/workflow/catalog", {
      method: "POST",
      body: { url: "https://example.feishu.cn/wiki/wik_doc" },
    });

    assert.equal(result.response.status, 400);
    assert.deepEqual(result.body, {
      error: {
        code: "FEISHU_WIKI_NOT_BASE",
        message: "该知识库链接不是多维表格",
      },
    });
    assert.doesNotMatch(JSON.stringify(result.body), /private|wik_doc/i);
  } finally {
    await app.close();
    await new Promise((resolve) => bridge.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("Wiki Base preview rejects a malformed successful Bridge response as an upstream failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-wiki-malformed-"));
  const malformedPreviews = [
    { baseToken: "bas_incomplete", tables: [] },
    { baseToken: "bas_incomplete", baseName: "不完整", tables: {} },
    {
      baseToken: "bas_incomplete",
      baseName: "不完整",
      tables: [{ tableId: "tbl_missing_fields", tableName: "缺少字段" }],
    },
    {
      baseToken: "bas_incomplete",
      baseName: "不完整",
      tables: [{
        tableId: "tbl_missing_type",
        tableName: "缺少字段类型",
        fields: [{ fieldId: "fld_status", fieldName: "状态", uiType: null, options: [] }],
      }],
    },
    {
      baseToken: "bas_incomplete",
      baseName: "不完整",
      metadataRefreshedAt: { internal: "private timestamp object" },
      tables: [],
    },
    {
      baseToken: "bas_incomplete",
      baseName: "不完整",
      tables: [
        { tableId: "tbl_duplicate", tableName: "重复一", fields: [] },
        { tableId: "tbl_duplicate", tableName: "重复二", fields: [] },
      ],
    },
  ];
  const bridge = createServer(async (incoming, response) => {
    for await (const _chunk of incoming) { /* drain */ }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(malformedPreviews.shift()));
  });
  await new Promise((resolve, reject) => {
    bridge.once("error", reject);
    bridge.listen(0, "127.0.0.1", resolve);
  });
  const bridgeAddress = bridge.address();
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    feishuBridgeUrl: `http://127.0.0.1:${bridgeAddress.port}`,
    feishuPackages: { packages: {} },
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    for (const suffix of ["name", "tables", "fields", "type", "timestamp", "duplicate"]) {
      const result = await request(baseUrl, "/api/local/feishu/workflow/catalog", {
        method: "POST",
        body: { url: `https://example.feishu.cn/wiki/wik_incomplete_${suffix}` },
      });
      assert.equal(result.response.status, 502);
      assert.deepEqual(result.body, {
        error: {
          code: "FEISHU_METADATA_INVALID_RESPONSE",
          message: "飞书返回了无法识别的多维表格信息",
        },
      });
    }
    assert.deepEqual(
      (await request(baseUrl, "/api/local/feishu/workflow/catalog")).body.catalog,
      [],
    );
  } finally {
    await app.close();
    await new Promise((resolve) => bridge.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("Wiki Base preview strips unexpected Bridge properties before persisting metadata", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-wiki-sanitize-"));
  const bridge = createServer(async (incoming, response) => {
    for await (const _chunk of incoming) { /* drain */ }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      baseToken: "bas_sanitized",
      baseName: "安全课程库",
      metadataRefreshedAt: 1710000000000,
      internal: "private base details",
      tables: [{
        tableId: "tbl_subject",
        tableName: "语文",
        internal: "private table details",
        fields: [{
          fieldId: "fld_status",
          fieldName: "状态",
          type: 3,
          uiType: "SingleSelect",
          internal: "private field details",
          options: [{
            id: "opt_ready",
            name: "待剪辑",
            color: 1,
            internal: "private option details",
          }],
        }],
      }],
    }));
  });
  await new Promise((resolve, reject) => {
    bridge.once("error", reject);
    bridge.listen(0, "127.0.0.1", resolve);
  });
  const bridgeAddress = bridge.address();
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    feishuBridgeUrl: `http://127.0.0.1:${bridgeAddress.port}`,
    feishuPackages: { packages: {} },
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const result = await request(baseUrl, "/api/local/feishu/workflow/catalog", {
      method: "POST",
      body: { url: "https://example.feishu.cn/wiki/wik_sanitized" },
    });

    assert.equal(result.response.status, 201);
    assert.equal(result.body.catalog[0].metadataRefreshedAt, 1710000000000);
    assert.deepEqual(result.body.catalog[0].subjects[0].metadata, {
      fields: [{
        fieldId: "fld_status",
        fieldName: "状态",
        type: 3,
        uiType: "SingleSelect",
        options: [{ id: "opt_ready", name: "待剪辑", color: 1 }],
      }],
    });
    assert.doesNotMatch(JSON.stringify(result.body), /private .* details/i);
  } finally {
    await app.close();
    await new Promise((resolve) => bridge.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("default Bridge workflow sync identifies Taskboard with the dedicated client header", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-sync-header-"));
  let receivedClient = null;
  let receivedExpectedVersion = null;
  let receivedSubjectVersion = null;
  const bridge = createServer(async (incoming, response) => {
    receivedClient = incoming.headers["x-feishu-bridge-client"] ?? null;
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    if (receivedClient !== "taskboard") {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "BRIDGE_CLIENT_REQUIRED" } }));
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    receivedExpectedVersion = body.expectedVersion;
    receivedSubjectVersion = body.subject?.configVersion;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ subject: body.subject }));
  });
  await new Promise((resolve, reject) => {
    bridge.once("error", reject);
    bridge.listen(0, "127.0.0.1", resolve);
  });
  const bridgeAddress = bridge.address();
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    feishuBridgeUrl: `http://127.0.0.1:${bridgeAddress.port}`,
    feishuPackages: {
      packages: {
        "Auto-cut-A": { projectId: "auto-cut-a", workspacePath: directory, prompt: "fixture prompt" },
      },
    },
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const catalog = await request(baseUrl, "/api/local/feishu/workflow/catalog", {
      method: "POST",
      body: {
        baseToken: "bas_sync_header",
        baseName: "同步请求头",
        tables: [{
          tableId: "tbl_subject",
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
    const subject = catalog.body.catalog[0].subjects[0];
    const key = encodeURIComponent(subject.subjectKey);
    const draft = await request(baseUrl, `/api/local/feishu/workflow/subjects/${key}`, {
      method: "PATCH",
      body: {
        trigger: { fieldId: "fld_status", fieldName: "状态", startValue: "待剪辑", optionId: "opt_ready" },
        execution: { mode: "manual", concurrencyGroup: "sync-header", maxConcurrent: 1, resourceGroups: [] },
        packageRoute: { routeMode: "fixed", packageAlias: "Auto-cut-A", subjectCodeFieldId: null, branchMap: null },
        upload: { enqueueMode: "manual", artifactSourceMode: "manual_select", artifactSourcePath: null, targetId: null, targetPath: null, uploadConcurrency: 1 },
      },
    });
    const enabled = await request(baseUrl, `/api/local/feishu/workflow/subjects/${key}/enable`, {
      method: "POST",
      body: { expectedVersion: draft.body.subject.configVersion },
    });
    assert.equal(enabled.response.status, 200);
    assert.equal(receivedClient, "taskboard");
    assert.equal(receivedExpectedVersion, draft.body.subject.configVersion);
    assert.equal(receivedSubjectVersion, draft.body.subject.configVersion + 1);
  } finally {
    await app.close();
    await new Promise((resolve) => bridge.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("share import asks the loopback Bridge for live diagnostics and merges local diagnostics", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-share-bridge-"));
  let receivedClient = null;
  let receivedDryRun = null;
  let receivedPath = null;
  let receivedContentType = null;
  const bridge = createServer(async (incoming, response) => {
    receivedClient = incoming.headers["x-feishu-bridge-client"] ?? null;
    receivedPath = incoming.url;
    receivedContentType = incoming.headers["content-type"] ?? null;
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    receivedDryRun = body.dryRun;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      configuration: body.configuration,
      dryRun: body.dryRun,
      diagnostics: [{
        code: "FIELD_NOT_FOUND",
        severity: "warning",
        path: "C:\\Users\\secret\\field.txt",
        message: "SDK failed while reading C:\\Users\\secret\\field.txt",
        alias: "FEISHUAPPSECRET123",
        sdkError: "shared-secret-sdk-error",
      }, {
        code: "PACKAGE_WORKSPACE_PATH_UNBOUND",
        severity: "error",
        path: "bases.bas_share.subjects.tbl_subject.packageRoute",
        message: "Bridge package points to D:\\Auto-Cut\\secret",
      }, {
        code: "UPLOAD_TARGET_PATH_UNBOUND",
        severity: "warning",
        path: "bases.bas_share.subjects.tbl_subject.upload.targetPath",
        message: "Bridge has no Taskboard-local upload target binding",
      }],
    }));
  });
  await new Promise((resolve, reject) => {
    bridge.once("error", reject);
    bridge.listen(0, "127.0.0.1", resolve);
  });
  const bridgeAddress = bridge.address();
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    feishuBridgeUrl: `http://127.0.0.1:${bridgeAddress.port}`,
    feishuPackages: {
      packages: {
        "Auto-cut-A": { projectId: "auto-cut-a", workspacePath: directory, prompt: "fixture prompt" },
      },
    },
  });
  const configuration = {
    schemaVersion: 1,
    bases: [{
      baseToken: "bas_share",
      baseName: "共享 Base",
      subjects: [{
        subjectKey: "bas_share:tbl_subject",
        baseToken: "bas_share",
        baseName: "共享 Base",
        tableId: "tbl_subject",
        tableName: "语文",
        displayEnabled: true,
        lifecycle: "draft",
        configVersion: 1,
        trigger: { fieldId: "fld_missing", fieldName: "进度", startValue: "待制作", optionId: null },
        title: { fieldId: null, fieldName: null },
        execution: { mode: "manual", concurrencyGroup: "default", maxConcurrent: 1, resourceGroups: [] },
        packageRoute: {
          routeMode: "fixed",
          packageAlias: "Auto-cut-missing",
          subjectCodeFieldId: null,
          branchMap: { B: "Auto-cut-missing-B", C: "Auto-cut-missing-C" },
        },
        upload: { enqueueMode: "manual", artifactSourceMode: "manual_select", artifactSourcePath: null, targetId: null, targetPath: null, uploadConcurrency: 1 },
      }],
    }],
  };
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const result = await request(
      `http://127.0.0.1:${address.port}`,
      "/api/local/feishu/workflow/share/import",
      { method: "POST", body: { configuration, dryRun: true } },
    );
    assert.equal(result.response.status, 200);
    assert.equal(receivedClient, "local-operator");
    assert.equal(receivedDryRun, true);
    assert.equal(receivedPath, "/api/feishu/workflow/share/import");
    assert.equal(receivedContentType, "application/json");
    assert.ok(result.body.diagnostics.some((entry) => entry.code === "FIELD_NOT_FOUND"));
    assert.ok(result.body.diagnostics.some((entry) => entry.code === "PACKAGE_ALIAS_UNAVAILABLE"));
    assert.ok(result.body.diagnostics.some((entry) => entry.code === "PACKAGE_WORKSPACE_PATH_UNBOUND"));
    assert.equal(result.body.diagnostics.some((entry) => entry.code === "UPLOAD_TARGET_PATH_UNBOUND"), false);
    assert.deepEqual(
      result.body.diagnostics
        .filter((entry) => entry.code === "PACKAGE_ALIAS_UNAVAILABLE")
        .map((entry) => entry.alias)
        .sort(),
      ["Auto-cut-missing", "Auto-cut-missing-B", "Auto-cut-missing-C"],
    );
    assert.doesNotMatch(
      JSON.stringify(result.body),
      /shared-secret-sdk-error|Users\\\\secret|Auto-Cut\\\\secret|FEISHUAPPSECRET123/,
    );
    assert.equal(result.body.diagnosticsOk, false);
    assert.equal(result.body.dryRun, true);
    assert.deepEqual((await request(`http://127.0.0.1:${address.port}`, "/api/local/feishu/workflow/catalog")).body.catalog, []);
  } finally {
    await app.close();
    await new Promise((resolve) => bridge.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("share import rejects a non-loopback Bridge before changing the local catalog", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-share-non-loopback-"));
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    feishuBridgeUrl: "http://localhost:47824",
    feishuPackages: {
      packages: {
        "Auto-cut-A": { projectId: "auto-cut-a", workspacePath: directory, prompt: "fixture prompt" },
      },
    },
  });
  const configuration = {
    schemaVersion: 1,
    bases: [{
      baseToken: "bas_rejected",
      baseName: "拒绝导入 Base",
      subjects: [{
        subjectKey: "bas_rejected:tbl_subject",
        baseToken: "bas_rejected",
        baseName: "拒绝导入 Base",
        tableId: "tbl_subject",
        tableName: "语文",
        displayEnabled: true,
        lifecycle: "draft",
        configVersion: 1,
        trigger: { fieldId: "fld_status", fieldName: "进度", startValue: "待制作", optionId: null },
        title: { fieldId: null, fieldName: null },
        execution: { mode: "manual", concurrencyGroup: "default", maxConcurrent: 1, resourceGroups: [] },
        packageRoute: { routeMode: "fixed", packageAlias: "Auto-cut-A", subjectCodeFieldId: null, branchMap: null },
        upload: { enqueueMode: "manual", artifactSourceMode: "manual_select", artifactSourcePath: null, targetId: null, targetPath: null, uploadConcurrency: 1 },
      }],
    }],
  };
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const result = await request(baseUrl, "/api/local/feishu/workflow/share/import", {
      method: "POST",
      body: { configuration, dryRun: false },
    });
    assert.equal(result.response.status, 503);
    assert.equal(result.body.error.code, "FEISHU_BRIDGE_UNAVAILABLE");
    assert.deepEqual((await request(baseUrl, "/api/local/feishu/workflow/catalog")).body.catalog, []);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("share import refuses Bridge redirects without forwarding the operator request", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-share-redirect-"));
  let redirectedRequests = 0;
  const redirected = createServer(async (incoming, response) => {
    redirectedRequests += 1;
    for await (const _chunk of incoming) { /* drain */ }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ configuration: {}, diagnostics: [] }));
  });
  await new Promise((resolve, reject) => {
    redirected.once("error", reject);
    redirected.listen(0, "127.0.0.1", resolve);
  });
  const redirectedAddress = redirected.address();
  const bridge = createServer(async (incoming, response) => {
    for await (const _chunk of incoming) { /* drain */ }
    response.writeHead(307, {
      location: `http://127.0.0.1:${redirectedAddress.port}/captured`,
    });
    response.end();
  });
  await new Promise((resolve, reject) => {
    bridge.once("error", reject);
    bridge.listen(0, "127.0.0.1", resolve);
  });
  const bridgeAddress = bridge.address();
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    feishuBridgeUrl: `http://127.0.0.1:${bridgeAddress.port}`,
    feishuPackages: {
      packages: {
        "Auto-cut-A": { projectId: "auto-cut-a", workspacePath: directory, prompt: "fixture prompt" },
      },
    },
  });
  const configuration = {
    schemaVersion: 1,
    bases: [{
      baseToken: "bas_redirect",
      baseName: "重定向 Base",
      subjects: [{
        subjectKey: "bas_redirect:tbl_subject",
        baseToken: "bas_redirect",
        baseName: "重定向 Base",
        tableId: "tbl_subject",
        tableName: "语文",
        displayEnabled: true,
        lifecycle: "draft",
        configVersion: 1,
        trigger: { fieldId: "fld_status", fieldName: "进度", startValue: "待制作", optionId: null },
        title: { fieldId: null, fieldName: null },
        execution: { mode: "manual", concurrencyGroup: "default", maxConcurrent: 1, resourceGroups: [] },
        packageRoute: { routeMode: "fixed", packageAlias: "Auto-cut-A", subjectCodeFieldId: null, branchMap: null },
        upload: { enqueueMode: "manual", artifactSourceMode: "manual_select", artifactSourcePath: null, targetId: null, targetPath: null, uploadConcurrency: 1 },
      }],
    }],
  };
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const result = await request(
      `http://127.0.0.1:${address.port}`,
      "/api/local/feishu/workflow/share/import",
      { method: "POST", body: { configuration, dryRun: false } },
    );
    assert.equal(result.response.status, 503);
    assert.equal(result.body.error.code, "FEISHU_BRIDGE_UNAVAILABLE");
    assert.equal(redirectedRequests, 0);
    assert.deepEqual((await request(`http://127.0.0.1:${address.port}`, "/api/local/feishu/workflow/catalog")).body.catalog, []);
  } finally {
    await app.close();
    await new Promise((resolve) => bridge.close(resolve));
    await new Promise((resolve) => redirected.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("committed share import returns diagnostics recomputed at commit time", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-share-recheck-"));
  let packageReads = 0;
  const packageConfig = {
    "Auto-cut-A": {
      projectId: "auto-cut-a",
      projectName: "Auto-cut-A",
      workspacePath: directory,
      prompt: "fixture prompt",
    },
  };
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    feishuPackageStore: {
      async read() {
        packageReads += 1;
        return packageReads === 1 ? packageConfig : {};
      },
    },
    feishuWorkflowShareImport: async (configuration) => ({ configuration, diagnostics: [] }),
  });
  const configuration = {
    schemaVersion: 1,
    bases: [{
      baseToken: "bas_recheck",
      baseName: "重检 Base",
      subjects: [{
        subjectKey: "bas_recheck:tbl_subject",
        baseToken: "bas_recheck",
        baseName: "重检 Base",
        tableId: "tbl_subject",
        tableName: "语文",
        displayEnabled: true,
        lifecycle: "draft",
        configVersion: 1,
        trigger: { fieldId: "fld_status", fieldName: "进度", startValue: "待制作", optionId: null },
        title: { fieldId: null, fieldName: null },
        execution: { mode: "manual", concurrencyGroup: "default", maxConcurrent: 1, resourceGroups: [] },
        packageRoute: { routeMode: "fixed", packageAlias: "Auto-cut-A", subjectCodeFieldId: null, branchMap: null },
        upload: { enqueueMode: "manual", artifactSourceMode: "manual_select", artifactSourcePath: null, targetId: null, targetPath: null, uploadConcurrency: 1 },
      }],
    }],
  };
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const result = await request(baseUrl, "/api/local/feishu/workflow/share/import", {
      method: "POST",
      body: { configuration, dryRun: false },
    });
    assert.equal(result.response.status, 200);
    assert.equal(packageReads, 2);
    assert.ok(result.body.diagnostics.some((entry) => entry.code === "PACKAGE_ALIAS_UNAVAILABLE"));
    assert.equal(result.body.diagnosticsOk, false);
    assert.equal((await request(baseUrl, "/api/local/feishu/workflow/catalog")).body.catalog[0].subjects[0].lifecycle, "draft");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("workflow sync maps untrusted Bridge error codes to a safe local error", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-sync-error-"));
  const bridge = createServer(async (incoming, response) => {
    for await (const _chunk of incoming) { /* drain */ }
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: {
        code: "FEISHUAPPSECRET_LEAK",
        message: "secret workspace path should never cross the boundary",
      },
    }));
  });
  await new Promise((resolve, reject) => {
    bridge.once("error", reject);
    bridge.listen(0, "127.0.0.1", resolve);
  });
  const bridgeAddress = bridge.address();
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: process.execPath,
    feishuBridgeUrl: `http://127.0.0.1:${bridgeAddress.port}`,
    feishuPackages: {
      packages: {
        "Auto-cut-A": { projectId: "auto-cut-a", workspacePath: directory, prompt: "fixture prompt" },
      },
    },
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const preview = await request(baseUrl, "/api/local/feishu/workflow/catalog", {
      method: "POST",
      body: {
        baseToken: "bas_sync_error",
        baseName: "同步错误 Base",
        tables: [{
          tableId: "tbl_subject",
          tableName: "语文",
          fields: [{ fieldId: "fld_status", fieldName: "进度", type: 1, options: [] }],
        }],
      },
    });
    assert.equal(preview.response.status, 201);
    const key = encodeURIComponent("bas_sync_error:tbl_subject");
    const draft = await request(baseUrl, `/api/local/feishu/workflow/subjects/${key}`, {
      method: "PATCH",
      body: {
        trigger: { fieldId: "fld_status", fieldName: "进度", startValue: "待制作", optionId: null },
        execution: { mode: "manual", concurrencyGroup: "default", maxConcurrent: 1, resourceGroups: [] },
        packageRoute: { routeMode: "fixed", packageAlias: "Auto-cut-A", subjectCodeFieldId: null, branchMap: null },
        upload: { enqueueMode: "manual", artifactSourceMode: "manual_select", artifactSourcePath: null, targetId: null, targetPath: null, uploadConcurrency: 1 },
      },
    });
    assert.equal(draft.response.status, 200);
    const enabled = await request(baseUrl, `/api/local/feishu/workflow/subjects/${key}/enable`, {
      method: "POST",
      body: { expectedVersion: draft.body.subject.configVersion },
    });
    assert.equal(enabled.response.status, 409);
    assert.equal(enabled.body.error.code, "FEISHU_WORKFLOW_SYNC_FAILED");
    assert.doesNotMatch(JSON.stringify(enabled.body), /FEISHUAPPSECRET|secret workspace/i);
  } finally {
    await app.close();
    await new Promise((resolve) => bridge.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
