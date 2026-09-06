import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { prepareFeishuRunInputs } from "../server/feishu-run-inputs.mjs";
import { sourceManifestSha256 } from "../server/feishu-source-manifest.mjs";

async function fixture() {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "taskboard-run-inputs-"));
  const packageRoot = await mkdtemp(path.join(os.tmpdir(), "taskboard-package-"));
  return { dataDirectory, packageRoot };
}

function input({ dataDirectory, packageRoot }, overrides = {}) {
  return {
    dataDirectory,
    task: { id: "task-1" },
    run: { runId: "run-1", attempt: 1 },
    origin: {
      subjectKey: "bas_demo:tbl_math",
      configVersion: 7,
      stageId: "initial",
      eventId: "evt-1",
      baseToken: "bas_demo",
      tableId: "tbl_math",
      recordId: "rec-1",
    },
    subjectVersion: {
      documentField: { fieldId: "fld_document" },
      stages: {
        initial: {
          nameSuffix: "_初稿",
          videoSource: { kind: "docx_section", anchorText: "录屏" },
          reviewSource: { kind: "docx_section", anchorText: "修改意见" },
          audio: { mode: "video_original" },
          artifactTargetPath: null,
        },
      },
    },
    packageSnapshot: { zipSourceDirectory: packageRoot },
    controlledContext: {
      documentLinks: ["https://guanghe.feishu.cn/docx/opaque"],
      namingDisplayValue: "课程001",
      namingValueUnique: true,
    },
    ...overrides,
  };
}

test("writes one immutable manifest and naming input under the run root", async () => {
  const fixtureData = await fixture();
  try {
    const result = await prepareFeishuRunInputs(input(fixtureData));
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.binding.run_id, "run-1");
    assert.equal(manifest.record.record_id, "rec-1");
    assert.deepEqual(
      JSON.parse(await readFile(result.executionInputPath, "utf8")),
      { schema_version: 1, artifact_name: "课程001_初稿" },
    );
    assert.equal(result.manifestSha256, sourceManifestSha256(manifest));
    assert.equal(path.dirname(result.resultPath), path.dirname(result.manifestPath));
    assert.equal(path.extname(result.packageZipPath), ".zip");
    assert.match(result.packageZipPath, /\.taskboard-autocut[\\/]task-1[\\/]run-1[\\/]课程001_初稿\.zip$/u);
    assert.match(result.draftsRoot, /autocut-runs[\\/]task-1[\\/]run-1[\\/]drafts$/u);
  } finally {
    await rm(fixtureData.dataDirectory, { recursive: true, force: true });
    await rm(fixtureData.packageRoot, { recursive: true, force: true });
  }
});

test("blocks missing or ambiguous controlled values before writing inputs", async () => {
  const fixtureData = await fixture();
  try {
    await assert.rejects(
      prepareFeishuRunInputs(input(fixtureData, { controlledContext: { documentLinks: [], namingDisplayValue: "课程001", namingValueUnique: true } })),
      (error) => (
        error.code === "document_link_missing"
        && error.message === "Exactly one Feishu Docx or Wiki document link is required"
      ),
    );
    await assert.rejects(
      prepareFeishuRunInputs(input(fixtureData, {
        controlledContext: {
          documentLinks: [
            "https://guanghe.feishu.cn/docx/opaque",
            "https://guanghe.feishu.cn/wiki/opaque",
          ],
          namingDisplayValue: "课程001",
          namingValueUnique: true,
        },
      })),
      (error) => (
        error.code === "document_link_ambiguous"
        && error.message === "Exactly one Feishu Docx or Wiki document link is required"
      ),
    );
    await assert.rejects(
      prepareFeishuRunInputs(input(fixtureData, { controlledContext: { documentLinks: ["https://guanghe.feishu.cn/docx/opaque"], namingDisplayValue: "", namingValueUnique: true } })),
      (error) => error.code === "naming_value_missing",
    );
  } finally {
    await rm(fixtureData.dataDirectory, { recursive: true, force: true });
    await rm(fixtureData.packageRoot, { recursive: true, force: true });
  }
});

test("uses the Auto-Cut filename sanitizer for the frozen artifact name", async () => {
  const cases = [
    {
      namingDisplayValue: "课程:003",
      nameSuffix: "_初稿",
      expected: "课程_003_初稿",
    },
    {
      namingDisplayValue: "  课程   004  ",
      nameSuffix: "_初稿",
      expected: "课程 004_初稿",
    },
    {
      namingDisplayValue: "CON",
      nameSuffix: ".zip",
      expected: "_CON",
    },
    {
      namingDisplayValue: "课程".repeat(100),
      nameSuffix: "_初稿",
      expected: "课程".repeat(90),
    },
  ];

  for (const [index, item] of cases.entries()) {
    const fixtureData = await fixture();
    try {
      const request = input(fixtureData, {
        task: { id: `task-${index + 1}` },
        run: { runId: `run-${index + 1}`, attempt: 1 },
        controlledContext: {
          documentLinks: ["https://guanghe.feishu.cn/docx/opaque"],
          namingDisplayValue: item.namingDisplayValue,
          namingValueUnique: true,
        },
      });
      request.subjectVersion.stages.initial.nameSuffix = item.nameSuffix;
      const result = await prepareFeishuRunInputs(request);
      assert.equal(result.artifactName, item.expected);
      assert.deepEqual(
        JSON.parse(await readFile(result.executionInputPath, "utf8")),
        { schema_version: 1, artifact_name: item.expected },
      );
      assert.equal(path.basename(result.packageZipPath), `${item.expected}.zip`);
    } finally {
      await rm(fixtureData.dataDirectory, { recursive: true, force: true });
      await rm(fixtureData.packageRoot, { recursive: true, force: true });
    }
  }
});
