import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-api-"));
  const app = createTaskboardServer({ dataDirectory: directory, codexExecutable: process.execPath });
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

test("local Feishu workflow API persists preview and subject lifecycle", async () => {
  const fixtureData = await fixture();
  try {
    const preview = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/catalog", {
      method: "POST",
      body: { baseToken: "bas_api", baseName: "API Base", tables: [{ tableId: "tbl_a", tableName: "语文", fields: [] }] },
    });
    assert.equal(preview.response.status, 201);
    assert.equal(preview.body.catalog[0].subjects[0].lifecycle, "draft");
    const key = encodeURIComponent("bas_api:tbl_a");
    const draft = await request(fixtureData.baseUrl, `/api/local/feishu/workflow/subjects/${key}`, {
      method: "PATCH",
      body: { trigger: { fieldId: "fld_status", fieldName: "状态", startValue: "待剪辑", optionId: null }, title: { fieldId: null, fieldName: null }, execution: { mode: "manual", concurrencyGroup: "g", maxConcurrent: 1, resourceGroups: [] }, packageRoute: { routeMode: "fixed", packageAlias: "Auto-cut-A", subjectCodeFieldId: null, branchMap: null }, upload: { enqueueMode: "manual", artifactSourceMode: "manual_select", artifactSourcePath: null, targetId: null, targetPath: null, uploadConcurrency: 1 } },
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

