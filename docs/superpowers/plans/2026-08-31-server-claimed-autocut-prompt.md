# Server-Claimed Auto-Cut Prompt Implementation Plan

> **For agentic workers:** Implement this plan inline and preserve all unrelated working-tree changes. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a trusted Auto-Cut run that Taskboard has already claimed from being rejected by the ordinary `manage-taskboard` conversation-claim check.

**Architecture:** Keep Taskboard's local AI thread ID and Codex's native thread ID separate. Add an internal-only turn option that suppresses the ordinary task-management Skill only when `startClaimedTaskWithAi()` launches the already-claimed trusted Auto-Cut turn. Replace the Taskboard issue locator in that private Prompt with the server-owned Feishu Base/table/record locator so Auto-Cut can read its source record without triggering another Taskboard claim; keep every ordinary AI turn unchanged.

**Tech Stack:** Node.js ESM, Node test runner, Taskboard local server

## Global Constraints

- Only the server-owned trusted Auto-Cut start path may suppress the ordinary claim Skill.
- Browser input, task descriptions, labels, and Feishu cells cannot request this behavior.
- Ordinary AI conversations must continue to inject `$manage-taskboard` and `e-taskboard`.
- Preserve loopback-only binding and existing Bridge/Taskboard trust checks.
- Do not restart the existing real task automatically after deployment.

---

### Task 1: Distinguish an Already-Claimed Auto-Cut Turn

**Files:**
- Modify: `test/task-start-flow.test.mjs`
- Modify: `server/ai-chat-process.mjs`
- Modify: `server/ai-chat.mjs`
- Modify: `server/app.mjs`

**Interfaces:**
- Consumes: `AiChatService.startTurn(threadId, input, options)` and `buildCodexPrompt(thread, input, skillPath, options)`.
- Produces: internal `taskClaimedByServer: true` option used only by `startClaimedTaskWithAi()`, plus a trusted Feishu source locator derived by `resolveAiChatContext()`.

- [ ] **Step 1: Write the failing operation-path test**

  Capture the fake Codex stdin Prompt in `test/task-start-flow.test.mjs`. Start a server-registered Feishu task through `/api/tasks/:id/start-ai` and assert that its Prompt does not contain `$manage-taskboard`, `e-taskboard`, or a Taskboard issue identifier, while it still contains `<taskboard_context>`, the trusted Base/table/record locator, and the package Prompt.

- [ ] **Step 2: Run the focused test to verify it fails**

  Run:

  ```powershell
  node --test --test-name-pattern "server-claimed Auto-Cut" test/task-start-flow.test.mjs
  ```

  Expected: FAIL because the current Prompt always contains `[$manage-taskboard](...) e-taskboard`.

- [ ] **Step 3: Implement the minimal internal distinction**

  Extend `buildCodexPrompt()` with an `includeManageTaskboardSkill` option that defaults to `true` and an optional trusted Auto-Cut source locator. Extend `AiChatService.startTurn()` with a `taskClaimedByServer` option that defaults to `false`, require trusted source context when it is enabled, and map it only to the Prompt builder. Pass `taskClaimedByServer: true` only from `startClaimedTaskWithAi()` after Taskboard has bound the claim.

- [ ] **Step 4: Verify focused behavior and ordinary-turn protection**

  Run:

  ```powershell
  node --test test/task-start-flow.test.mjs test/ai-chat-runner.test.mjs test/ai-chat-server.test.mjs
  ```

  Expected: all tests pass. The existing runner assertion continues to prove ordinary turns include `$manage-taskboard`.

- [ ] **Step 5: Build and inspect the exact diff**

  Run:

  ```powershell
  npm run build --if-present
  git diff --check
  git diff -- server/ai-chat-process.mjs server/ai-chat.mjs server/app.mjs test/task-start-flow.test.mjs
  ```

  Expected: build exits 0, `git diff --check` reports no whitespace errors, and the diff contains no unrelated behavior changes.

- [ ] **Step 6: Restart and verify local services**

  From `D:\codex\codex-feishu`, restart with the real local environment and run:

  ```powershell
  .\scripts\stop-local.ps1
  .\scripts\start-local.ps1 -EnableFeishu
  .\scripts\check-local.ps1 -RequireFeishu
  ```

  Expected: Taskboard and Bridge are healthy on loopback, and the Feishu listener reports `sdk_managed`. Do not restart the existing Auto-Cut task automatically.
