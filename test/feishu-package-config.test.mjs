import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createFeishuPackageStore,
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
      ...draft,
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
      () => store.saveDraft({ ...enabled, name: "stale" }, edited.revision),
      (error) => error instanceof PackageConfigError && error.code === "PACKAGE_REVISION_CONFLICT",
    );

    const persisted = JSON.parse(await readFile(registryPath, "utf8"));
    assert.equal(persisted.version, 1);
    assert.equal(persisted.packages[enabled.alias].state, "enabled");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
    () => store.remove("Auto-cut-a"),
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
