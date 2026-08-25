# Auto-Cut Codex Package Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Build a machine-local Auto-Cut Codex package manager and connect it to trusted Feishu task creation, five-second automatic starts, visible per-package queueing, manual/automatic completion branches, and global board-stage labels.

**Architecture:** Taskboard owns and atomically writes a Git-ignored package registry shared by Taskboard and Bridge. Feishu subject configuration stores only a package alias; Taskboard captures a server-owned package snapshot when a controlled task is registered, while current package state and concurrency remain live controls. A durable Taskboard execution coordinator keeps todo/待处理, queued/排队中, and in_progress/处理中 distinct and recovers delayed or queued work after restart.

**Tech Stack:** Node.js 22 ESM server, SQLite through node:sqlite/TaskboardDatabase, React + TypeScript + Vite web client, PowerShell local launcher, Feishu Bridge official SDK long connection, Node test runner.

## Global Constraints

- Bridge and Taskboard bind only to 127.0.0.1.
- Bridge-created tasks must use Taskboard's dedicated local Feishu source registration route; ordinary task markers and labels never grant Auto-Cut execution permission.
- Feishu cells may provide only controlled field values and package aliases; they may not provide paths, shell commands, Codex arguments, models, or prompts.
- Package paths, prompts, model settings, and execution snapshots remain machine-local and are excluded from shared Feishu workflow export.
- Registry writes are validated and atomic; malformed state fails closed and is never replaced with an empty file.
- New events use only enabled subject configurations; a known disabled package may leave an already-enabled subject's task in 待处理, but it cannot launch Codex until re-enabled.
- Existing tasks keep the package revision captured at registration; package edits never silently rewrite pending or running task snapshots.
- Per-package maxConcurrent is the sole live Auto-Cut concurrency limit; subject metadata cannot override it.
- Automatic tasks wait five seconds in 待处理; 立即开始 skips only the delay and never bypasses the scheduler.
- Manual tasks retain 待验收; automatic tasks with a verified ZIP move directly to 已完成剪辑.
- ZIP discovery is manual in the first implementation; no newest-file guessing is allowed in a shared directory.
- Do not write real credentials, local paths, runtime state, or local package registry files to Git.
- Worktrees already contain unrelated user changes; stage only the feature hunks for each commit, using git add -p when a listed file has unrelated modifications.
- Run the repository's direct operation path before adding speculative compatibility behavior; update tests and README whenever Bridge routing, credentials, ports, or startup behavior changes.

## File Map

### Taskboard files

- Modify server/feishu-package-config.mjs: package record normalization, revisions, atomic read/write, enable/disable/delete/reference operations, and trusted snapshot helpers.
- Create server/feishu-package-api.mjs: loopback HTTP API for package CRUD, enable/disable, references, and model catalog validation.
- Modify server/app.mjs: wire package API/store, register trusted package snapshots, resolve package-specific Codex settings, and start the execution coordinator.
- Modify server/database.mjs: migrate queued task status; add package snapshot and durable execution-queue records; add board-stage settings persistence.
- Create server/feishu-execution-coordinator.mjs: five-second deadlines, FIFO per-package scheduling, restart recovery, and lease/run transitions.
- Modify shared/domain.mjs: add the internal queued task status.
- Modify web/src/types.ts and web/src/api.ts: package, stage-label, queue, and API response contracts.
- Create web/src/components/FeishuPackageManager.tsx: global package table, right-side editor, reference list, enable/disable/delete actions, and global stage-label editor.
- Modify web/src/components/FeishuWorkflowPanel.tsx: replace free-text package alias with enabled-package dropdown and show package-local ZIP source behavior.
- Modify web/src/components/BoardColumn.tsx, web/src/components/IssueListView.tsx, web/src/components/TaskDetail.tsx, web/src/components/TaskEditor.tsx, web/src/components/TaskContextMenu.tsx, web/src/components/GanttView.tsx, and related UI call sites: render the new queued status and globally fetched labels.
- Modify web/src/issueBoardStatuses.ts, web/src/i18n.tsx, web/src/App.tsx, and web/src/styles.css: navigation entry, status ordering, label context, package manager view, and responsive right-side editor styling.
- Create or modify focused tests under test/: package store/API/UI, package snapshot, queue coordinator, queued board state, stage labels, and task-start flow.

### Bridge files

- Create D:\codex\codex-feishu\src\package-config.mjs: load/normalize the shared local Auto-Cut registry and expose enabled/known alias views without accepting Feishu-provided execution fields.
- Modify D:\codex\codex-feishu\src\config.mjs, src/index.mjs, src/decide-event.mjs, src/bridge.mjs, src/workflow-config-store.mjs, and src/server.mjs: inject the package catalog separately, route by alias, and retain decision fingerprints against the package snapshot.
- Modify D:\codex\codex-feishu\config\bridge.example.json, create D:\codex\codex-feishu\config\autocut-packages.example.json, .gitignore, scripts/start-local.ps1, README.md, and AGENTS.md: document and launch the dedicated registry without moving credentials.
- Modify Bridge tests test/config.test.mjs, test/decide-event.test.mjs, test/bridge.test.mjs, test/workflow-config.test.mjs, test/startup-scripts.test.mjs, and test/server.test.mjs.

---

### Task 1: Establish the Shared Package Registry Contract

**Files:**
- Modify: server/feishu-package-config.mjs
- Create: server/feishu-package-api.mjs
- Modify: server/app.mjs around server option resolution, local route dispatch, and package-store construction
- Create: test/feishu-package-config.test.mjs
- Create: test/feishu-package-api.test.mjs

**Interfaces:**
- AutoCutPackage: { alias, name, projectId, workspacePath, model, reasoningEffort, prompt, zipSourceDirectory, maxConcurrent, state, revision, updatedAt }.
- createFeishuPackageStore({ filename, packages, now, listReferences }) produces read, list, get, saveDraft, enable, disable, remove, references, and snapshot methods.
- createFeishuPackageApi({ store, getModelCatalog }) handles GET /api/local/autocut/packages, POST /api/local/autocut/packages, PATCH /api/local/autocut/packages/:alias, POST /api/local/autocut/packages/:alias/enable, POST /api/local/autocut/packages/:alias/disable, DELETE /api/local/autocut/packages/:alias, and POST /api/local/autocut/packages/catalog.

- [ ] Step 1: Write failing normalization and mutation tests.

  Cover the exact contract: a draft may omit workspace/model/prompt/ZIP directory; enable rejects a missing absolute workspace, unsupported model/reasoning effort, blank prompt, and non-positive concurrency; aliases are unique; revisions use compare-and-swap; writes return the normalized record; deletion returns PACKAGE_IN_USE with Base/table/task references.

- [ ] Step 2: Run the focused store tests and verify failure.

  Run:

    node --test test/feishu-package-config.test.mjs

  Expected: FAIL because the managed store methods and package record fields do not yet exist.

- [ ] Step 3: Implement normalized, atomic package persistence.

  Extend server/feishu-package-config.mjs with a versioned document:

    {
      "version": 1,
      "packages": {
        "Auto-cut-copyA": {
          "alias": "Auto-cut-copyA",
          "name": "Auto-cut-copyA",
          "projectId": "auto-cut-copy-a",
          "workspacePath": "D:\\Auto-Cut\\copyA",
          "model": "gpt-5.5",
          "reasoningEffort": "high",
          "prompt": "读取 AGENTS.md，执行完整 Auto-Cut 流程。",
          "zipSourceDirectory": null,
          "maxConcurrent": 1,
          "state": "draft",
          "revision": 1,
          "updatedAt": "2026-08-25T00:00:00.000Z"
        }
      }
    }

  Use the same single-link regular-file and atomic-replacement discipline as the existing workflow store. saveDraft increments only the package revision; enable performs full validation; disable preserves the record; remove calls listReferences(alias) before deleting. snapshot(alias) returns a deep copy suitable for server-owned task storage and never returns mutable internal state.

- [ ] Step 4: Add loopback package routes and model validation.

  Wire createFeishuPackageApi into server/app.mjs before the existing Feishu workflow routes. POST .../catalog accepts only { workspacePath } from the local UI, validates it as an absolute directory on the server, and invokes the existing Codex catalog discovery so the UI can choose a real model and supported reasoning effort. Never accept prompt, argv, or a package path from a Feishu bridge request.

- [ ] Step 5: Run store/API tests and commit.

  Run:

    node --test test/feishu-package-config.test.mjs test/feishu-package-api.test.mjs

  Expected: PASS. Commit:

    git add server/feishu-package-config.mjs server/feishu-package-api.mjs server/app.mjs test/feishu-package-config.test.mjs test/feishu-package-api.test.mjs
    git commit -m "feat: add local Auto-Cut package registry"

### Task 2: Build the Global Auto-Cut Package Manager UI

**Files:**
- Create: web/src/components/FeishuPackageManager.tsx
- Modify: web/src/api.ts, web/src/types.ts, web/src/App.tsx, web/src/styles.css
- Create: test/feishu-package-ui.test.mjs

**Interfaces:**
- listAutoCutPackages(): Promise<AutoCutPackageSummary[]>
- saveAutoCutPackage(alias: string | null, draft: AutoCutPackageDraft): Promise<AutoCutPackage>
- enableAutoCutPackage(alias, revision), disableAutoCutPackage(alias, revision), removeAutoCutPackage(alias, revision)
- FeishuPackageManagerProps: { packages, onRefresh, onError }.

- [ ] Step 1: Write the UI contract test.

  Assert source-level and rendered behavior for: a global navigation item independent of the selected Base, compact table columns, 新增 Auto-Cut 包, right-side editor, draft save, enable validation error display, disabled state, reference count, and delete action disabled/blocked when references are returned.

- [ ] Step 2: Add client types and API functions.

  Add AutoCutPackage, AutoCutPackageDraft, AutoCutPackageReference, and structured API error details to web/src/types.ts. Add the functions above to web/src/api.ts using /api/local/autocut/packages and preserve the existing loopback-only request wrapper.

- [ ] Step 3: Implement the manager surface.

  Create FeishuPackageManager.tsx with a table/list on the left and a right-side editor. Keep incomplete records as drafts. Use select for model and reasoning effort, numeric input for concurrency, text inputs for paths and prompt, and icon buttons with tooltips for edit/disable/delete. Show a reference drawer/list before deletion. Do not expose the raw local path in the table row or in shared configuration UI.

- [ ] Step 4: Add the navigation/view integration.

  Add autocut_packages to the local-only BoardView union in web/src/App.tsx. Add a global navigation item near the Feishu Base navigator. When selected, render FeishuPackageManager without requiring selectedProjectId; suppress issue-board create actions and project-specific tabs for this view. Refresh the package list on local realtime updates and after every mutation.

- [ ] Step 5: Add responsive styling and run focused UI checks.

  Add .autocut-package-manager styles in web/src/styles.css: a dense list, stable editor width, no nested cards, and a full-width mobile editor below the list. Run:

    node --test test/feishu-package-ui.test.mjs
    npm run build --if-present

  Expected: focused UI test PASS and the web build completes without TypeScript errors. Commit:

    git add web/src/components/FeishuPackageManager.tsx web/src/api.ts web/src/types.ts web/src/App.tsx web/src/styles.css test/feishu-package-ui.test.mjs
    git commit -m "feat: add Auto-Cut package manager UI"

### Task 3: Bind Subjects to Enabled Packages and Capture Task Snapshots

**Files:**
- Modify: web/src/components/FeishuWorkflowPanel.tsx
- Modify: server/feishu-workflow-store.mjs, server/feishu-workflow-api.mjs, server/app.mjs
- Modify: server/database.mjs
- Modify: web/src/types.ts, web/src/api.ts
- Modify: test/feishu-workflow-store.test.mjs, test/feishu-workflow-api.test.mjs, test/task-start-flow.test.mjs

**Interfaces:**
- feishuWorkflowStore.packageAliases() returns only aliases that are selectable for a new enabled subject.
- TaskboardDatabase.createFeishuTask(input, packageSnapshot) persists the trusted snapshot in feishu_task_package_snapshots and returns the ordinary task without local paths or prompts.
- TaskboardDatabase.getFeishuTaskPackageSnapshot(taskId) returns the server-only snapshot.
- TaskboardDatabase.listPackageReferences(alias) returns { subjects, unfinishedTasks } for deletion checks.

- [ ] Step 1: Add failing subject and snapshot tests.

  Test that the subject editor renders a dropdown instead of a free-text alias, a missing/disabled alias blocks enablement, a registered task stores the package revision/model/path/prompt/ZIP source outside the description, and changing the registry does not change getFeishuTaskPackageSnapshot(taskId).

- [ ] Step 2: Replace free-text package editing with enabled-alias selection.

  In FeishuWorkflowPanel.tsx, load package summaries once, set the draft packageAlias from the selected option, show a missing alias as unavailable, and retain the existing save-draft/enable CAS flow. Remove the default Auto-cut-A fallback; use the stored alias or an explicit 未选择包 state.

- [ ] Step 3: Persist trusted snapshots during the Bridge-only registration route.

  In POST /api/local/feishu/tasks, read the package record by the parsed alias after validating the controlled origin. Reject unknown aliases, but allow a known disabled package to create a visible held task. Pass the deep-copied package record to database.createFeishuTask; never accept snapshot fields from the request body. Add a feishu_task_package_snapshots table with task_id, package_alias, package_revision, snapshot_json, created_at and a unique task key.

- [ ] Step 4: Add explicit package-refresh behavior.

  Add POST /api/local/tasks/:id/package-refresh accepting only { version }. It succeeds only for a trusted Feishu task in todo or queued, reads the current package record, replaces the stored snapshot, increments task version, and emits task.updated. It rejects running tasks, disabled/missing packages, stale task versions, and ordinary tasks.

- [ ] Step 5: Run focused snapshot tests and commit.

  Run:

    node --test test/feishu-workflow-store.test.mjs test/feishu-workflow-api.test.mjs test/task-start-flow.test.mjs

  Expected: PASS, including the existing real-title-field path. Commit:

    git add server/database.mjs server/app.mjs server/feishu-workflow-store.mjs server/feishu-workflow-api.mjs web/src/components/FeishuWorkflowPanel.tsx web/src/api.ts web/src/types.ts test/feishu-workflow-store.test.mjs test/feishu-workflow-api.test.mjs test/task-start-flow.test.mjs
    git commit -m "feat: snapshot Auto-Cut package settings per task"

### Task 4: Add Durable Five-Second Delay and Visible Per-Package Queueing

**Files:**
- Create: server/feishu-execution-coordinator.mjs
- Modify: server/database.mjs, server/app.mjs, server/resource-scheduler.mjs
- Modify: shared/domain.mjs, web/src/types.ts, web/src/issueBoardStatuses.ts, web/src/App.tsx, web/src/components/BoardColumn.tsx, web/src/i18n.tsx
- Modify: test/resource-scheduler.test.mjs, test/task-start-flow.test.mjs
- Create: test/feishu-execution-coordinator.test.mjs

**Interfaces:**
- TaskboardDatabase.createFeishuExecution({ taskId, mode, readyAt, packageAlias, packageRevision })
- TaskboardDatabase.getFeishuExecution(taskId), listPendingFeishuExecutions(), setFeishuExecutionState(taskId, expectedVersion, state), and clearFeishuExecution(taskId)
- createFeishuExecutionCoordinator({ database, packageStore, scheduler, startClaimedTask, now, timers }) exposes schedule(task, metadata, trigger), cancel(taskId), recover(), and close()
- TaskStatus gains queued; MAIN_STATUSES becomes [todo, queued, in_progress, blocked, in_review].

- [ ] Step 1: Write failing coordinator tests.

  Use a fake clock/timer and fake scheduler to assert: automatic registration creates a persisted deadline exactly 5,000 ms ahead; 立即开始 uses the same task without waiting; an available slot starts without queued; a saturated package changes the task to queued; FIFO ordering is per alias; another package starts independently; disabled packages remain todo; restart recovery re-enqueues delayed/queued records once.

- [ ] Step 2: Migrate the task status domain to include queued.

  Update shared/domain.mjs and web/src/types.ts. Extend the SQLite task check constraint through the existing #migrateTaskStatuses() table rebuild, preserving all columns and rows. Update all status arrays, filters, task editor options, context-menu options, and board ordering so queued is visible but cannot be selected as an arbitrary ordinary-task status unless the task is a server-registered execution task.

- [ ] Step 3: Add durable execution records and coordinator state transitions.

  Create feishu_task_executions with task_id, state (delayed|queued|running), mode, ready_at, package_alias, package_revision, trigger, lease_id, created_at, updated_at, and last_error. schedule writes the record before starting work. The coordinator wakes at the earliest deadline, verifies task version/provenance/package state, asks the scheduler for the package current maxConcurrent, marks queued only when the lease is pending, and calls the existing Codex start callback after moving to in_progress.

- [ ] Step 4: Route automatic and manual starts through the coordinator.

  Replace the immediate startTrackedTask(...startTaskWithAi...) calls in POST /api/local/feishu/tasks, /api/local/tasks/:id/execute, /api/tasks/:id/start-ai, and Feishu drag-to-processing with coordinator scheduling. Return the current task and execution state in the 202 body. Keep 立即开始 as a coordinator request with readyAt = now and retain the trusted-origin check.

- [ ] Step 5: Make package concurrency the live source of truth.

  Change executionRequestForTask to read the current package record for maxConcurrent and use autocut:\${alias} as the concurrency group. Preserve subject resource groups only as additional exclusive resources. Do not use metadata.maxConcurrent as a package limit. A package disable blocks new leases; changing the limit affects only future grants.

- [ ] Step 6: Recover delayed/queued work during server startup and close.

  Construct the coordinator before reconcileClaimedFeishuTasks(), call recover() once after database initialization, and await close() before closing the HTTP server. Recovery must not recreate a Codex thread for any task_ai_starts row; it only restores delayed/queued records without duplicate task creation.

- [ ] Step 7: Run focused queue tests and commit.

  Run:

    node --test test/feishu-execution-coordinator.test.mjs test/resource-scheduler.test.mjs test/task-start-flow.test.mjs test/task-move-ui.test.mjs

  Expected: PASS with tasks visibly distinct as todo, queued, and in_progress. Commit:

    git add server/feishu-execution-coordinator.mjs server/database.mjs server/app.mjs server/resource-scheduler.mjs shared/domain.mjs web/src/types.ts web/src/issueBoardStatuses.ts web/src/App.tsx web/src/components/BoardColumn.tsx web/src/i18n.tsx test/feishu-execution-coordinator.test.mjs test/resource-scheduler.test.mjs test/task-start-flow.test.mjs test/task-move-ui.test.mjs
    git commit -m "feat: add durable Auto-Cut delay and queue states"

### Task 5: Pass Package-Specific Codex Settings Through the Existing Codex Path

**Files:**
- Modify: server/app.mjs, server/ai-chat.mjs, server/ai-chat-catalog.mjs
- Modify: shared/codex-invocation.mjs if invocation metadata requires the model/effort fields
- Modify: web/src/types.ts, web/src/components/FeishuPackageManager.tsx
- Modify: test/task-start-flow.test.mjs, test/ai-chat-server.test.mjs, test/ai-chat-runner.test.mjs

**Interfaces:**
- startClaimedTaskWithAi(..., packageSnapshot, currentPackage, lease, trigger)
- aiChat.createThread({ id, projectId, issueId, title, model, reasoningEffort, sandbox })

- [ ] Step 1: Write the Codex invocation test.

  Register two packages with different model, effort, prompt, and workspace values. Start one task for each and assert the fake Codex capture receives each package's snapshot values, while the live package state controls whether a disabled package is allowed to start.

- [ ] Step 2: Resolve snapshot versus live package data.

  Use the stored task snapshot for workspace, prompt, model, reasoning effort, and ZIP source directory. Read the current registry only for state, current maxConcurrent, and alias existence. If the snapshot workspace is unavailable, fail the task before creating a Codex thread and return the safe package error.

- [ ] Step 3: Pass model and reasoning effort into AiChatService.

  At thread creation, pass the snapshot model and reasoning effort. Keep the existing catalog validation inside AiChatService; map invalid model/effort to PACKAGE_MODEL_UNAVAILABLE without exposing Codex command output. Submit only the trusted snapshot prompt as the turn message.

- [ ] Step 4: Verify and commit.

  Run:

    node --test test/task-start-flow.test.mjs test/ai-chat-server.test.mjs test/ai-chat-runner.test.mjs

  Expected: PASS and fake Codex captures the package-specific settings. Commit:

    git add server/app.mjs server/ai-chat.mjs server/ai-chat-catalog.mjs shared/codex-invocation.mjs web/src/types.ts web/src/components/FeishuPackageManager.tsx test/task-start-flow.test.mjs test/ai-chat-server.test.mjs test/ai-chat-runner.test.mjs
    git commit -m "feat: run Codex with package-specific model settings"

### Task 6: Connect ZIP Completion to Manual and Automatic Branches

**Files:**
- Modify: server/app.mjs, server/database.mjs, server/artifact-service.mjs
- Modify: web/src/components/TaskDetail.tsx, web/src/components/ArtifactUploadView.tsx, web/src/api.ts, web/src/types.ts
- Modify: test/completed-editing-view.test.mjs, test/artifact-service.test.mjs, test/task-start-flow.test.mjs, test/artifact-upload-queue.test.mjs

**Interfaces:**
- TaskboardDatabase.getTaskZipSourceSnapshot(taskId) returns the task's captured optional source directory.
- Existing manual artifact selection route remains the first supported association path.
- completeFeishuTaskAfterArtifact(task, artifact) chooses done for automatic metadata and in_review for manual metadata.

- [ ] Step 1: Write branch tests.

  Assert that a verified manually selected ZIP on a manual task moves to in_review, the same artifact on an automatic task moves to done, automatic upload enqueue still runs only after done, and an unverified or non-task ZIP is rejected.

- [ ] Step 2: Preserve manual ZIP selection and expose package source context.

  Keep exact task-to-artifact ownership and SHA-256 validation. Show the captured package ZIP source directory as read-only context when configured, but keep the explicit file picker as the only association action while the Auto-Cut output identity contract is undefined.

- [ ] Step 3: Apply the completion branch.

  Replace any completion path that assumes one status with completedTaskStatusForMetadata(metadata). Release the execution lease before emitting the final task update, and never choose a ZIP by newest modified time.

- [ ] Step 4: Verify and commit.

  Run:

    node --test test/completed-editing-view.test.mjs test/artifact-service.test.mjs test/task-start-flow.test.mjs test/artifact-upload-queue.test.mjs

  Expected: PASS with automatic tasks visible in 已完成剪辑 and manual tasks visible in 待验收 until confirmation. Commit:

    git add server/app.mjs server/database.mjs server/artifact-service.mjs web/src/components/TaskDetail.tsx web/src/components/ArtifactUploadView.tsx web/src/api.ts web/src/types.ts test/completed-editing-view.test.mjs test/artifact-service.test.mjs test/task-start-flow.test.mjs test/artifact-upload-queue.test.mjs
    git commit -m "feat: branch Auto-Cut completion by execution mode"

### Task 7: Add Global Board-Stage Label Settings

**Files:**
- Modify: server/database.mjs, server/app.mjs, server/feishu-package-api.mjs
- Create: web/src/components/BoardStageSettings.tsx
- Modify: web/src/components/FeishuPackageManager.tsx, web/src/api.ts, web/src/types.ts, web/src/i18n.tsx, web/src/App.tsx, web/src/styles.css
- Modify: test/board-stage-settings.test.mjs, test/board-views.test.mjs, test/board-interactions.test.mjs

**Interfaces:**
- TaskboardDatabase.getBoardStageLabels() returns { version, labels: { zh: Record<TaskStatus,string>, en: Record<TaskStatus,string> } }.
- TaskboardDatabase.saveBoardStageLabels(expectedVersion, labels) performs CAS and emits a revision event.
- GET /api/local/board-stage-labels and PATCH /api/local/board-stage-labels serve the settings.
- TaskboardI18nContext accepts loaded global label overrides and exposes statusLabel(status) to UI consumers.

- [ ] Step 1: Write label persistence and UI tests.

  Assert default labels (todo=待处理, queued=排队中, in_progress=处理中), global visibility across two selected subjects, CAS conflict behavior, and that changing a display label does not change the internal status or scheduler route.

- [ ] Step 2: Persist bilingual labels in Taskboard SQLite.

  Add a single taskboard_settings row keyed by board-stage-labels, validate every internal task status has a non-empty label for zh and en, and expose the two routes through the existing loopback local API. Use the same event revision polling path as other local settings.

- [ ] Step 3: Thread overrides through the i18n context.

  Update TaskboardLanguageProvider and UI call sites that currently import taskStatusLabel directly. Keep stable internal status IDs in URLs, filters, drag/drop, APIs, and database; only rendered copy changes.

- [ ] Step 4: Add settings controls to the package page.

  Render BoardStageSettings below the package editor as a global section. Provide Chinese and English inputs for each existing status plus queued, save/cancel buttons, and a conflict message that reloads the latest settings. Do not offer creation/deletion of functional status IDs in this slice.

- [ ] Step 5: Verify and commit.

  Run:

    node --test test/board-stage-settings.test.mjs test/board-views.test.mjs test/board-interactions.test.mjs

  Expected: PASS; every Base and subject board renders the saved labels. Commit:

    git add server/database.mjs server/app.mjs server/feishu-package-api.mjs web/src/components/BoardStageSettings.tsx web/src/components/FeishuPackageManager.tsx web/src/api.ts web/src/types.ts web/src/i18n.tsx web/src/App.tsx web/src/styles.css test/board-stage-settings.test.mjs test/board-views.test.mjs test/board-interactions.test.mjs
    git commit -m "feat: add global board stage labels"

### Task 8: Move Bridge to the Dedicated Registry and Update Local Startup

**Files:**
- Create: D:\codex\codex-feishu\src\package-config.mjs
- Modify: D:\codex\codex-feishu\src\config.mjs, src/index.mjs, src/decide-event.mjs, src/bridge.mjs, src/workflow-config-store.mjs, src/server.mjs
- Modify: D:\codex\codex-feishu\config\bridge.example.json
- Create: D:\codex\codex-feishu\config\autocut-packages.example.json
- Modify: D:\codex\codex-feishu\.gitignore, scripts/start-local.ps1, README.md, AGENTS.md
- Modify: D:\codex\codex-feishu\test\config.test.mjs, test\decide-event.test.mjs, test\bridge.test.mjs, test\workflow-config.test.mjs, test\startup-scripts.test.mjs, test\server.test.mjs

**Interfaces:**
- loadPackageRegistry(filename): Promise<Record<string, AutoCutPackage>>
- normalizePackageRegistry(value) validates the same schema as Taskboard and returns a safe alias map.
- createBridge({ packageCatalog, ... }) and decideRecordChange({ ...config, packages: packageCatalog }, event) keep package aliases separate from Bridge listener/table config internally.

- [ ] Step 1: Add a one-time migration test for the current bridge.local.json shape.

  Given a legacy config with packages.Auto-cut-copyA, the startup migration copies only package records to the ignored dedicated registry, leaves tables/delivery/credentials untouched, and does not log workspace paths or prompts. Given a dedicated registry, startup never reads package definitions from the Bridge config.

- [ ] Step 2: Implement Bridge package loading and alias routing.

  Create src/package-config.mjs with the same absolute-path, prompt, model, effort, ZIP directory, state, and concurrency validation. Inject its result into createWorkflowConfigStore, createBridge, decision evaluation, and config summary. Keep Bridge responsible for alias allowlisting and decision fingerprints; it never starts Codex.

- [ ] Step 3: Update local launcher and examples.

  Use the existing ignored config/taskboard-feishu-packages.json path as the default dedicated registry for the first deployment, while allowing CODEX_FEISHU_PACKAGES_PATH to override it. Inject that path into both Taskboard and Bridge. Copy the package example only when the dedicated file is absent; do not overwrite an operator's registry. Remove package definitions from the new Bridge example and document the migration path.

- [ ] Step 4: Update runtime rules and README.

  Amend AGENTS.md to state that Bridge listener/routing config remains in bridge.local.json and trusted Auto-Cut package definitions live in the dedicated ignored registry. Update README commands, paths, startup checks, test-table setup, and the fact that disabled aliases may produce held tasks but cannot start Codex.

- [ ] Step 5: Run Bridge verification and commit.

  Run in D:\codex\codex-feishu:

    npm test
    .\scripts\start-local.ps1
    .\scripts\check-local.ps1
    .\scripts\simulate-ready.ps1
    .\scripts\check-local.ps1
    .\scripts\stop-local.ps1

  Expected: all tests pass; both services remain loopback-only; simulated ready events use the dedicated package alias; no second task is created on replay. Commit only Bridge files:

    git add src/package-config.mjs src/config.mjs src/index.mjs src/decide-event.mjs src/bridge.mjs src/workflow-config-store.mjs src/server.mjs config/bridge.example.json config/autocut-packages.example.json .gitignore scripts/start-local.ps1 README.md AGENTS.md test/config.test.mjs test/decide-event.test.mjs test/bridge.test.mjs test/workflow-config.test.mjs test/startup-scripts.test.mjs test/server.test.mjs
    git commit -m "refactor: share dedicated Auto-Cut package registry"

### Task 9: End-to-End Verification and Handoff

**Files:**
- Modify only if verification reveals a direct-path defect: the files from Tasks 1-8.
- Do not stage unrelated pre-existing changes in either worktree.

- [ ] Step 1: Run Taskboard focused and full checks.

  From D:\codex\worktrees\dashi-taskboard-autocut-workflow run:

    npm test
    npm run build --if-present

  Expected: all tests pass and the production web build completes.

- [ ] Step 2: Demonstrate the direct product path with a fake package.

  Register a harmless fake Codex workspace, select it in one test subject, simulate one ready event, observe 待处理, wait five seconds or click 立即开始, saturate the package to observe 排队中, capture the package-specific Codex invocation, manually select a fixture ZIP, and verify automatic/manual completion branches.

- [ ] Step 3: Verify restart and configuration isolation.

  Restart during the five-second delay and during a queued task; verify no duplicate task or Codex run. Export/import shared Feishu configuration and verify local package paths, prompts, models, ZIP directories, and stage labels are absent from the export.

- [ ] Step 4: Run one real Feishu long-connection test after the replacement Auto-Cut is deployed.

  From D:\codex\codex-feishu run:

    .\scripts\check-local.ps1 -RequireFeishu

  Then use the approved test Base/table once: 待剪辑 → 待处理 → Codex start → manual ZIP association → expected completion column. Do not repeatedly modify production records.

- [ ] Step 5: Provide the user-facing handoff.

  Report the exact package registry path, the package manager entry, the meaning of 待处理/排队中, the fake-package verification result, and the remaining limitation: automatic ZIP matching waits for the replacement Auto-Cut's trusted output identity contract.

## Self-Review Checklist

- Spec coverage: Tasks 1-3 cover registry ownership, package UI, subject selection, and immutable snapshots; Task 4 covers five-second delay, immediate start, queueing, concurrency, and restart recovery; Task 5 covers Codex/GPT invocation; Task 6 covers ZIP and completion branches; Task 7 covers global labels; Task 8 covers Bridge and startup rules; Task 9 covers direct and real verification.
- Placeholder scan: no incomplete marker or unspecified handling step is used; every route, store method, status, and verification command is named.
- Type consistency: AutoCutPackage, queued, feishu_task_package_snapshots, feishu_task_executions, getFeishuTaskPackageSnapshot, and createFeishuExecutionCoordinator are defined before later tasks consume them.
- Scope: package registration, task execution, board labels, and Bridge migration remain one connected feature because each is required for the agreed main path; upload transfer and automatic ZIP matching stay excluded.
