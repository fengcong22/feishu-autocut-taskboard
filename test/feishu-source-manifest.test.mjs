import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  canonicalSha256,
  createSourceManifest,
  readSourceManifest,
  writeSourceManifest,
} from "../server/feishu-source-manifest.mjs";

function input(overrides = {}) {
  return {
    binding: {
      task_id: "task-1",
      run_id: "run-1",
      subject_key: "bas_demo:tbl_subject",
      config_version: 7,
      stage_id: "initial",
      event_id: "event-1",
    },
    document: {
      field_id: "fld_document",
      url: "https://example.feishu.cn/docx/AbCdEf",
    },
    sources: {
      video: { kind: "docx_section", anchor_text: "录屏" },
      review: { kind: "docx_section", anchor_text: "修改意见" },
      audio: { mode: "video_original" },
    },
    ...overrides,
  };
}

test("creates a stable manifest and digest independent of object insertion order", () => {
  const first = createSourceManifest(input());
  const second = createSourceManifest({
    sources: input().sources,
    document: input().document,
    binding: input().binding,
  });
  assert.equal(first.schema_version, 1);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.sha256, canonicalSha256(first.manifest));
  assert.equal(first.manifest.binding.stage_id, "initial");
});

test("base attachment sources inherit the canonical record identity used by Auto-Cut", () => {
  const created = createSourceManifest(input({
    binding: {
      task_id: "task-1",
      run_id: "run-1",
      subject_key: "bas_demo:tbl_math",
      config_version: 7,
      stage_id: "initial",
      event_id: "evt-1",
    },
    record: {
      base_token: "bas_demo",
      table_id: "tbl_math",
      record_id: "rec_1",
    },
    document: {
      field_id: "fld_document",
      url: "https://guanghe.feishu.cn/docx/opaque-token",
    },
    sources: {
      video: { kind: "base_attachment", field_id: "fld_video" },
      review: { kind: "docx_section", anchor_text: "review" },
      audio: {
        mode: "replace_original",
        duration_tolerance_seconds: 3,
        source: { kind: "base_attachment", field_id: "fld_audio" },
      },
    },
  }));
  const recordIdentity = {
    base_token: "bas_demo",
    table_id: "tbl_math",
    record_id: "rec_1",
  };
  assert.deepEqual(created.manifest.sources.video, {
    kind: "base_attachment",
    ...recordIdentity,
    field_id: "fld_video",
  });
  assert.deepEqual(created.manifest.sources.audio.source, {
    kind: "base_attachment",
    ...recordIdentity,
    field_id: "fld_audio",
  });
  assert.equal(created.sha256, "f77a0143746714042bfd0373710ce9141131f483d9672f7f35b923b7b1350b5d");
});

test("rejects a manifest that promotes a local path or command", () => {
  assert.throws(
    () => createSourceManifest({ ...input(), command: "powershell" }),
    /unsupported|command/i,
  );
  assert.throws(
    () => createSourceManifest({ ...input(), sources: { ...input().sources, video: { kind: "docx_section", anchor_text: "录屏", path: "C:\\video.mp4" } } }),
    /unsupported|path/i,
  );
});

test("writes and reads the exact canonical manifest", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-source-manifest-"));
  try {
    const target = path.join(directory, "source-manifest.json");
    const created = await writeSourceManifest(target, input());
    const loaded = await readSourceManifest(target);
    assert.equal(loaded.sha256, created.sha256);
    assert.deepEqual(loaded.manifest, created.manifest);
    assert.match(await readFile(target, "utf8"), /"schema_version"\s*:\s*1/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
