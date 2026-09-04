import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-feishu-share-"));
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
    feishuWorkflowShareImport: async (configuration) => ({
      configuration,
      diagnostics: [],
      diagnosticsOk: true,
      dryRun: true,
    }),
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
  let body = null;
  try { body = await response.json(); } catch {}
  return { response, body };
}

async function seedSubject(baseUrl, baseToken = "bas_share") {
  const preview = await request(baseUrl, "/api/local/feishu/workflow/catalog", {
    method: "POST",
    body: {
      baseToken,
      baseName: "共享配置 Base",
      sourceUrlLabel: "https://example.test/base/share",
      tables: [{ tableId: "tbl_chinese", tableName: "语文", fields: [] }],
    },
  });
  assert.equal(preview.response.status, 201);
  const subjectKey = `${baseToken}:tbl_chinese`;
  const saved = await request(baseUrl, `/api/local/feishu/workflow/subjects/${encodeURIComponent(subjectKey)}`, {
    method: "PATCH",
    body: {
      trigger: { fieldId: "fld_progress", fieldName: "制作进度", startValue: "待制作", optionId: "opt_ready" },
      title: { fieldId: "fld_title", fieldName: "脚本名称" },
      execution: { mode: "automatic", concurrencyGroup: "autocut", maxConcurrent: 3, resourceGroups: ["jianying-desktop"] },
      packageRoute: { routeMode: "fixed", packageAlias: "Auto-cut-A", subjectCodeFieldId: null, branchMap: null },
      upload: {
        enqueueMode: "automatic",
        artifactSourceMode: "watch_directory",
        artifactSourcePath: "C:\\Users\\admin\\Desktop\\Auto-Cut-待上传",
        targetId: "nas-primary",
        targetPath: "\\\\nas\\剪映草稿\\语文",
        uploadConcurrency: 2,
      },
    },
  });
  assert.equal(saved.response.status, 200);
  return subjectKey;
}

test("workflow share export is schema-versioned and redacts machine-local paths", async () => {
  const fixtureData = await fixture();
  try {
    await seedSubject(fixtureData.baseUrl);
    const exported = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/export");
    assert.equal(exported.response.status, 200);
    assert.equal(exported.body.configuration.schemaVersion, 1);
    const subject = exported.body.configuration.bases[0].subjects[0];
    assert.equal(subject.baseToken, "bas_share");
    assert.equal(subject.tableName, "语文");
    assert.equal(subject.execution.maxConcurrent, 3);
    assert.equal(subject.packageRoute.packageAlias, "Auto-cut-A");
    assert.equal(subject.upload.artifactSourcePath, null);
    assert.equal(subject.upload.targetPath, null);
    const serialized = JSON.stringify(exported.body.configuration);
    assert.doesNotMatch(serialized, /Users\\admin|nas\\剪映草稿|workspacePath|appSecret|claimToken|taskHistory|logs/i);
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("workflow share import dry-run returns diagnostics without mutating the catalog", async () => {
  const fixtureData = await fixture();
  try {
    const subjectKey = await seedSubject(fixtureData.baseUrl);
    const exported = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/export");
    const before = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/catalog");
    const configuration = structuredClone(exported.body.configuration);
    configuration.bases[0].subjects[0].packageRoute.packageAlias = "Auto-cut-小学语文";
    const dryRun = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/import", {
      method: "POST",
      body: { configuration, dryRun: true },
    });
    assert.equal(dryRun.response.status, 200);
    assert.equal(dryRun.body.dryRun, true);
    assert.ok(Array.isArray(dryRun.body.diagnostics));
    assert.ok(dryRun.body.diagnostics.some((entry) => entry.code === "PACKAGE_ALIAS_UNAVAILABLE"));
    assert.equal(dryRun.body.configuration.bases[0].subjects[0].lifecycle, "draft");
    const after = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/catalog");
    assert.deepEqual(after.body.catalog, before.body.catalog);
    assert.equal(subjectKey, "bas_share:tbl_chinese");
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("workflow share import commits only drafts and keeps local path bindings", async () => {
  const fixtureData = await fixture();
  try {
    const subjectKey = await seedSubject(fixtureData.baseUrl, "bas_source");
    const exported = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/export");
    const configuration = structuredClone(exported.body.configuration);
    configuration.bases[0].subjects[0].baseToken = "bas_source";
    configuration.bases[0].subjects[0].subjectKey = subjectKey;
    const imported = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/import", {
      method: "POST",
      body: { configuration, dryRun: false },
    });
    assert.equal(imported.response.status, 200);
    assert.equal(imported.body.dryRun, false);
    assert.equal(imported.body.configuration.bases[0].subjects[0].lifecycle, "draft");
    const catalog = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/catalog");
    const subject = catalog.body.catalog[0].subjects[0];
    assert.equal(subject.lifecycle, "draft");
    assert.equal(subject.upload.artifactSourcePath, "C:\\Users\\admin\\Desktop\\Auto-Cut-待上传");
    assert.equal(subject.upload.targetPath, "\\\\nas\\剪映草稿\\语文");
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});

test("workflow share routes reject unsupported schemas and strip imported path/runtime fields", async () => {
  const fixtureData = await fixture();
  try {
    const badSchema = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/import", {
      method: "POST",
      body: { configuration: { schemaVersion: 99, bases: [] }, dryRun: true },
    });
    assert.equal(badSchema.response.status, 400);
    assert.equal(badSchema.body.error.code, "UNSUPPORTED_SCHEMA_VERSION");

    const configuration = {
      schemaVersion: 1,
      bases: [{
        baseToken: "bas_untrusted",
        baseName: "不可信 Base",
        sourceUrlLabel: "https://user:secret@example.test/base?token=secret",
        subjects: [{
          subjectKey: "bas_untrusted:tbl_subject",
          baseToken: "bas_untrusted",
          baseName: "不可信 Base",
          tableId: "tbl_subject",
          tableName: "语文",
          displayEnabled: true,
          trigger: { fieldId: "fld_progress", fieldName: "进度", startValue: "待制作", optionId: null },
          title: { fieldId: null, fieldName: null },
          execution: { mode: "manual", concurrencyGroup: "default", maxConcurrent: 1, resourceGroups: [] },
          packageRoute: { routeMode: "fixed", packageAlias: "Auto-cut-A", subjectCodeFieldId: null, branchMap: null },
          upload: {
            enqueueMode: "manual", artifactSourceMode: "manual_select",
            artifactSourcePath: "C:\\secret\\source", targetId: "target", targetPath: "C:\\secret\\target", uploadConcurrency: 1,
          },
          metadata: { fields: [{ fieldId: "fld_progress", fieldName: "进度", workspacePath: "C:\\secret" }], claimToken: "secret" },
        }],
      }],
    };
    const imported = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/share/import", {
      method: "POST", body: { configuration, dryRun: false },
    });
    assert.equal(imported.response.status, 200);
    const catalog = await request(fixtureData.baseUrl, "/api/local/feishu/workflow/catalog");
    const serialized = JSON.stringify(catalog.body.catalog);
    assert.doesNotMatch(serialized, /secret|workspacePath|claimToken|taskHistory/i);
    assert.equal(catalog.body.catalog[0].sourceUrlLabel, "https://example.test/base");
    assert.equal(catalog.body.catalog[0].subjects[0].upload.artifactSourcePath, null);
    assert.equal(catalog.body.catalog[0].subjects[0].upload.targetPath, null);
  } finally {
    await fixtureData.app.close();
    await rm(fixtureData.directory, { recursive: true, force: true });
  }
});
