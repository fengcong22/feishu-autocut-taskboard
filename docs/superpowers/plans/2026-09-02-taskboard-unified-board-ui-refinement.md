# Taskboard Unified Workflow Board UI Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the repository's subagent-driven-development or executing-plans workflow. Every implementation task below uses checkbox steps and ends with an independent test cycle.

**Goal:** Give each Feishu Base/subject one configurable, single-page workflow board while preserving project isolation, existing Auto-Cut/Codex execution, upload safety, and recoverable project history.

**Architecture:** Keep Taskboard task statuses, Feishu subject configuration, the upload worker, and OtherTasksPanel as the sources of truth. Add a local, versioned view-definition store keyed by immutable subjectKey; classify each task once, calculate hidden-stage summaries, and project the result into the selected view. Ordinary projects continue to use the existing React Flow workflow workspace. The cloud worker receives the same project archive lifecycle contract, while Feishu view configuration remains a local companion capability.

**Tech Stack:** React 19, TypeScript, Vite, Node.js 22 node:test, SQLite node:sqlite, Cloudflare D1, existing SSE/revision polling, and the repository's local browser scripts.

## Global Constraints

- Production data flow remains: Feishu Base change -> official SDK long connection -> Bridge filtering/normalization/deduplication -> Taskboard local-source registration.
- Bridge and Taskboard remain bound to 127.0.0.1 only; Bridge never starts Codex.
- Automatic execution remains opt-in through CODEX_TASKBOARD_ALLOW_AUTOMATIC_EXECUTION and still requires a Bridge-only registration, an automatic snapshot, and a whitelisted package alias.
- Do not change Bridge filtering, five-second delay, Auto-Cut/Codex invocation, concurrency/resource-group scheduling, ZIP validation, upload copying, or Feishu writeback.
- A Base and every subject table remain independent scopes. Tasks, uploads, views, display overrides, and layouts must never cross subjectKey values.
- Feishu removal hides local directory entries and preserves local history; it never deletes a remote Base, table, or record.
- Upload columns are read-only task-drop targets. Upload state changes continue through existing enqueue, worker, and retry APIs.
- Local paths, prompts, commands, package secrets, storage keys, and Bridge secrets never enter view definitions, layout preferences, cards, shared configuration, or ordinary API responses.
- Existing dirty worktree changes belong to the user. Each task stages only the files named by that task.

## Fixed Contracts

### Unified workflow views

The stable stage registry is defined once in `shared/unified-workflow-stages.mjs` and imported by both the server and web code:

~~~js
export const UNIFIED_WORKFLOW_STAGES = Object.freeze([
  "todo", "queued", "in_progress", "blocked", "in_review",
  "completed_editing", "upload_queue", "uploading", "uploaded",
]);
export const REAL_UNIFIED_WORKFLOW_STAGES = Object.freeze([
  "todo", "queued", "in_progress", "blocked", "in_review",
]);
export const UPLOAD_UNIFIED_WORKFLOW_STAGES = Object.freeze([
  "completed_editing", "upload_queue", "uploading", "uploaded",
]);
~~~

    UnifiedWorkflowView {
      id: string
      subjectKey: string
      name: string
      stageIds: UnifiedWorkflowStage[]
      isSystem: boolean
      revision: number
      createdAt: string
      updatedAt: string
    }

    UnifiedWorkflowViewsState {
      schemaVersion: 1
      subjectKey: string
      revision: number
      defaultViewId: string
      activeViewId: string
      views: UnifiedWorkflowView[]
      readOnly: boolean
    }

`UnifiedWorkflowStage` is the literal union `"todo" | "queued" | "in_progress" | "blocked" | "in_review" | "completed_editing" | "upload_queue" | "uploading" | "uploaded"`; it is distinct from the Taskboard `TaskStatus` union because upload stages are board-only projections. The only automatically-created view is all / 全部流程. It contains the complete stable stage registry in board order and cannot be renamed, edited, reduced, or deleted. A custom view stores an explicit stageIds allow-list and must contain at least one valid stage. No 剪辑流程 or 上传流程 preset is generated.

stateRevision protects the collection and active/default pointers. viewRevision protects an individual row. A stale token returns 409 VERSION_CONFLICT with expectedVersion and actualVersion.

### Stage display overrides

    StageDisplayOverride {
      subjectKey: string
      stageId: UnifiedWorkflowStage
      zhName: string | null
      enName: string | null
      zhDescription: string | null
      enDescription: string | null
      revision: number
      updatedAt: string
    }

Names are plain text up to 32 characters and descriptions plain text up to 120 characters. Control characters, HTML, and scripts are rejected. A reset stores null values and uses built-in text.

### Browser-only layout

Key: taskboard.unified-board.layout.v1:<projectId>:<viewId>.

    {
      columnWidthPreset: "narrow" | "standard" | "wide",
      cardDensity: "compact" | "comfortable",
      boardScrollLeft: number,
      columnScrollTop: Record<string, number>,
      zipExpansion: Record<string, boolean>
    }

This state never leaves the browser and is removed when a project or view is permanently deleted.

---

### Task 1: Add project archive lifecycle and complete deletion protection

Files:

- Modify: server/database.mjs (project migration, projectFromRow, listProjects, getProject, createProject, deleteProject, source-sync helpers)
- Modify: server/app.mjs (project routes and events)
- Modify: web/src/types.ts (Project)
- Modify: web/src/api.ts (project list/options and archive helper)
- Create: cloud/migrations/0006_project_archive.sql
- Modify: cloud/src/index.mjs
- Modify: scripts/migrate-to-cloud.mjs
- Create: test/project-lifecycle.test.mjs
- Modify: test/cloud-shared-worker.test.mjs and test/cloud-migration.test.mjs

Interfaces:

- Consumes: current projects table and all task/artifact/chat/workflow associations.
- Produces: `Project.archivedAt`, `Project.source`, `Project.archivedIssueCount`, user-facing `TaskboardDatabase.listProjects({ includeArchived })`, user-facing `TaskboardDatabase.setProjectArchived(id, archived)`, internal source-sync archive/freeze primitives, and `POST /api/projects/:id/archive`.

- [ ] Step 1: Write failing local API tests

Create an isolated server fixture and add these assertions:

~~~js
test("active listing omits archived projects and explicit history includes them", async () => {
  const baseUrl = await startServer();
  await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "temp-history", name: "History", workspacePath: null },
  });
  const archived = await request(baseUrl, "/api/projects/temp-history/archive", {
    method: "POST",
    body: { archived: true },
  });
  assert.equal(archived.response.status, 200);
  assert.notEqual(archived.body.project.archivedAt, null);
  assert.equal((await request(baseUrl, "/api/projects")).body.projects.some((p) => p.id === "temp-history"), false);
  const all = await request(baseUrl, "/api/projects?includeArchived=true");
  assert.equal(all.body.projects.find((p) => p.id === "temp-history").archivedAt !== null, true);
});

test("archived projects reject writes until restored", async () => {
  const baseUrl = await startServer();
  await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "temp-write-guard", name: "Guard", workspacePath: null },
  });
  await request(baseUrl, "/api/projects/temp-write-guard/archive", {
    method: "POST",
    body: { archived: true },
  });
  const blocked = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { projectId: "temp-write-guard", title: "Must fail" },
  });
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.body.error.code, "PROJECT_ARCHIVED");
  const restored = await request(baseUrl, "/api/projects/temp-write-guard/archive", {
    method: "POST",
    body: { archived: false },
  });
  assert.equal(restored.body.project.archivedAt, null);
});

test("permanent deletion checks archived tasks and non-task associations", async () => {
  const baseUrl = await startServer();
  await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "temp-protected", name: "Protected", workspacePath: null },
  });
  const created = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { projectId: "temp-protected", title: "Archived issue" },
  });
  await request(baseUrl, "/api/tasks/" + created.body.task.id + "/archive", {
    method: "POST",
    body: { version: created.body.task.version },
  });
  const result = await request(baseUrl, "/api/projects/temp-protected", { method: "DELETE" });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.error.code, "PROJECT_NOT_EMPTY");
  assert.equal(result.body.error.details.associations.tasks, 1);
});

test("an empty manually-created project can be archived and permanently deleted", async () => {
  const baseUrl = await startServer();
  await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "temp-empty", name: "Empty", workspacePath: null },
  });
  await request(baseUrl, "/api/projects/temp-empty/archive", {
    method: "POST",
    body: { archived: true },
  });
  assert.equal((await request(baseUrl, "/api/projects/temp-empty", { method: "DELETE" })).response.status, 204);
});
~~~

The test file must import the existing `startServer`/`request` fixture pattern from `test/server.test.mjs` (copy the helper locally because that file is not an importable helper), close every app in `afterEach`, and add table-driven cases for `PROJECT_ARCHIVE_FORBIDDEN` on the `local`/global and Feishu sources, for an archived task, and for each non-task association count. It must assert `UNKNOWN_QUERY_PARAMETER` for a second project-list query key, that a Bridge-only registration against an archived project is rejected, and that an already-registered task can still be moved or uploaded. The DELETE/count race test must arrange a concurrent insert and verify the result is either a protected conflict or a successful delete with zero associations, never a partial cascade.

- [ ] Step 2: Run the focused tests and verify the missing behavior

Run:

~~~powershell
node --test test/project-lifecycle.test.mjs
~~~

Expected: failures for archivedAt, includeArchived, the archive route, and PROJECT_ARCHIVED.

- [ ] Step 3: Add local SQLite migration and database methods

In server/database.mjs:

1. Add nullable `archived_at` and `source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('global', 'local', 'feishu'))` to `projects` with idempotent upgrade checks. Set the existing `local` row to `global`, update every existing row joined through `feishu_subjects.project_id` (including removed subjects) to `feishu`, and leave the remaining legacy rows as `local`; Feishu-created rows are written with `source='feishu'`; user-created rows are always `source='local'` regardless of request body.
2. Add `archivedAt`, `source`, `issueCount` (active tasks), and `archivedIssueCount` (archived tasks) to `projectFromRow`; never expose workspace paths through the new history-only fields.
3. Change `listProjects(options = {})` to omit archived rows unless `includeArchived === true`, preserve active `issueCount`, add `archivedIssueCount`, and order active/history rows deterministically.
4. Add transactional `setProjectArchived(id, archived)`. Global and Feishu projects return `PROJECT_ARCHIVE_FORBIDDEN` because their lifecycle is source-managed. Add separately named internal `syncSourceProjectArchived(id, archived, source, transaction)` and `freezeSourceWorkflowState(subjectKey, transaction)` primitives that accept a caller-owned transaction callback/connection; they never start a nested transaction when called by the store, accept only a validated Feishu identity, are never exposed as general routes, and return the updated project/state.
5. Make task creation, workflow workspace saves, AI thread creation, and Bridge-only new-task registration call an active-project check and return `PROJECT_ARCHIVED`. This is an intake/write guard only: existing task state transitions, Auto-Cut/Codex runs, artifact upload leases, retries, and worker completion for already-registered tasks continue while a project is archived or a subject is removed.
6. Add `getProjectAssociationCounts(id)`. Count tasks including archived tasks, comments, task activities, attachments, task artifacts, artifact uploads, Feishu origins, package snapshots, executions, relations, workflow workspaces, project summaries, AI chat threads where `origin_project_id` matches, and any newly-created view/display rows. Detect optional tables with `sqlite_master` and report zero for a table that has not been created yet (Task 1 runs before the view/display migrations); never issue a query against a missing table. Return a stable object with one integer per association type and `total`.
7. Make `deleteProject` perform the source/type check and association count under the same `BEGIN IMMEDIATE` transaction as the final DELETE. Allow only `source='local'` projects whose id starts with `temp-` and whose total association count is zero. Non-empty projects return `PROJECT_NOT_EMPTY` with complete counts; global/Feishu/non-temp projects return their protected error; no cascade deletion is allowed.

Use the existing `BEGIN IMMEDIATE` and version/error conventions for writes. The returned object from `setProjectArchived` is the updated Project. Add tests for every association family (including an archived task, a chat thread, an upload row, a workflow workspace, and a Feishu origin) proving permanent deletion remains blocked.

- [ ] Step 4: Add local route and client contracts

server/app.mjs must accept only includeArchived on GET /api/projects and reject every other query parameter with UNKNOWN_QUERY_PARAMETER. Add:

~~~text
POST /api/projects/:id/archive
body: { archived: boolean }
response: { project: Project }
~~~

Emit project.updated after archive/restore and keep DELETE /api/projects/:id as permanent deletion only.

Add `archivedAt: string | null`, `source: "global" | "local" | "feishu"`, and `archivedIssueCount: number` to `Project` in `web/src/types.ts` and expose:

~~~ts
listProjects(options?: { includeArchived?: boolean; signal?: AbortSignal }): Promise<Project[]>
setProjectArchived(projectId: string, archived: boolean): Promise<Project>
~~~

- [ ] Step 5: Mirror project lifecycle in D1

Create cloud/migrations/0006_project_archive.sql:

~~~sql
ALTER TABLE projects ADD COLUMN archived_at TEXT;
ALTER TABLE projects ADD COLUMN source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('global', 'local', 'feishu'));
UPDATE projects SET source = 'global' WHERE id = 'local';
CREATE INDEX IF NOT EXISTS projects_archived_created
  ON projects(archived_at, created_at, id);
~~~

Update `cloud/src/index.mjs` functions `projectFromRow`, `listProjects`, `getProject`, `createProject`, and `deleteProject`; add `setProjectArchived` and the archive route. Use the same query filtering, source values, error codes, and intake-only write guard. Cloud association counts cover the tables that exist in D1 (`tasks`, `comments`, `task_activities`, `attachments`, `task_relations`, and `workflow_workspaces`) and must not reference local-only artifact, Feishu, view, or AI tables. Update `scripts/migrate-to-cloud.mjs` to set `SCHEMA_VERSION = 2`, export/import `archived_at` and `source`, emit a v2 manifest, and accept v1 manifests by normalizing missing fields to `archived_at: null` and `source: 'local'`; reject versions newer than 2. Mark the canonical `local` project as `global` in the v2 export/import round-trip, and add a test that verifies both fields survive a bundle cycle. No cloud row may be inferred as Feishu solely from an id prefix.

- [ ] Step 6: Run and commit

Run:

~~~powershell
node --test test/project-lifecycle.test.mjs test/server.test.mjs
node --test test/cloud-shared-worker.test.mjs test/cloud-migration.test.mjs
~~~

Expected: all lifecycle, migration, and existing CRUD tests pass.

~~~powershell
git add server/database.mjs server/app.mjs web/src/types.ts web/src/api.ts cloud/migrations/0006_project_archive.sql cloud/src/index.mjs scripts/migrate-to-cloud.mjs test/project-lifecycle.test.mjs test/cloud-shared-worker.test.mjs test/cloud-migration.test.mjs
git commit -m "feat: add protected project archive lifecycle"
~~~

### Task 2: Synchronize Feishu removal/re-add with the local directory

Files:

- Modify: server/feishu-workflow-store.mjs (upsertBasePreview, importShareable, removeSubject, removeBase, removeSubjectRows)
- Modify: server/database.mjs (source-sync archive/freeze transaction)
- Modify: web/src/App.tsx (catalog refresh, selection fallback, request generation)
- Modify: web/src/components/FeishuBaseNavigator.tsx
- Create: test/feishu-project-lifecycle.test.mjs
- Modify: test/feishu-workflow-store.test.mjs, test/feishu-workflow-api.test.mjs, test/project-home.test.mjs

Interfaces:

- Consumes: the internal `TaskboardDatabase.syncSourceProjectArchived`/`freezeSourceWorkflowState` transaction callbacks from Task 1 (invoked with the store's already-open transaction) and existing removed_at/lifecycle transitions; it must not call the user-facing `setProjectArchived`, which intentionally rejects Feishu projects.
- Produces: atomic local project archive on Base/subject removal, project restoration on re-add, and clean selection fallback.

- [ ] Step 1: Write failing lifecycle tests

Use a Base containing two subjects:

~~~js
test("removing one subject archives only that subject project", async () => {
  const fixture = await createFeishuFixture();
  const catalog = await fixture.store.upsertBasePreview(baseWithSubjects(["table-a", "table-b"]));
  const subject = catalog.subjects.find((item) => item.tableId === "table-a");
  await fixture.store.removeSubject(subject.subjectKey);
  assert.notEqual(fixture.database.getProject(subject.projectId).archivedAt, null);
  assert.equal(fixture.database.listProjects().some((item) => item.id === subject.projectId), false);
  assert.equal(fixture.database.listProjects({ includeArchived: true }).some((item) => item.id === subject.projectId), true);
});

test("re-adding a removed subject restores its project and preserves history", async () => {
  const fixture = await createFeishuFixture();
  const first = await fixture.store.upsertBasePreview(baseWithSubjects(["table-a"]));
  const subject = first.subjects[0];
  await fixture.store.removeSubject(subject.subjectKey);
  await fixture.store.upsertBasePreview(baseWithSubjects(["table-a"]));
  assert.equal(fixture.database.getProject(subject.projectId).archivedAt, null);
});

test("disable and display-hide do not archive a subject project", async () => {
  const fixture = await createFeishuFixture();
  const catalog = await fixture.store.upsertBasePreview(baseWithSubjects(["table-a"]));
  const subject = catalog.subjects[0];
  await fixture.store.disableSubject(subject.subjectKey, subject.configVersion);
  assert.equal(fixture.database.getProject(subject.projectId).archivedAt, null);
  await fixture.store.setSubjectDisplayEnabled(subject.subjectKey, false);
  assert.equal(fixture.database.getProject(subject.projectId).archivedAt, null);
});
~~~

Define `createFeishuFixture()` in the new test using `createTaskboardServer` with a temporary data directory and the same deterministic `feishuPackages`/Bridge stubs used by `test/feishu-workflow-api.test.mjs`; expose `{ app, database, store }` and close/remove the directory in `afterEach`. `baseWithSubjects(ids)` must return real preview rows with stable `baseToken`, `tableId`, and names, so assertions exercise the production subject-key derivation rather than a hand-built fake project id.

- [ ] Step 2: Run tests and verify the gap

Run node --test test/feishu-project-lifecycle.test.mjs test/feishu-workflow-store.test.mjs. Expected: failure because current removed_at hides the subject but leaves its project active.

- [ ] Step 3: Add atomic archive/restore

In `removeSubjectRows`, update each locked Feishu project's `projects.archived_at` and freeze its active view pointer/display overrides in the same transaction that writes `removed_at`, by passing the store's transaction callback to both primitives. The freeze helper must detect absent view tables (Task 2 runs before Task 3) and no-op safely; once the tables exist, it sets the active pointer to the system view and marks the state read-only without deleting historical definitions. In `upsertBasePreview` and non-dry-run `importShareable`, clear `archived_at`, restore the active pointer, and unfreeze the same subject only after the subject row is restored. Do not archive for merely disabled or display-hidden subjects. A source-sync call must verify the project identity is the deterministic Feishu subject project before updating it.

The Base removal transaction must update every affected project and configuration row or roll back everything on a version conflict. A failed Bridge lifecycle sync must leave the subject, project, view pointer, and display overrides unchanged. Add a regression that removes a Base with two subjects, verifies both local projects are archived and their view state is read-only, then re-adds one subject and verifies only that subject is restored.

- [ ] Step 4: Make App selection race-safe

Add projectRequestGenerationRef and an AbortController for each project/catalog load. Before applying a project, task, upload, or catalog response, require both the matching generation and current selectedProjectId/subjectKey. On removal of the selected resource:

1. Clear detail, context menu, drag state, upload summaries, and scroll refs.
2. Select the next visible subject in the same Base, then the next active project, then global.
3. Update URL and recent-project storage.
4. Refresh active/history projects and the Feishu catalog.

Late responses from the removed project must be discarded.

- [ ] Step 5: Update navigator wording and tests

Keep “从 Taskboard 移除” explicit that remote Feishu content is not deleted. Keep disabled subjects in configuration but out of intake; keep removed subjects out of the active catalog. Add API/source assertions for fallback and restoration.

- [ ] Step 6: Run and commit

~~~powershell
node --test test/feishu-project-lifecycle.test.mjs test/feishu-workflow-store.test.mjs test/feishu-workflow-api.test.mjs test/project-home.test.mjs
git add server/feishu-workflow-store.mjs server/database.mjs web/src/App.tsx web/src/components/FeishuBaseNavigator.tsx test/feishu-project-lifecycle.test.mjs test/feishu-workflow-store.test.mjs test/feishu-workflow-api.test.mjs test/project-home.test.mjs
git commit -m "feat: synchronize Feishu directory lifecycle"
~~~

### Task 3: Create the versioned subject-scoped workflow view model and API

Files:

- Create: web/src/unifiedWorkflowViews.mjs
- Create: shared/unified-workflow-stages.mjs
- Modify: server/database.mjs, server/feishu-workflow-api.mjs, server/app.mjs, web/src/types.ts, web/src/api.ts, web/src/unifiedWorkflow.mjs
- Create: test/unified-workflow-views.test.mjs
- Modify: test/feishu-workflow-api.test.mjs

Interfaces:

- Consumes: active/removed Feishu subjects and the shared `UNIFIED_WORKFLOW_STAGES` registry.
- Produces:

~~~text
GET   /api/local/feishu/workflow/views?subjectKey=...
POST  /api/local/feishu/workflow/views
PATCH /api/local/feishu/workflow/views/:viewId
DELETE /api/local/feishu/workflow/views/:viewId
~~~

POST accepts `{ subjectKey, name, stageIds, stateRevision }`. PATCH accepts `{ subjectKey, stateRevision, viewRevision, name, stageIds, defaultViewId, activeViewId }`; fields not relevant to the requested update are omitted rather than sent as `null`. DELETE accepts `{ subjectKey, stateRevision }`. Every response includes the normalized `UnifiedWorkflowViewsState`. `server/app.mjs` passes the parsed `URLSearchParams` (or an equivalent plain query object) into `createFeishuWorkflowApi.handle`; the API handler validates query keys and cardinality so the direct handler tests and HTTP route have the same contract.

- [ ] **Step 1: Write failing model tests**

~~~js
test("first read creates only the all-stages system view", () => {
  const state = normalizeUnifiedWorkflowViews(null, "base-a:table-a");
  assert.deepEqual(state.views.map((view) => view.id), ["all"]);
  assert.equal(state.views[0].isSystem, true);
  assert.deepEqual(state.views[0].stageIds, UNIFIED_WORKFLOW_STAGES);
  assert.equal(state.defaultViewId, "all");
  assert.equal(state.activeViewId, "all");
});

test("damaged or foreign definitions fall back without business presets", () => {
  const state = normalizeUnifiedWorkflowViews({
    schemaVersion: 1,
    subjectKey: "base-a:table-a",
    revision: 4,
    activeViewId: "bad",
    defaultViewId: "missing",
    views: [{ id: "bad", subjectKey: "other:table", name: "剪辑流程", stageIds: ["in_progress", "unknown", "in_progress"] }],
  }, "base-a:table-a");
  assert.deepEqual(state.views.map((view) => view.id), ["all"]);
});

test("custom view validation requires one unique valid stage", () => {
  assert.throws(() => validateUnifiedWorkflowViewInput({ subjectKey: "s", name: "剪辑", stageIds: [] }), /at least one stage/);
  assert.throws(() => validateUnifiedWorkflowViewInput({ subjectKey: "s", name: "剪辑", stageIds: ["todo", "todo"] }), /duplicate/);
});
~~~

At the top of `test/unified-workflow-views.test.mjs`, import `UNIFIED_WORKFLOW_STAGES` from `../shared/unified-workflow-stages.mjs` and the four pure model functions from `../web/src/unifiedWorkflowViews.mjs`. Add route-level cases to the existing Feishu API fixture for missing/duplicate `subjectKey`, unknown body keys, stale `stateRevision`, removed-subject writes, and an attempted system-view rename/delete. The fixture must create two subjects and assert that a mutation for one never changes the other.

- [ ] **Step 2: Run the model test and verify the missing behavior**

Run:

~~~powershell
node --test test/unified-workflow-views.test.mjs
~~~

Expected: failures because `web/src/unifiedWorkflowViews.mjs` and its exports are absent.

- [ ] **Step 3: Implement pure normalization**

Create `shared/unified-workflow-stages.mjs` with the exact arrays in Fixed Contracts and import them from both server and web modules. Keep the export values frozen and never accept a client-supplied stage registry.

Export exactly:

~~~js
export const SYSTEM_UNIFIED_VIEW_ID = "all";
export function normalizeUnifiedWorkflowViews(raw, subjectKey) {}
export function validateUnifiedWorkflowViewInput(input, existingViews = []) {}
export function createUnifiedWorkflowView(input, now = new Date().toISOString()) {}
export function stageIdsInBoardOrder(stageIds) {}
~~~

Trim names, reject empty or overlong names, accept only IDs in the shared `UNIFIED_WORKFLOW_STAGES`, deduplicate only while rejecting duplicate user input, discard damaged or foreign persisted views, preserve the collection revision, and fall back to the system view when active/default IDs are missing. Define and export `UnifiedWorkflowStage` as the literal union of the nine IDs in `web/src/types.ts`; do not reuse `TaskStatus`, because upload stages are not Taskboard task statuses. Make `web/src/unifiedWorkflow.mjs` import the shared registry instead of maintaining a second list, and make the server import the same module for validation. `createUnifiedWorkflowView` starts with no selected stages; the caller must select at least one stage before saving. Keep the system view's complete stage order stable.

- [ ] **Step 4: Add SQLite view-set storage**

Add idempotent `feishu_unified_view_sets` (`subject_key`, `schema_version`, `default_view_id`, `active_view_id`, collection `revision`, `read_only`, `updated_at`) and `feishu_unified_views` (`id`, `subject_key`, `name`, `stage_ids_json`, `is_system`, row `revision`, timestamps, unique `subject_key/name`) tables. Implement `ensureUnifiedWorkflowViews`, `getUnifiedWorkflowViews`, `createUnifiedWorkflowView`, `updateUnifiedWorkflowView`, `deleteUnifiedWorkflowView`, and `setUnifiedWorkflowViewState` on `TaskboardDatabase`. Use `BEGIN IMMEDIATE` and both collection and row revision checks. Mutations against removed subjects/read-only state return `SUBJECT_REMOVED`; the system view returns `SYSTEM_VIEW_PROTECTED`; a stale token returns `VERSION_CONFLICT` with expected and actual versions. GET must be idempotent and create only the system view for a subject that has no row yet. When an already-removed subject is first read, derive `readOnly: true`; when Task 2 calls the source-sync freeze helper, set `read_only=1` and `active_view_id='all'` without deleting rows. Re-add clears `read_only` and restores the prior active pointer only if that pointer still names a valid view.

- [ ] **Step 5: Add route validation, types, and client helpers**

`server/feishu-workflow-api.mjs` must accept `subjectKey` as the only query parameter on the views GET route, require exactly one value, reject unknown query/body fields, validate the subject scope before every mutation, and return the fixed conflict/error codes. Update `server/app.mjs` to pass query data into the handler without changing any other Feishu route. Add `UnifiedWorkflowStage`, `UnifiedWorkflowView`, `UnifiedWorkflowViewsState`, and create/update input types in `web/src/types.ts`. Add typed `getUnifiedWorkflowViews`, `createUnifiedWorkflowView`, `updateUnifiedWorkflowView`, and `deleteUnifiedWorkflowView` helpers in `web/src/api.ts`, using `encodeURIComponent(subjectKey)` and forwarding `ApiError` codes unchanged.

- [ ] **Step 6: Run and commit**

~~~powershell
node --test test/unified-workflow-views.test.mjs test/feishu-workflow-api.test.mjs
git diff --check
git add web/src/unifiedWorkflowViews.mjs server/database.mjs server/feishu-workflow-api.mjs server/app.mjs web/src/types.ts web/src/api.ts test/unified-workflow-views.test.mjs test/feishu-workflow-api.test.mjs
git commit -m "feat: persist subject-scoped workflow views"
~~~

Expected: model normalization, subject isolation, route validation, optimistic conflicts, and API helper tests pass.

### Task 4: Add subject-scoped stage names and descriptions

Files:

- Modify: server/database.mjs (display override table and methods)
- Modify: server/feishu-workflow-api.mjs (stage-display routes)
- Create: web/src/components/UnifiedWorkflowStageSettings.tsx
- Modify: web/src/types.ts and web/src/api.ts
- Create: test/unified-stage-display-settings.test.mjs
- Modify: test/feishu-workflow-ui.test.mjs

Interfaces:

- Consumes: UnifiedWorkflowStage and StageDisplayOverride.
- Produces: GET /api/local/feishu/workflow/stage-displays?subjectKey=... and PATCH /api/local/feishu/workflow/stage-displays/:stageId.

The GET route accepts exactly one `subjectKey` query value through the Task 3 handler contract. PATCH accepts `{ subjectKey, revision, zhName, enName, zhDescription, enDescription }`, where omitted text fields retain their values and `null` explicitly resets a field. It returns the complete subject-scoped override list; unknown query/body fields, invalid stage IDs, and duplicate query values return `UNKNOWN_QUERY_PARAMETER`/`UNKNOWN_FIELD`/`INVALID_FIELD` without touching another subject.

- [ ] Step 1: Write failing validation and UI-contract tests

~~~js
test("stage display validation rejects markup, controls, and overlong text", async () => {
  const fixture = await createFeishuApiFixture();
  await assert.rejects(
    fixture.patch("base-a:table-a", "in_progress", {
      revision: 1,
      zhName: "<b>处理中</b>",
    }),
    (error) => error.code === "INVALID_FIELD",
  );
  await assert.rejects(
    fixture.patch("base-a:table-a", "in_progress", {
      revision: 1,
      zhDescription: "x".repeat(121),
    }),
    (error) => error.code === "INVALID_FIELD",
  );
});

test("stage settings are subject-scoped and expose reset", async () => {
  const source = await readFile(
    new URL("../web/src/components/UnifiedWorkflowStageSettings.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /subjectKey/);
  assert.match(source, /zhDescription/);
  assert.match(source, /重置|Reset/);
  assert.match(source, /aria-label/);
});
~~~

Copy the `fixture()`/`request()` helper shape from `test/feishu-workflow-api.test.mjs` into the new test (the helper is intentionally local and must clean up its temporary directory). Add a `createFeishuApiFixture()` wrapper that creates two preview subjects and exposes `patch(subjectKey, stageId, body)` and `get(subjectKey)`; `patch` must issue the real PATCH route and throw an error object carrying the server `code`. Add a second-subject read after saving one override and assert all four text fields remain `null` for the untouched subject.

- [ ] Step 2: Run the tests and verify the missing implementation

Run node --test test/unified-stage-display-settings.test.mjs. Expected: failures because the table, routes, and settings component are absent.

- [ ] Step 3: Implement display override persistence

Add feishu_unified_stage_display_overrides with primary key (subject_key, stage_id), text columns, row revision, and updated_at. Implement getStageDisplayOverrides(subjectKey) and saveStageDisplayOverride(subjectKey, stageId, expectedRevision, patch). A reset is represented by all four text columns being NULL. Validate plain text at the database/API boundary and return SUBJECT_REMOVED for removed subjects.

- [ ] Step 4: Add API helpers and the settings component

The component receives subjectKey, overrides, onChange, and onError. Render one compact editable row per stable stage with read-only stageId, Chinese/English name and description inputs, Save and Reset icon buttons, revision conflict reload, and aria-label/aria-describedby. It must enumerate only the selected subject's stage registry. Do not reuse BoardStageSettings, which remains the global ordinary-project label editor.

- [ ] Step 5: Run and commit

~~~powershell
node --test test/unified-stage-display-settings.test.mjs test/feishu-workflow-api.test.mjs test/feishu-workflow-ui.test.mjs
npm run typecheck
git add server/database.mjs server/feishu-workflow-api.mjs web/src/components/UnifiedWorkflowStageSettings.tsx web/src/types.ts web/src/api.ts test/unified-stage-display-settings.test.mjs test/feishu-workflow-ui.test.mjs
git commit -m "feat: customize subject workflow stage display"
~~~

Expected: all display validation, isolation, accessibility, and type checks pass.

### Task 5: Integrate view controls and project-scoped loading into App

Files:

- Create: web/src/components/UnifiedWorkflowViewControls.tsx
- Modify: web/src/App.tsx (state, toolbar, project switcher, Feishu configuration)
- Modify: web/src/components/FeishuBaseNavigator.tsx and web/src/styles.css
- Modify: web/src/types.ts
- Create: test/unified-workflow-view-controls.test.mjs
- Modify: test/board-views.test.mjs and test/project-home.test.mjs

Interfaces:

- Consumes: view/display API helpers, isSelectedFeishuProject, selectedFeishuSubjectKey, and Project.archivedAt.
- Produces: blank-first view management, active/default view persistence, active/history project sections, and a Feishu-specific node-mode boundary.

- [ ] Step 1: Write failing source-contract tests

~~~js
test("view controls support blank creation, copy, reorder, default, and protected system view", async () => {
  const source = await readFile(
    new URL("../web/src/components/UnifiedWorkflowViewControls.tsx", import.meta.url),
    "utf8",
  );
  for (const token of ["新建视图", "复制视图", "设为默认", "删除视图", "全部流程", "stageIds", "stateRevision"]) {
    assert.match(source, new RegExp(token));
  }
  assert.match(source, /isSystem/);
  assert.match(source, /至少选择一个流程|at least one stage/);
});

test("Feishu subjects hide node mode while ordinary projects keep it", async () => {
  const app = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /SHOW_WORKFLOW_BOARD_ENTRY && !isSelectedFeishuProject/);
  assert.match(app, /boardView === "workflow" && !isSelectedFeishuProject/);
  assert.match(app, /includeArchived/);
});
~~~

- [ ] Step 2: Run the tests and verify the missing controls

Run node --test test/unified-workflow-view-controls.test.mjs test/board-views.test.mjs. Expected: failures for the new component, active/history project data, and the Feishu node-mode guard.

- [ ] Step 3: Implement blank-first controls

UnifiedWorkflowViewControls must show the current view selector and New view button, start a custom draft with stageIds: [], require explicit selection of at least one stage, and support copy, rename, reorder with up/down buttons, set-default, edit, and delete. Disable all mutation controls for isSystem and retain all / 全部流程 as the fallback. Enforce unique names per subjectKey and surface a reload action for VERSION_CONFLICT. Persist activeViewId with stateRevision; do not create a Taskboard project. Do not add business presets.

- [ ] Step 4: Load views only for the selected subject

In App.tsx add unifiedViewsState, unifiedStageDisplays, unifiedViewsLoading/error, unifiedSearchScope, manager/settings state, and independent request-generation/AbortController refs. Fetch views and display overrides only when boardView is issues and selectedFeishuSubject exists. Apply a response only when its generation and subjectKey still match. Clear view/layout/drag/detail state when switching project or subject.

Call listProjects({ includeArchived: true }) for the switcher. Render active projects first and an initially collapsed 已归档/历史项目 section with Restore and protected Delete actions. Archive/delete success must clear project-scoped caches before choosing the next active project.

- [ ] Step 5: Hide node mode only at the Feishu boundary

Keep legacy BoardView values so old local storage can be read, but normalize completed_editing, upload_queue, uploading, and uploaded to issues. Render WorkflowBoard only for ordinary projects. For a Feishu subject, show UnifiedWorkflowViewControls and the unified board, never the 节点模式 button. Ordinary projects retain their existing node-mode workspace.

- [ ] Step 6: Run and commit

~~~powershell
node --test test/unified-workflow-view-controls.test.mjs test/board-views.test.mjs test/project-home.test.mjs
npm run typecheck
git add web/src/components/UnifiedWorkflowViewControls.tsx web/src/App.tsx web/src/components/FeishuBaseNavigator.tsx web/src/styles.css web/src/types.ts test/unified-workflow-view-controls.test.mjs test/board-views.test.mjs test/project-home.test.mjs
git commit -m "feat: add subject workflow view controls"
~~~

Expected: controls, project sections, node-mode boundaries, and types pass.

### Task 6: Project views into the board, expose hidden counts, and fold ZIP details

Files:

- Modify: web/src/unifiedWorkflow.mjs
- Modify: web/src/components/UnifiedWorkflowBoard.tsx, web/src/components/TaskCard.tsx, web/src/App.tsx, and web/src/styles.css
- Create: test/unified-workflow-projection.test.mjs
- Modify: test/unified-workflow-board-ui.test.mjs and test/task-artifact-summaries.test.mjs

Interfaces:

- Consumes: UnifiedWorkflowViewsState, stage display overrides, filtered current-subject tasks, upload rows, and verified artifact summaries.
- Produces: ordered view projection, hidden task/ZIP/failure summaries, current/all-stage search scope, accessible ZIP disclosure, and stable artifact identity.

- [ ] Step 1: Write failing projection tests

~~~js
test("hidden summaries are computed after task filters and before view projection", () => {
  const groups = groupsFor([
    item("in_progress", "task-visible"),
    item("uploading", "task-hidden"),
    item("upload_queue", "task-hidden-2", { failed: true }),
  ]);
  assert.deepEqual(summarizeHiddenUnifiedWorkflow(groups, ["in_progress"]), {
    taskCount: 2,
    zipCount: 2,
    failedUploadCount: 1,
    status: "ready",
  });
});

test("artifact identity uses the fixed fallback order", () => {
  assert.equal(artifactIdentity({
    artifactId: "a", id: "u", filename: "one.zip", createdAt: "2026-01-01",
  }), "artifact:a");
  assert.equal(artifactIdentity({
    id: "u", filename: "one.zip", createdAt: "2026-01-01",
  }), "upload:u");
  assert.equal(artifactIdentity({
    filename: "one.zip", createdAt: "2026-01-01",
  }), "file:one.zip:2026-01-01");
});

test("unverified artifacts never contribute to upload counts", () => {
  const grouped = groupUnifiedWorkflowItems(tasks, uploads, [
    { id: "bad", taskId: "task-1", filename: "bad.zip", validationStatus: "invalid" },
  ]);
  assert.equal(summarizeUnifiedWorkflowArtifacts(grouped.completed_editing[0]).zipCount, 0);
});
~~~

The projection test must import `groupUnifiedWorkflowItems` and the new helpers from `../web/src/unifiedWorkflow.mjs`. Define local helpers in the test (`feishuTask(id, status='todo')`, `item(stage, id, { failed=false } = {})`, and `groupsFor(items)`) that construct the existing `feishuOrigin.source='feishu-base'` shape and verified artifact/upload rows; do not rely on globals or production paths. Add a second subject fixture and assert projection never returns items from it.

- [ ] Step 2: Run tests and verify the gap

Run node --test test/unified-workflow-projection.test.mjs test/unified-workflow-board-ui.test.mjs. Expected: failures for hidden summaries, fallback identities, view projection, and disclosure controls.

- [ ] Step 3: Add pure projection helpers

Export from web/src/unifiedWorkflow.mjs:

~~~js
export function projectUnifiedWorkflowGroups(groups, stageIds) {}
export function summarizeHiddenUnifiedWorkflow(groups, visibleStageIds, searchState = null) {}
export function artifactIdentity(record) {}
export function filterVerifiedUnifiedArtifacts(artifacts) {}
~~~

projectUnifiedWorkflowGroups preserves the caller's stageIds order. Hidden summaries count tasks and deduplicated verified ZIP identities separately; loading or failed data uses status: syncing instead of silently reporting zero. artifactIdentity follows artifactId -> upload id -> normalized filename plus creation time.

- [ ] Step 4: Make UnifiedWorkflowBoard consume the active view

Replace the hard-coded column map with view.stageIds. Merge each stage's display override with built-in name/description and render selected empty columns as well as populated columns. Header badges show task count and ZIP count separately. Compute scope -> classify -> ordinary filters -> hidden counts -> projection in that order.

Add a hidden summary banner. Search defaults to the current view; an explicit searchScope of allStages searches hidden metadata. A hidden match is listed in the banner, opens its detail, and can reveal its stage once without changing the saved view. Do not let search mutate the saved layout.

- [ ] Step 5: Fold ZIP details without changing upload qualification

Refactor UploadSummary to a compact disclosure. Use aria-expanded and aria-controls. Expand automatically for uploading, failed, or retryable rows; preserve user expansion under projectId + viewId + taskId + artifactIdentity. Search task identifier/title, package alias, verified ZIP filename, and upload filename. Clearing search restores the prior fold state. Never render paths, hashes, storage keys, prompts, or commands.

Keep upload columns read-only and route retry through retryTaskArtifactUpload. Retain unqueued verified artifacts; exclude unverified artifacts from counts and upload columns while preserving their safe detail error.

- [ ] Step 6: Run and commit

~~~powershell
node --test test/unified-workflow-projection.test.mjs test/unified-workflow.test.mjs test/unified-workflow-board-ui.test.mjs test/task-artifact-summaries.test.mjs
npm run typecheck
git add web/src/unifiedWorkflow.mjs web/src/components/UnifiedWorkflowBoard.tsx web/src/components/TaskCard.tsx web/src/App.tsx web/src/styles.css test/unified-workflow-projection.test.mjs test/unified-workflow-board-ui.test.mjs test/task-artifact-summaries.test.mjs
git commit -m "feat: project configurable workflow views and ZIP summaries"
~~~

Expected: projection, search, ZIP identity, disclosure accessibility, and existing upload tests pass.

### Task 7: Add synchronized column layout, responsive sizing, and pointer-pan scrolling

Files:

- Create: web/src/unifiedWorkflowLayout.mjs
- Modify: web/src/components/UnifiedWorkflowBoard.tsx, web/src/styles.css, and web/src/App.tsx
- Create: test/unified-workflow-layout.test.mjs
- Modify: test/unified-workflow-css-regressions.test.mjs and test/unified-workflow-board-ui.test.mjs

Interfaces:

- Consumes: the browser-only layout key and active projectId/viewId.
- Produces: narrow/standard/wide synchronized column widths, compact/comfortable card density, independent column scroll positions, and pointer-based blank-area pan.

- [ ] Step 1: Write failing layout tests

~~~js
test("layout normalization clamps invalid dimensions", () => {
  assert.deepEqual(normalizeUnifiedWorkflowLayout({
    columnWidthPreset: "invalid",
    boardScrollLeft: -10,
    columnScrollTop: { in_progress: -4 },
  }, ["in_progress"]), {
    columnWidthPreset: "standard",
    cardDensity: "comfortable",
    boardScrollLeft: 0,
    columnScrollTop: { in_progress: 0 },
    zipExpansion: {},
  });
});

test("layout keys isolate projects and views", () => {
  assert.notEqual(
    unifiedWorkflowLayoutStorageKey("project-a", "view-a"),
    unifiedWorkflowLayoutStorageKey("project-a", "view-b"),
  );
});
~~~

Extend `test/unified-workflow-board-ui.test.mjs` with source-contract assertions for `pointerdown`, `pointermove`, `pointerup`, `pointercancel`, `setPointerCapture`, the 6px threshold, blank-area target filtering, and separate board/column scroll refs. The test must assert that column handlers do not call the task-move callback and that upload-column cards remain non-draggable.

- [ ] Step 2: Run tests and verify the gap

Run node --test test/unified-workflow-layout.test.mjs test/unified-workflow-css-regressions.test.mjs. Expected: failures for the layout module and missing board selectors.

- [ ] Step 3: Implement pure layout helpers

Export from `web/src/unifiedWorkflowLayout.mjs`:

~~~js
export function unifiedWorkflowLayoutStorageKey(projectId, viewId) {}
export function readUnifiedWorkflowLayout(projectId, viewId) {}
export function writeUnifiedWorkflowLayout(projectId, viewId, value) {}
export function resetUnifiedWorkflowLayout(projectId, viewId) {}
export function normalizeUnifiedWorkflowLayout(value, allowedStageIds = UNIFIED_WORKFLOW_STAGES) {}
export function columnWidthPx(preset) {}
~~~

Import `UNIFIED_WORKFLOW_STAGES` from `shared/unified-workflow-stages.mjs`. Use JSDoc for the `UnifiedColumnWidthPreset`, `UnifiedCardDensity`, and `UnifiedWorkflowLayoutState` shapes, with 280/340/420px presets; clamp scroll positions to finite non-negative numbers, keep `columnScrollTop` keys only for the active view's stage IDs, and retain `zipExpansion` only for valid scoped task/artifact identities. `resetUnifiedWorkflowLayout` removes the scoped key and returns defaults. The key and value contain no path, command, prompt, or secret. Import this ESM helper from the React component so `node --test` can execute the same pure functions without a TypeScript runtime.

- [ ] Step 4: Add stable CSS geometry

At the end of web/src/styles.css add unified selectors for the horizontal scroll container, dynamic stage grid, column, column list, stage description, density modifiers, hidden summary, and ZIP disclosure. Use min-width: 0, min-height: 0, one horizontal overflow owner, a CSS column-width variable, and independent overflow-y: auto lists. Loading, empty, and error content use the same column track. Replace any unified-board repeat(8) or repeat(9) rule with a --unified-stage-count-driven grid. Keep the existing OtherTasksPanel width and overlay behavior unchanged.

At narrow widths retain horizontal scrolling and scroll-snap-type: x mandatory without viewport-scaled font sizes.

- [ ] Step 5: Implement pointer pan and cancellation

On the board scroll container, start horizontal pan only for a left-button pointerdown on blank board space. Reject targets matching button, a, input, select, textarea, or draggable=true. Apply a 6px movement threshold before setPointerCapture and preventDefault; use grab/grabbing cursors and update scrollLeft from pointer deltas. On each column list, support the same thresholded pointer gesture for vertical blank-area scrolling while allowing dragover/drop events to bubble for valid task drags. Clear both pan states on pointerup, pointercancel, Escape, project/view change, and unmount. Add bounded edge auto-scroll only while a valid task drag is active.

Persist boardScrollLeft and each column scrollTop on a throttled scroll callback; restore only after matching projectId and viewId refs exist. Persist ZIP expansion through the same layout scope.

- [ ] Step 6: Run and commit

~~~powershell
node --test test/unified-workflow-layout.test.mjs test/unified-workflow-css-regressions.test.mjs test/unified-workflow-board-ui.test.mjs
npm run typecheck
git add web/src/unifiedWorkflowLayout.mjs web/src/components/UnifiedWorkflowBoard.tsx web/src/styles.css web/src/App.tsx test/unified-workflow-layout.test.mjs test/unified-workflow-css-regressions.test.mjs test/unified-workflow-board-ui.test.mjs
git commit -m "feat: add persistent responsive workflow board layout"
~~~

Expected: layout helpers, CSS contracts, pointer cleanup source assertions, and type checks pass.

### Task 8: Enforce unified-board drop boundaries and preserve the Other Tasks panel

Files:

- Create: web/src/unifiedWorkflowDropGuard.mjs
- Modify: web/src/components/UnifiedWorkflowBoard.tsx, web/src/components/OtherTasksPanel.tsx, and web/src/App.tsx
- Create: test/unified-workflow-drop-guard.test.mjs
- Modify: test/task-move-ui.test.mjs and test/other-tasks-panel.test.mjs

Interfaces:

- Consumes: current subject identity, active view stageIds, task provenance, target stage, and source surface.
- Produces: canDropUnifiedWorkflowTask(input), used before every board move.

The generic `finishTaskDrop` callback remains valid for ordinary Taskboard boards. Add a `sourceSurface` argument (or wrap the callback only for `UnifiedWorkflowBoard`) so the unified guard runs only for unified-board drops; ordinary project and OtherTasksPanel moves keep their existing behavior.

- [ ] Step 1: Write failing guard tests

~~~js
test("only current-subject real tasks can move to visible real stages", () => {
  const base = {
    projectId: "p",
    subjectKey: "b:t",
    visibleStageIds: ["todo", "in_progress"],
    source: "unified-board",
  };
  assert.equal(canDropUnifiedWorkflowTask({
    ...base,
    task: feishuTask("p", "b:t"),
    targetStage: "in_progress",
  }), true);
  assert.equal(canDropUnifiedWorkflowTask({
    ...base,
    task: feishuTask("p", "other:t"),
    targetStage: "in_progress",
  }), false);
  assert.equal(canDropUnifiedWorkflowTask({
    ...base,
    task: ordinaryTask("p"),
    targetStage: "in_progress",
  }), false);
  assert.equal(canDropUnifiedWorkflowTask({
    ...base,
    task: feishuTask("p", "b:t"),
    targetStage: "uploaded",
  }), false);
  assert.equal(canDropUnifiedWorkflowTask({
    ...base,
    task: feishuTask("p", "b:t"),
    targetStage: "todo",
    source: "other-tasks-panel",
  }), false);
});
~~~

Define `feishuTask(projectId, subjectKey)` with `feishuOrigin.source='feishu-base'`, `feishuOrigin.subjectKey`, a non-archived `status`, and the supplied project id; define `ordinaryTask(projectId)` with no Feishu origin. Import the shared real-stage set in the test so the predicate is checked against the same registry used by the server and board.

- [ ] Step 2: Run tests and verify the missing guard

Run node --test test/unified-workflow-drop-guard.test.mjs test/task-move-ui.test.mjs. Expected: failure because the predicate is absent and the generic callback accepts a broad source.

- [ ] Step 3: Implement and apply the guard

Export `canDropUnifiedWorkflowTask(input)`, where `input` has `{ projectId, subjectKey, visibleStageIds, task, targetStage, sourceSurface }`. It requires `sourceSurface === "unified-board"`, matching `projectId`, Feishu provenance with the selected `subjectKey`, a task status in the shared `REAL_UNIFIED_WORKFLOW_STAGES` set, a target in the active view's visible real stage IDs, and a non-upload target. Archived/canceled tasks are rejected. Call it in `UnifiedWorkflowBoard` before `onDrop`; in `App.finishTaskDrop`, pass the source surface and run the guard only when that surface is `unified-board`. View changes, hidden-stage changes, project changes, pointer cancellation, and unmount clear active drag state.

- [ ] Step 4: Preserve the right panel contract

Keep OtherTasksPanel mounted/closed with its existing tabs and width; do not turn it into workflow columns. When detail opens, remember otherTasksOpen and otherTasksTab and restore them on close or Escape. Add data-source attributes so tests prove a panel card cannot become a unified-board source.

- [ ] Step 5: Run and commit

~~~powershell
node --test test/unified-workflow-drop-guard.test.mjs test/task-move-ui.test.mjs test/other-tasks-panel.test.mjs
npm run typecheck
git add web/src/unifiedWorkflowDropGuard.mjs web/src/components/UnifiedWorkflowBoard.tsx web/src/components/OtherTasksPanel.tsx web/src/App.tsx test/unified-workflow-drop-guard.test.mjs test/task-move-ui.test.mjs test/other-tasks-panel.test.mjs
git commit -m "fix: constrain unified workflow board drops"
~~~

Expected: valid in-view task moves still work, upload/hidden/cross-panel moves are rejected, and panel state survives detail navigation.

### Task 9: Complete documentation, browser acceptance, and full regression

Files:

- Modify: README.zh-CN.md and README.md
- Modify: test/board-views.test.mjs and test/project-home.test.mjs
- Create: test/unified-workflow-browser-contract.test.mjs

Interfaces:

- Consumes: all local/cloud APIs and UI behavior from Tasks 1-8.
- Produces: user-facing operation steps and reproducible acceptance evidence.

- [ ] Step 1: Add a documentation contract test

~~~js
test("README explains blank-first views and protected history", async () => {
  const readme = await readFile(new URL("../README.zh-CN.md", import.meta.url), "utf8");
  assert.match(readme, /全部流程/);
  assert.match(readme, /新建视图/);
  assert.match(readme, /已归档|恢复/);
  assert.match(readme, /上传列.*只读|只读.*上传列/);
});
~~~

- [ ] Step 2: Document the actual workflow

Add Chinese and English sections explaining that a selected Base subject is the board scope; first entry creates only 全部流程; users create/save views and filters; stage display text is subject-specific and does not alter execution; hidden stages remain counted and can be searched with the explicit all-stage option; ZIP details are folded; upload columns are read-only; ordinary projects retain node mode while Feishu subjects do not; project archive is reversible and permanent deletion is for empty manually-created projects only; Feishu removal does not delete remote content. Do not document credentials, local secrets, NAS behavior, or automatic ZIP discovery that is not implemented.

- [ ] Step 3: Start services and perform browser acceptance

From the active checkout root (resolve it with `git rev-parse --show-toplevel`; do not hard-code a developer-specific path) run:

~~~powershell
.\scripts\stop-local.ps1
.\scripts\start-local.ps1
.\scripts\check-local.ps1
~~~

In the in-app browser at the reported Taskboard URL, check desktop and narrow widths:

1. Use the deterministic local Feishu preview fixture or a test Bridge response (never production data), add/select two independent subjects, and confirm names/cards do not cross.
2. Confirm Feishu pages have no node-mode button while an ordinary project still has it.
3. Confirm first entry shows only 全部流程; create a blank view, select 处理中 and 已完成剪辑, save, switch away, and return.
4. Rename a stage description, switch subjects, and confirm the other subject keeps its own text.
5. Hide a stage containing a failed upload; confirm hidden task/ZIP/failure counts and all-stage search.
6. Expand/collapse ZIP details with keyboard and confirm failed rows auto-expand.
7. Change width/density, pan blank board space, scroll a column, switch views, and confirm independent restoration.
8. Drag a real task between visible real stages; confirm upload columns and OtherTasksPanel cards reject drops.
9. Archive/restore an empty ordinary project and verify a non-empty project reports PROJECT_NOT_EMPTY.

Record only observable status, counts, and safe error codes; do not place paths or secrets in screenshots or logs.

- [ ] Step 4: Run all automated verification

~~~powershell
node --test test/project-lifecycle.test.mjs test/feishu-project-lifecycle.test.mjs test/unified-workflow-views.test.mjs test/unified-stage-display-settings.test.mjs test/unified-workflow-projection.test.mjs test/unified-workflow-layout.test.mjs test/unified-workflow-drop-guard.test.mjs
npm run typecheck
npm run build:web
git diff --check
npm test
~~~

Expected: every command exits 0; browser acceptance shows no cross-subject cards, no unintended Auto-Cut start, no upload state mutation by drag, and no right-panel regression.

- [ ] Step 5: Commit documentation and acceptance contracts

~~~powershell
git add README.md README.zh-CN.md test/board-views.test.mjs test/project-home.test.mjs test/unified-workflow-browser-contract.test.mjs
git commit -m "docs: describe configurable unified workflow boards"
~~~

## Final Review Checklist

- [ ] Every API mutation has subject/project scope and optimistic revision checks.
- [ ] Only all is auto-created; no business preset view is inserted.
- [ ] Ordinary project node mode remains unchanged; Feishu node mode is hidden.
- [ ] Hidden task/ZIP/failure counts are computed after ordinary filters and before view projection.
- [ ] ZIP summaries count only verified artifacts and use the fixed identity fallback order.
- [ ] Layout keys include both project and view IDs and contain no sensitive values.
- [ ] Unified-board drop guard rejects upload stages, hidden targets, ordinary tasks, archived tasks, and right-panel sources.
- [ ] Project deletion protection checks archived tasks and every existing association.
- [ ] Feishu removal archives local projects without deleting remote resources and re-add restores them.
- [ ] npm test, npm run typecheck, npm run build:web, and git diff --check pass before completion.
