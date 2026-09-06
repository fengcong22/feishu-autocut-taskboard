import assert from "node:assert/strict";
import { test } from "node:test";

import { readCurrentControlledContext } from "../server/feishu-controlled-context-client.mjs";

test("controlled-context refresh sends only immutable record identity", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return new Response(JSON.stringify({
      controlledContext: {
        documentLinks: ["https://guanghe.feishu.cn/docx/fixed"],
        namingDisplayValue: "课程001",
        namingValueUnique: true,
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const context = await readCurrentControlledContext({
      bridgeUrl: "http://127.0.0.1:47824",
      bridgeSecret: "bridge-secret",
      origin: {
        subjectKey: "bas_demo:tbl_math",
        configVersion: 7,
        baseToken: "bas_demo",
        tableId: "tbl_math",
        recordId: "rec_1",
      },
    });
    assert.deepEqual(context, {
      documentLinks: ["https://guanghe.feishu.cn/docx/fixed"],
      namingDisplayValue: "课程001",
      namingValueUnique: true,
    });
    assert.equal(request.url, "http://127.0.0.1:47824/api/feishu/workflow/controlled-context");
    assert.equal(request.init.headers["x-feishu-bridge-client"], "taskboard");
    assert.equal(request.init.headers["x-feishu-bridge-secret"], "bridge-secret");
    assert.deepEqual(JSON.parse(request.init.body), {
      subjectKey: "bas_demo:tbl_math",
      configVersion: 7,
      baseToken: "bas_demo",
      tableId: "tbl_math",
      recordId: "rec_1",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

