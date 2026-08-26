import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

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
      ...draft,
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
