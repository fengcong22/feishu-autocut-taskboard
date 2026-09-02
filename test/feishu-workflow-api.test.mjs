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
