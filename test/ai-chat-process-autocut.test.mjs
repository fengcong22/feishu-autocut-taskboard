import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCodexPrompt } from "../server/ai-chat-process.mjs";

function thread() {
  return {
    origin: {
      projectId: "feishu-project",
      projectName: "数学",
      workspacePath: "C:\\autocut\\workspace",
      issueIdentifier: "FEI-1",
    },
  };
}

test("trusted Auto-Cut prompt gives the exact run-input and report protocol without private values", () => {
  const prompt = buildCodexPrompt(
    thread(),
    { message: "run package", skills: [], attachmentPaths: [] },
    "C:\\taskboard\\skills\\manage-taskboard\\SKILL.md",
    {
      artifactReportEnabled: true,
      autoCutInputsEnabled: true,
      includeManageTaskboardSkill: false,
      trustedAutoCutSource: {
        source: "feishu-base",
        baseToken: "bas_demo",
        tableId: "tbl_math",
        recordId: "rec_1",
      },
    },
  );

  assert.match(prompt, /review-document-run/);
  assert.match(prompt, /CODEX_AUTOCUT_SOURCE_MANIFEST_PATH/);
  assert.match(prompt, /CODEX_AUTOCUT_EXECUTION_INPUT_PATH/);
  assert.match(prompt, /CODEX_AUTOCUT_PACKAGE_ZIP_PATH/);
  assert.match(prompt, /CODEX_AUTOCUT_RESULT_PATH/);
  assert.match(prompt, /--result-path "\$env:CODEX_AUTOCUT_RESULT_PATH"/);
  assert.match(prompt, /taskctl artifact report --file/);
  assert.doesNotMatch(prompt, /guanghe\.feishu\.cn|课程001|录屏|claim-token|C:\\nas/iu);
  assert.doesNotMatch(prompt, /manage-taskboard|issue_identifier/iu);
});
