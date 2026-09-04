import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { createFeishuPackageApi } from "../server/feishu-package-api.mjs";
import { createFeishuPackageStore } from "../server/feishu-package-config.mjs";

test("local Auto-Cut package API exposes CRUD and catalog discovery", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-package-api-"));
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  const store = createFeishuPackageStore({ filename: path.join(directory, "packages.json") });
  const api = createFeishuPackageApi({
    store,
    getModelCatalog: async (workspacePath) => ({
      workspacePath,
      models: [{ slug: "gpt-test", supportedReasoningEfforts: ["high"] }],
    }),
  });
  const call = (method, pathname, body = null) => api.handle({ method, pathname, body });
  try {
    const created = await call("POST", "/api/local/autocut/packages", {
      alias: "Auto-cut-api",
      name: "API package",
      projectId: "auto-cut-api",
    });
    assert.equal(created.status, 201);
    const draft = created.body.package;
    const catalog = await call("POST", "/api/local/autocut/packages/catalog", { workspacePath: workspace });
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.models[0].slug, "gpt-test");
    const saved = await call("PATCH", "/api/local/autocut/packages/Auto-cut-api", {
      alias: draft.alias,
      name: draft.name,
      projectId: draft.projectId,
      expectedRevision: draft.revision,
      workspacePath: workspace,
      model: "gpt-test",
      reasoningEffort: "high",
      prompt: "fixture prompt",
    });
    const enabled = await call("POST", "/api/local/autocut/packages/Auto-cut-api/enable", {
      revision: saved.body.package.revision,
    });
    assert.equal(enabled.body.package.state, "enabled");
    const listed = await call("GET", "/api/local/autocut/packages");
    assert.equal(listed.body.packages.length, 1);
    const disabled = await call("POST", "/api/local/autocut/packages/Auto-cut-api/disable", {
      revision: enabled.body.package.revision,
    });
    assert.equal(disabled.body.package.state, "disabled");
    const removed = await call("DELETE", "/api/local/autocut/packages/Auto-cut-api", {
      revision: disabled.body.package.revision,
    });
    assert.equal(removed.body.package.alias, "Auto-cut-api");
    await assert.rejects(() => call("DELETE", "/api/local/autocut/packages/Auto-cut-api"), (error) => error.code === "INVALID_FIELD");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("POST package creation rejects all server-managed fields", async () => {
  const store = createFeishuPackageStore({ packages: {} });
  const api = createFeishuPackageApi({ store });
  for (const field of ["revision", "expectedRevision", "state", "updatedAt"]) {
    await assert.rejects(
      () => api.handle({
        method: "POST",
        pathname: "/api/local/autocut/packages",
        body: { alias: `Auto-cut-post-${field}`, name: "Post", projectId: "post", [field]: field === "state" ? "enabled" : 1 },
      }),
      (error) => error.code === "UNKNOWN_FIELD",
    );
  }
});

test("package mutations reject server-managed fields and catalog validates workspace first", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-package-api-invalid-"));
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  let catalogCalls = 0;
  const store = createFeishuPackageStore({ filename: path.join(directory, "packages.json") });
  const api = createFeishuPackageApi({ store, getModelCatalog: async () => { catalogCalls += 1; throw new Error("internal"); } });
  const call = (method, pathname, body = null) => api.handle({ method, pathname, body });
  try {
    await assert.rejects(() => call("POST", "/api/local/autocut/packages", {
      alias: "Auto-cut-invalid", name: "Invalid", projectId: "auto-cut-invalid", state: "enabled",
    }), (error) => error.code === "UNKNOWN_FIELD");
    await assert.rejects(() => call("POST", "/api/local/autocut/packages", {
      alias: "Auto-cut-invalid", name: "Invalid", projectId: "auto-cut-invalid", revision: 99,
    }), (error) => error.code === "UNKNOWN_FIELD");
    await assert.rejects(() => call("POST", "/api/local/autocut/packages/catalog", {
      workspacePath: path.join(directory, "missing"),
    }), (error) => error.code === "PACKAGE_WORKSPACE_UNAVAILABLE");
    assert.equal(catalogCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog maps discovery failures to a stable controlled error", async () => {
  const store = createFeishuPackageStore({ packages: {} });
  const api = createFeishuPackageApi({ store, getModelCatalog: async () => { throw new Error("sensitive internal output"); } });
  await assert.rejects(
    () => api.handle({
      method: "POST",
      pathname: "/api/local/autocut/packages/catalog",
      body: { workspacePath: process.cwd() },
    }),
    (error) => error.code === "PACKAGE_MODEL_CATALOG_UNAVAILABLE",
  );
});

test("package listing includes real reference summaries from the store", async () => {
  const base = {
    alias: "Auto-cut-references",
    name: "References",
    projectId: "references",
    workspacePath: null,
    model: null,
    reasoningEffort: null,
    prompt: null,
    zipSourceDirectory: null,
    maxConcurrent: 1,
  };
  const store = createFeishuPackageStore({ packages: { [base.alias]: base } });
  const original = store.references;
  let calledWith = null;
  store.references = async (alias) => {
    calledWith = alias;
    return [{ subjectKey: "base/table", subjectName: "语文" }];
  };
  const api = createFeishuPackageApi({ store });
  const result = await api.handle({ method: "GET", pathname: "/api/local/autocut/packages", body: null });
  assert.equal(calledWith, base.alias);
  assert.deepEqual(result.body.packages[0].references, [{ subjectKey: "base/table", subjectName: "语文" }]);
  assert.equal(result.body.packages[0].referenceCount, 1);
  store.references = original;
});

test("production server blocks deletion for enabled subjects and unfinished tasks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-package-references-"));
  const alias = "Auto-cut-production";
  const app = createTaskboardServer({
    dataDirectory: directory,
    feishuPackages: {
      [alias]: {
        alias,
        name: "Production package",
        projectId: "production-package",
        workspacePath: null,
        model: null,
        reasoningEffort: null,
        prompt: null,
        zipSourceDirectory: null,
        maxConcurrent: 1,
        state: "draft",
      },
    },
  });
  const timestamp = new Date().toISOString();
  const config = {
    packageRoute: { routeMode: "fixed", packageAlias: alias, subjectCodeFieldId: null, branchMap: null },
  };
  app.database.database.prepare(`
    INSERT INTO feishu_bases (base_token, base_name, source_url_label, metadata_refreshed_at, created_at, updated_at)
    VALUES (?, ?, NULL, NULL, ?, ?)
  `).run("base-production", "生产 Base", timestamp, timestamp);
  app.database.database.prepare(`
    INSERT INTO feishu_subjects (
      subject_key, base_token, table_id, table_name, project_id, display_enabled,
      lifecycle, config_version, config_json, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, 'enabled', 1, ?, '{}', ?, ?)
  `).run(
    "base-production:table-chinese",
    "base-production",
    "table-chinese",
    "语文",
    "feishu-production",
    JSON.stringify(config),
    timestamp,
    timestamp,
  );
  const actor = { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };
  app.database.createTask({
    projectId: "local",
    title: "待剪辑视频",
    description: "",
    status: "todo",
    priority: "none",
    labels: ["feishu"],
    actor,
    assignee: actor,
    workflowId: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
    feishuOrigin: {
      source: "feishu-base",
      eventId: "evt-production",
      baseToken: "base-production",
      tableId: "table-chinese",
      recordId: "record-1",
      subjectKey: "base-production:table-chinese",
      packageAlias: alias,
    },
  });

  try {
    const address = await app.listen({ port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const listedResponse = await fetch(`${baseUrl}/api/local/autocut/packages`);
    const listed = await listedResponse.json();
    assert.equal(listed.packages[0].referenceCount, 2);
    assert.deepEqual(listed.packages[0].references.map((reference) => reference.type).sort(), ["subject", "task"]);

    const removedResponse = await fetch(`${baseUrl}/api/local/autocut/packages/${alias}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: listed.packages[0].revision }),
    });
    const removed = await removedResponse.json();
    assert.equal(removedResponse.status, 409);
    assert.equal(removed.error.code, "PACKAGE_IN_USE");
    assert.equal(removed.error.details.references.length, 2);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
