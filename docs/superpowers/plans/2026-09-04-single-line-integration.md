# Single-Line Auto-Cut Integration Plan

> **For agentic workers:** Execute this plan task-by-task and keep each logical change independently reviewable. Do not reset, clean, or overwrite the existing working trees.

**Goal:** Consolidate the Feishu Bridge and Taskboard Auto-Cut work onto the existing `codex/feishu-autocut-workflow` integration lines, while preserving all user changes and leaving `main` untouched until verification and code review are complete.

**Architecture:** `codex/feishu-autocut-workflow` is the canonical integration branch in both repositories. The Bridge `-impl` branch remains an evidence/source worktree only; its five committed changes are not merged wholesale because the canonical Bridge branch already contains their intended behavior. Taskboard changes are grouped into sequential commits for trusted Auto-Cut execution, durable recovery, and unified workflow UI, with runtime files excluded.

**Tech Stack:** Git worktrees, Node.js 22 ESM, SQLite-backed Taskboard server, React/TypeScript/Vite, PowerShell local Bridge scripts, Node test runner.

## Global Constraints

- Preserve all existing uncommitted changes in `D:\codex\worktrees\codex-feishu-autocut-workflow` and `D:\codex\worktrees\dashi-taskboard-autocut-workflow`.
- Do not cherry-pick or merge the Bridge `-impl` branch as a whole.
- Keep Bridge and Taskboard bound to `127.0.0.1`; Bridge never starts Codex; automatic execution remains opt-in.
- Keep credentials, local package registries, state files, SQLite files, logs, and `.runtime\` out of commits.
- Any Bridge routing, credential, port, or startup change must include tests and README updates, then a test/example-flow verification and code review.
- Do not delete the old branches or worktrees during this integration.

## Repository Map

- Bridge canonical worktree: `D:\codex\codex-feishu`, branch `codex/feishu-autocut-workflow`, base `c578e8a`.
- Bridge source/evidence worktree: `D:\codex\worktrees\codex-feishu-autocut-workflow`, branch `codex/feishu-autocut-workflow-impl`, base `e0d6f4a`, with nine uncommitted files.
- Taskboard canonical integration worktree: `D:\codex\worktrees\dashi-taskboard-autocut-workflow`, branch `codex/feishu-autocut-workflow`, base `e09dfe4`, with uncommitted Auto-Cut and unified-workflow work.
- Taskboard candidate snapshot: `D:\codex\worktrees\task5-staging-candidate`, detached commit `296c92d`; inspect and port only the desired content, then leave it unchanged.
- Taskboard `main`: `D:\codex\dashi-taskboard`, currently not a safe editing baseline; do not use it for assembly.

---

### Task 1: Freeze and classify the two source worktrees

**Files:**
- Read: `D:\codex\worktrees\codex-feishu-autocut-workflow\src\decide-event.mjs`
- Read: `D:\codex\worktrees\codex-feishu-autocut-workflow\src\workflow-config-store.mjs`
- Read: `D:\codex\worktrees\dashi-taskboard-autocut-workflow\server\*.mjs`
- Read: `D:\codex\worktrees\dashi-taskboard-autocut-workflow\web\src\*.tsx`
- Create or update: this plan file only during the classification phase

**Interfaces:**
- Produce a file-level classification of Bridge `-impl` changes as either already represented by `c578e8a`, semantically missing and eligible for a focused port, or intentionally rejected.
- Produce a Taskboard staging list with three groups: trusted Auto-Cut runtime, unified workflow UI, and excluded runtime artifacts.

- [ ] **Step 1: Record immutable source snapshots**

Run in each source worktree:

```powershell
git status --short --branch
git diff --name-status
git diff --check
git rev-parse HEAD
```

Expected: the Bridge `-impl` worktree still reports the same nine modified files; the Taskboard worktree still reports the known modified and untracked files; no command changes either worktree.

- [ ] **Step 2: Compare Bridge semantics, not commit ancestry**

Compare the `-impl` working-tree hunks against the canonical files. Keep only changes whose behavior is absent from `c578e8a`, especially the shared subject project-id length contract, workflow sync endpoint wiring, synchronization error codes, and concurrency snapshot fields. Do not copy code merely because it exists in one of the five `-impl` commits.

- [ ] **Step 3: Classify Taskboard files explicitly**

Use `git diff --stat`, `git status --short --untracked-files=all`, and the existing implementation plans to classify each file. `.runtime\**`, `*.sqlite`, `*.sqlite-shm`, `*.sqlite-wal`, logs, patches, and generated diffs are excluded. `shared\codex-invocation.mjs` remains included because it is already staged and is a production source file.

- [ ] **Step 4: Commit the classification plan only if it is useful to the final branch**

If the team wants the plan retained in history, stage only this file and commit it from the Taskboard integration worktree:

```powershell
git add docs/superpowers/plans/2026-09-04-single-line-integration.md
git commit -m "docs: define single-line integration plan"
```

Do not use `git add .`.

---

### Task 2: Port only missing Bridge behavior onto the canonical Bridge branch

**Files:**
- Modify only after a missing behavior is confirmed: `D:\codex\codex-feishu\src\decide-event.mjs`, `src\index.mjs`, `src\retry-policy.mjs`, `src\server.mjs`, `src\task-payload.mjs`, `src\workflow-config-store.mjs`
- Test alongside behavior: `D:\codex\codex-feishu\test\server.test.mjs`, `test\task-payload.test.mjs`, `test\workflow-config.test.mjs`, plus the narrowest affected tests
- Update when the behavior changes routing/startup/security: `D:\codex\codex-feishu\README.md`, `AGENTS.md`

**Interfaces:**
- Preserve the canonical Bridge workflow-config schema and public error sanitization.
- Keep `projectIdForSubject()` identical to Taskboard's `subjectProjectId()` contract.
- Keep workflow synchronization loopback-only and validate subject identity, lifecycle, package alias, and safe error codes at the boundary.

- [ ] **Step 1: Write or retain focused tests for each missing behavior**

Tests must fail for the missing behavior before its production hunk is ported. The minimum assertions are:

```js
assert.match(payload.projectId, /^feishu-[a-f0-9]{16}$/);
assert.equal((await store.syncSubject(subject, { lifecycle: "enabled" })).lifecycle, "enabled");
assert.equal((await store.syncSubject(subject, { lifecycle: "disabled" })).lifecycle, "disabled");
```

- [ ] **Step 2: Port the smallest production hunks**

Apply only the missing hunks from the Bridge source worktree with `apply_patch`. Do not replace canonical files wholesale. Retain the canonical branch's stricter routing, lifecycle, registry, retry, and metadata behavior when the two versions overlap.

- [ ] **Step 3: Run Bridge verification**

Run from `D:\codex\codex-feishu`:

```powershell
npm test
git diff --check
```

Expected: Node tests report zero failures, and the diff check reports no whitespace errors. Then run the required local checks after configuration is confirmed:

```powershell
.\scripts\check-local.ps1
.\scripts\simulate-ready.ps1
.\scripts\check-local.ps1
```

Use `-RequireFeishu` only when real SDK long-connection verification is intended.

- [ ] **Step 4: Commit only the Bridge port**

Stage exact files or hunks and commit with a behavior-specific message, for example:

```powershell
git add src/decide-event.mjs src/index.mjs src/retry-policy.mjs src/server.mjs src/task-payload.mjs src/workflow-config-store.mjs test/server.test.mjs test/task-payload.test.mjs test/workflow-config.test.mjs
git commit -m "fix: align Bridge workflow synchronization contract"
```

Do not stage unrelated files from the `-impl` worktree.

---

### Task 3: Assemble Taskboard trusted Auto-Cut execution as sequential commits

**Files:**
- Source: `D:\codex\worktrees\dashi-taskboard-autocut-workflow\server\`, `shared\`, `test\`
- Documentation: `README.md`, `README.zh-CN.md`, and the relevant existing plans
- Exclude: `.runtime\**`, SQLite files, logs, generated patches, and any unrelated local artifacts

**Interfaces:**
- Bridge-created tasks use the dedicated local provenance route and shared secret.
- Taskboard validates the package registry, snapshots package settings per task, schedules delayed/queued execution durably, and keeps ordinary tasks ineligible.
- Existing task execution and artifact-upload contracts remain compatible with the current tests.

- [ ] **Step 1: Stage the already implemented registry/provenance boundary**

Stage only the package store/API, trusted Feishu-origin registration, shared invocation helper, executable validation, and their focused tests. Include the corresponding README/security documentation. Run:

```powershell
npm run typecheck
node --test test/automatic-policy.test.mjs test/codex-executable.test.mjs test/feishu-share-config.test.mjs test/feishu-task-origin-api.test.mjs test/loopback-binding.test.mjs test/project-selection.test.mjs
```

Commit:

```powershell
git commit -m "feat: enforce trusted Auto-Cut task provenance"
```

- [ ] **Step 2: Stage package snapshots and execution recovery**

Stage the database, coordinator, server integration, queue-state UI/domain changes, and focused tests that implement package snapshot immutability, five-second delay, per-package scheduling, restart recovery, and automatic/manual completion rules. Run:

```powershell
node --test test/feishu-execution-coordinator.test.mjs test/feishu-task-package-snapshot.test.mjs test/task-start-flow.test.mjs test/feishu-project-lifecycle.test.mjs
npm run typecheck
```

Commit:

```powershell
git commit -m "feat: add durable Auto-Cut execution recovery"
```

- [ ] **Step 3: Stage artifact summaries and task progress visibility**

Stage the artifact-summary server/API/UI changes and their focused tests only after the execution contract is green. Run:

```powershell
node --test test/task-artifact-summaries.test.mjs test/artifact-upload-views.test.mjs test/task-progress-visibility.test.mjs
npm run typecheck
```

Commit:

```powershell
git commit -m "feat: expose Auto-Cut task progress and artifacts"
```

---

### Task 4: Assemble the unified workflow UI on the same Taskboard branch

**Files:**
- Modify: `web/src/App.tsx`, `web/src/api.ts`, `web/src/components/BoardColumn.tsx`, `web/src/components/FeishuWorkflowPanel.tsx`, `web/src/components/OtherTasksPanel.tsx`, `web/src/components/TaskCard.tsx`, `web/src/feishuWorkflow.ts`, `web/src/issueBoardStatuses.ts`, `web/src/styles.css`, `web/src/types.ts`, `web/src/unifiedWorkflow.mjs`
- Create: `web/src/components/UnifiedWorkflowBoard.tsx`, `web/src/components/UnifiedWorkflowViewControls.tsx`, `web/src/projectSelection.mjs`, `web/src/unifiedWorkflowDropGuard.mjs`, `web/src/unifiedWorkflowLayout.mjs`
- Test: `test/unified-workflow*.test.mjs`, `test/project-selection.test.mjs`, `test/task-move-ui.test.mjs`, `test/task-start-ui.test.mjs`, `test/task-progress-visibility.test.mjs`

**Interfaces:**
- The board projects only registered unified stages and does not allow unknown or duplicate stage IDs to create columns.
- Verified artifacts and upload rows are deduplicated by stable identity and remain visible with their current state.
- View selection and stage display settings are subject-scoped and preserve server conflict handling.

- [ ] **Step 1: Compare candidate `296c92d` with the current untracked UI files**

Use `git show 296c92d:<path>` and direct file inspection. Keep the current worktree version when it contains later fixes; port missing candidate content with `apply_patch` or a reviewed patch. Leave `task5-staging-candidate` detached and unchanged.

- [ ] **Step 2: Verify the real operation path before adding unrelated hardening**

Trace and record: App navigation action -> unified workflow component -> API request -> database mutation -> refreshed board state. The relevant implementation files are `web/src/App.tsx`, `web/src/components/UnifiedWorkflowBoard.tsx`, `web/src/api.ts`, and the matching route in `server/app.mjs`/`server/database.mjs`.

- [ ] **Step 3: Run focused UI contracts and build**

Run:

```powershell
node --test test/unified-workflow-browser-contract.test.mjs test/unified-workflow-projection.test.mjs test/unified-workflow-view-controls.test.mjs test/unified-workflow-drop-guard.test.mjs test/unified-workflow-layout.test.mjs test/unified-workflow-css-regressions.test.mjs test/unified-workflow-board-ui.test.mjs
npm run typecheck
npm run build:web
```

Commit the unified workflow feature as one or two logically coherent commits, using exact paths in `git add`. Do not include `.runtime`.

---

### Task 5: Review the complete integration and prepare for main

**Files:**
- Read-only review of both canonical branches and their tests/docs
- No `main` mutation in this task

- [ ] **Step 1: Run repository-level checks**

Bridge:

```powershell
Set-Location D:\codex\codex-feishu
npm test
git diff --check
```

Taskboard:

```powershell
Set-Location D:\codex\worktrees\dashi-taskboard-autocut-workflow
npm run typecheck
npm run build:web
npm test
```

If the full Taskboard suite reaches Wrangler/cloud migration infrastructure, record the exact failure and separately run the affected test files; do not claim the full suite passed.

- [ ] **Step 2: Request code review before merging**

Review the final commit range against each repository's `origin/main`, with special attention to provenance, loopback binding, package snapshot immutability, retry/recovery, event routing, and ordinary-task isolation. Fix Critical and Important findings before proceeding.

- [ ] **Step 3: Refresh remote refs and compare ancestry**

Only after tests and review:

```powershell
git fetch origin --prune
git log --oneline --decorate origin/main..codex/feishu-autocut-workflow
git diff --check origin/main...codex/feishu-autocut-workflow
```

Do this independently in Bridge and Taskboard. Do not merge `main` into the feature branch merely to make the graph look linear; resolve actual remote drift explicitly if it exists.

- [ ] **Step 4: Stop at the PR boundary**

Create or update a PR only after the above evidence is available. Leave `main`, the `-impl` branch, and the detached candidate worktree intact until the PR has been accepted.

## Self-Review

- The plan covers the canonical branch decision, the nine uncommitted Bridge files, the Taskboard trusted Auto-Cut changes, the unified UI candidate, runtime-artifact exclusion, tests, README/AGENTS requirements, code review, and remote refresh.
- Every mutation uses exact paths; no step uses `git add .`, reset, checkout, or worktree cleanup.
- The plan does not promise that the two repositories share one Git branch; it keeps one integration branch per repository because they are separate repositories.
