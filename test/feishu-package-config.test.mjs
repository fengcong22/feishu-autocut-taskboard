import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createFeishuPackageStore,
  normalizeFeishuPackages,
  PackageConfigError,
} from "../server/feishu-package-config.mjs";

test("managed Auto-Cut package store supports draft, enable, snapshot and CAS", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-package-store-"));
  const registryPath = path.join(directory, "autocut-packages.json");
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  let now = 0;
  try {
    const store = createFeishuPackageStore({
      filename: registryPath,
      now: () => new Date(++now).toISOString(),
      modelCatalog: {
        models: [{ slug: "gpt-test", supportedReasoningEfforts: ["high"] }],
      },
    });
    const draft = await store.saveDraft({
      alias: "Auto-cut-test",
      name: "Test Auto-Cut",
      projectId: "auto-cut-test",
    });
    assert.equal(draft.state, "draft");
    assert.equal(draft.revision, 1);
    assert.equal(draft.maxConcurrent, 1);
    await assert.rejects(
      () => store.enable(draft.alias, draft.revision),
      (error) => error instanceof PackageConfigError && error.code === "PACKAGE_ENABLE_INVALID",
    );

    const edited = await store.saveDraft({
      alias: draft.alias,
      name: draft.name,
      projectId: draft.projectId,
      workspacePath: workspace,
      model: "gpt-test",
      reasoningEffort: "high",
      prompt: "run the fixture workflow",
      zipSourceDirectory: workspace,
      maxConcurrent: 2,
    }, draft.revision);
    const enabled = await store.enable(edited.alias, edited.revision);
    assert.equal(enabled.state, "enabled");
    assert.equal(enabled.revision, edited.revision + 1);
    assert.equal(enabled.name, "Test Auto-Cut");

    const snapshot = await store.snapshot(enabled.alias);
    snapshot.prompt = "mutated";
    assert.equal((await store.get(enabled.alias)).prompt, "run the fixture workflow");
    await assert.rejects(
      () => store.saveDraft({ alias: enabled.alias, name: "stale", projectId: enabled.projectId }, edited.revision),
      (error) => error instanceof PackageConfigError && error.code === "PACKAGE_REVISION_CONFLICT",
    );

    const persisted = JSON.parse(await readFile(registryPath, "utf8"));
    assert.equal(persisted.version, 1);
    assert.equal(persisted.packages[enabled.alias].state, "enabled");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("package aliases support controlled Chinese subject names", async () => {
  const store = createFeishuPackageStore({ packages: {} });
  const record = await store.saveDraft({
    alias: "Auto-cut-小学语文",
    name: "小学语文 Auto-Cut",
    projectId: "auto-cut-primary-school-chinese",
  });
  assert.equal(record.alias, "Auto-cut-小学语文");
  assert.equal((await store.get("Auto-cut-小学语文")).state, "draft");
});

test("preserves valid aliases that overlap object properties or registry metadata names", async () => {
  const store = createFeishuPackageStore({ packages: {} });
  for (const [index, alias] of ["toString", "host", "version", "tables"].entries()) {
    const record = await store.saveDraft({
      alias,
      name: `Package ${alias}`,
      projectId: `auto-cut-${index}`,
    });
    assert.equal(record.alias, alias);
    assert.equal((await store.get(alias)).alias, alias);
  }
  assert.deepEqual(
    (await store.list()).map((entry) => entry.alias),
    ["toString", "host", "version", "tables"],
  );
});

test("requires an explicit state for versioned registry entries", () => {
  assert.throws(
    () => normalizeFeishuPackages({ version: 1, packages: {
      "Auto-cut-missing-state": {
        projectId: "auto-cut-missing-state",
        workspacePath: null,
        prompt: null,
      },
    } }),
    /state is required/,
  );
});

test("rejects unsupported versions and duplicate enabled project ids", () => {
  assert.throws(
    () => normalizeFeishuPackages({ version: 999, packages: {} }),
    (error) => error.code === "PACKAGE_REGISTRY_UNSUPPORTED",
  );
  assert.throws(
    () => normalizeFeishuPackages({ version: 1, packages: {
      "Auto-cut-one": { projectId: "shared", state: "enabled" },
      "Auto-cut-two": { projectId: "shared", state: "enabled" },
    } }),
    /duplicate package projectId/,
  );
});

test("rejects reserved package aliases", () => {
  assert.throws(
    () => normalizeFeishuPackages({ version: 1, packages: {
      ["__proto__"]: { alias: "__proto__", projectId: "prototype", state: "draft" },
    } }),
    /alias is invalid/,
  );
});

test("remove reports Base/table/task references and aliases remain unique", async () => {
  const refs = [
    { baseToken: "bas_demo", tableId: "tbl_math", tableName: "数学" },
    { taskId: "task-1", title: "剪辑任务" },
  ];
  const store = createFeishuPackageStore({
    packages: {
      "Auto-cut-a": {
        projectId: "auto-cut-a",
        workspacePath: "C:\\Auto-Cut\\a",
        prompt: "fixture",
      },
    },
    listReferences: async () => refs,
  });
  await assert.rejects(
    () => store.remove("Auto-cut-a", 1),
    (error) => error instanceof PackageConfigError
      && error.code === "PACKAGE_IN_USE"
      && error.details.references.length === 2,
  );
  await assert.rejects(
    () => store.saveDraft({ alias: "Auto-cut-a", name: "Duplicate", projectId: "other" }),
    (error) => error instanceof PackageConfigError && error.code === "PACKAGE_ALIAS_EXISTS",
  );
});

test("enable rejects an unsupported model and reasoning effort", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-package-model-"));
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  try {
    const store = createFeishuPackageStore({
      packages: {},
      modelCatalog: { models: [{ slug: "gpt-test", supportedReasoningEfforts: ["low"] }] },
    });
    const draft = await store.saveDraft({
      alias: "Auto-cut-model",
      name: "Model",
      projectId: "auto-cut-model",
      workspacePath: workspace,
      model: "missing-model",
      reasoningEffort: "high",
      prompt: "fixture",
    });
    await assert.rejects(
      () => store.enable(draft.alias, draft.revision),
      (error) => error instanceof PackageConfigError && error.code === "PACKAGE_MODEL_UNAVAILABLE",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("enable rejects a missing model catalog", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-package-no-catalog-"));
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  try {
    const store = createFeishuPackageStore({ packages: {} });
    const draft = await store.saveDraft({
      alias: "Auto-cut-no-catalog",
      name: "No catalog",
      projectId: "auto-cut-no-catalog",
      workspacePath: workspace,
      model: "gpt-test",
      reasoningEffort: "high",
      prompt: "fixture",
    });
    await assert.rejects(
      () => store.enable(draft.alias, draft.revision),
      (error) => error instanceof PackageConfigError && error.code === "PACKAGE_MODEL_CATALOG_UNAVAILABLE",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent mutations serialize compare-and-swap against the latest revision", async () => {
  const store = createFeishuPackageStore({ packages: {} });
  const draft = await store.saveDraft({ alias: "Auto-cut-race", name: "Race", projectId: "auto-cut-race" });
  const results = await Promise.allSettled([
    store.saveDraft("Auto-cut-race", { name: "first" }, draft.revision),
    store.saveDraft("Auto-cut-race", { name: "second" }, draft.revision),
  ]);
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(results.filter((entry) => entry.status === "rejected")[0].reason.code, "PACKAGE_REVISION_CONFLICT");
  assert.equal((await store.get("Auto-cut-race")).revision, 2);
});

test("separate stores sharing a registry serialize compare-and-swap", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-package-shared-race-"));
  const filename = path.join(directory, "packages.json");
  try {
    const firstStore = createFeishuPackageStore({ filename });
    const secondStore = createFeishuPackageStore({ filename });
    const draft = await firstStore.saveDraft({ alias: "Auto-cut-shared", name: "Shared", projectId: "shared" });
    const results = await Promise.allSettled([
      firstStore.saveDraft("Auto-cut-shared", { name: "first" }, draft.revision),
      secondStore.saveDraft("Auto-cut-shared", { name: "second" }, draft.revision),
    ]);
    assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(results.filter((entry) => entry.status === "rejected")[0].reason.code, "PACKAGE_REVISION_CONFLICT");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("separate stores sharing a registry serialize remove and update", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-package-shared-remove-"));
  const filename = path.join(directory, "packages.json");
  try {
    const firstStore = createFeishuPackageStore({ filename });
    const secondStore = createFeishuPackageStore({ filename });
    const draft = await firstStore.saveDraft({ alias: "Auto-cut-shared-remove", name: "Shared", projectId: "shared-remove" });
    const results = await Promise.allSettled([
      secondStore.saveDraft(draft.alias, { name: "updated" }, draft.revision),
      firstStore.remove(draft.alias, draft.revision),
    ]);
    assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.ok(["PACKAGE_REVISION_CONFLICT", "PACKAGE_NOT_FOUND"].includes(
      results.filter((entry) => entry.status === "rejected")[0].reason.code,
    ));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed registry fails closed instead of becoming an empty catalog", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-package-malformed-"));
  const filename = path.join(directory, "packages.json");
  await writeFile(filename, "{not-json", "utf8");
  try {
    const store = createFeishuPackageStore({ filename });
    await assert.rejects(() => store.list(), (error) => error.code === "PACKAGE_REGISTRY_INVALID");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("store saveDraft rejects server-managed fields", async () => {
  const store = createFeishuPackageStore({ packages: {} });
  await assert.rejects(
    () => store.saveDraft({ alias: "Auto-cut-managed", name: "Managed", projectId: "managed", state: "enabled" }),
    (error) => error instanceof PackageConfigError && error.code === "PACKAGE_INVALID",
  );
  await assert.rejects(
    () => store.saveDraft({ alias: "Auto-cut-managed", name: "Managed", projectId: "managed", updatedAt: "2099-01-01T00:00:00.000Z" }),
    (error) => error instanceof PackageConfigError && error.code === "PACKAGE_INVALID",
  );
});
