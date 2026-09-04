# Trusted Auto-Cut Non-Git Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a trusted, enabled Auto-Cut package to start Codex when its registered workspace is not a Git repository, without weakening ordinary task execution checks.

**Architecture:** `resolveAiChatContext` already distinguishes a server-registered Feishu task and its trusted package snapshot from ordinary tasks. It will return a server-owned `skipGitRepoCheck` capability only for that trusted package path; `AiChatService` will pass the capability to `buildCodexArgs`, which conditionally adds Codex's `--skip-git-repo-check` option. No browser request, task description, Feishu cell, or package prompt can set the capability.

**Tech Stack:** Node.js ESM, Taskboard local server, Codex CLI, Node test runner.

## Global Constraints

- Taskboard and Bridge remain bound to `127.0.0.1`.
- Bridge never starts Codex.
- Only the dedicated Bridge registration route can create an execution-eligible Feishu task.
- Ordinary tasks and copied markers must never receive the non-Git workspace capability.
- Workspace paths and Codex arguments remain server-owned and cannot come from Feishu cells or browser input.
- Existing unrelated worktree changes must be preserved.

---

### Task 1: Gate the Codex Non-Git Flag by Trusted Package Resolution

**Files:**
- Modify: `server/app.mjs`
- Modify: `server/ai-chat.mjs`
- Modify: `server/ai-chat-process.mjs`
- Modify: `test/task-start-flow.test.mjs`
- Verify: `test/ai-chat-runner.test.mjs`

**Interfaces:**
- `resolveAiChatContext(projectId, issueId)` produces `skipGitRepoCheck: boolean` from server-owned trusted origin and package resolution.
- `buildCodexArgs(thread, addDirectories, imagePaths, options)` consumes `{ skipGitRepoCheck?: boolean }`.

- [ ] **Step 1: Write the failing trusted-package test**

  Extend the fake Codex runner so a focused fixture exits when
  `--skip-git-repo-check` is absent. Start a server-registered Feishu task
  backed by a normal non-Git temporary directory and assert the run completes.

- [ ] **Step 2: Run the focused test and verify RED**

  Run:

  ```powershell
  node --test --test-name-pattern "trusted Auto-Cut packages can run from non-Git workspaces" test/task-start-flow.test.mjs
  ```

  Expected: FAIL because the fake Codex runner exits before emitting a thread.

- [ ] **Step 3: Implement the minimal trusted capability**

  Return `skipGitRepoCheck: Boolean(trustedOrigin && packageConfig)` from the
  local context resolver. Pass it through `AiChatService.startTurn` to
  `buildCodexArgs`, and conditionally insert `--skip-git-repo-check` after the
  fixed `exec --json --color never` prefix.

- [ ] **Step 4: Verify GREEN and the ordinary-task guard**

  Run:

  ```powershell
  node --test test/task-start-flow.test.mjs test/ai-chat-runner.test.mjs test/ai-chat-server.test.mjs
  ```

  Expected: PASS. Existing exact argument assertions for ordinary project
  threads remain unchanged and contain no `--skip-git-repo-check`.

- [ ] **Step 5: Run the full Taskboard suite and build**

  Run:

  ```powershell
  npm test
  npm run build --if-present
  ```

  Expected: PASS with no loopback, origin-trust, or execution-policy regression.

## Self-Review Checklist

- Spec coverage: the plan covers trusted non-Git package execution and the ordinary-task negative guard.
- Placeholder scan: every code path, test, and command is identified; no deferred behavior remains.
- Type consistency: `skipGitRepoCheck` has one server-derived boolean meaning from context resolution through argument construction.
