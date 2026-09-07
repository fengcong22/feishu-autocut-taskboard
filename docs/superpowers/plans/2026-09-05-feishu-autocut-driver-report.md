# Feishu Auto-Cut Driver Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a trusted Feishu Auto-Cut Codex run report one exact accepted ZIP, bind it to its task and run, and complete or enqueue it according to the snapshotted workflow policy without scanning a directory.

**Architecture:** A server-claimed run receives a private report URL and short-lived claim token. `taskctl artifact report --file PATH` hashes only that file and posts `{ path, sha256 }`; Taskboard verifies the active task/run claim, immutable Feishu origin, creation-time subject policy, source-root containment, hash, and ZIP structure before recording the artifact. Run reconciliation, not the report request, performs final status transition and exact-artifact enqueue.

**Tech Stack:** Node.js ESM, built-in HTTP/filesystem/crypto/SQLite APIs, React/TypeScript, and Node's built-in test runner.

## Global Constraints

- Never enumerate `artifactSourcePath`, compare modification times, or infer ownership from a filename.
- Only a server-registered Feishu task whose creation-time subject version uses `driver_report` receives report capability.
- Match task, thread, run, and token before opening the file and again before committing its artifact row.
- Resolve a regular `.zip` beneath the snapshotted `artifactSourcePath` and reuse the existing independent ZIP/SHA-256 validation.
- A report leaves the task `in_progress`; the matching run must complete successfully before automatic becomes `done` or manual becomes `in_review`.
- `enqueueMode = automatic` enqueues the exact run artifact only after automatic completion.
- Preserve `manual_select`; keep `watch_directory` unavailable.
- Never expose Bridge/launcher credentials or the report token in the prompt or public output.

---

### Task 1: Persist One Artifact Per Run

**Files:**
- Modify: `server/database.mjs:642-663,954-971,1222-1247,5189-5315,5363-5393`
- Modify: `web/src/types.ts:721-734`
- Create: `test/task-artifact-migration.test.mjs`

**Interfaces:**
- Public artifact: `runId: string | null`.
- `getTaskArtifactForRun(taskId, runId)` returns one artifact or `null`.
- `getTaskAiStartForArtifactReport(taskId, runId)` returns the active ownership chain including `claimToken` and `threadId`, or `null`.
- `createTaskArtifact(taskId, input)` accepts `runId` plus `requiredRunClaim: { runId, claimToken }`; existing callers omit both.
- Subject upload-target readers additionally return `artifactSourceMode` and `artifactSourcePath`.

- [ ] **Step 1: Write the failing migration and persistence tests**

Create a current database with a manual artifact and an upload that references it, close it, replace `task_artifacts` with the legacy schema, reopen it, then assert:

```js
assert.deepEqual(database.listTaskArtifacts(task.id).map(({ sourceMode, runId }) => ({ sourceMode, runId })), [
  { sourceMode: "manual_select", runId: null },
]);
assert.equal(database.database.prepare("PRAGMA foreign_key_check").get(), undefined);
assert.match(database.database.prepare(
  "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'task_artifacts'",
).get().sql, /driver_report/);
assert.ok(database.database.prepare("PRAGMA table_info(task_artifacts)").all().some(({ name }) => name === "run_id"));
assert.ok(database.database.prepare(
  "SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'task_artifacts_run'",
).get());
```

Create an active trusted task/thread/run claim and assert a `driver_report` insert exposes that `runId`, an identical report returns the same artifact, and different content for the same run throws `ARTIFACT_RUN_CONFLICT`.

- [ ] **Step 2: Run the test and verify RED**

```powershell
node --test test/task-artifact-migration.test.mjs
```

Expected: FAIL because the table lacks `run_id`, rejects `driver_report`, and has no run lookup methods.

- [ ] **Step 3: Implement the migration and database contract**

Use this canonical shape:

```sql
run_id TEXT,
source_mode TEXT NOT NULL CHECK (source_mode IN ('manual_select', 'driver_report')),
CHECK (
  (source_mode = 'manual_select' AND run_id IS NULL)
  OR (source_mode = 'driver_report' AND run_id IS NOT NULL)
)
```

Create `task_artifacts_run` as a unique partial index on non-null `run_id`. Do not add an `ai_chat_runs` foreign key because deleting a conversation must not erase historical artifact ownership.

Add `#migrateTaskArtifacts()` using the existing `#migrateTaskStatuses()` pattern: inspect schema, disable foreign keys, begin an immediate transaction, create a shadow table, copy legacy rows with null run IDs, replace the table, recreate indexes, commit or roll back, restore foreign keys, and reject any `PRAGMA foreign_key_check` violation.

Map `runId: row.run_id ?? null`. For `driver_report`, deduplicate by `task_id + run_id` and require identical filename/hash; for manual rows preserve `task_id + filename + sha256` with `run_id IS NULL`. Recheck `requiredRunClaim` inside the insert transaction by joining `task_ai_starts`, `tasks`, `ai_chat_runs`, and `ai_chat_threads` while the run is still `running`.

Return from the snapshotted upload policy:

```js
artifactSourceMode: upload?.artifactSourceMode ?? "manual_select",
artifactSourcePath: typeof upload?.artifactSourcePath === "string" && upload.artifactSourcePath.trim()
  ? upload.artifactSourcePath.trim()
  : null,
```

- [ ] **Step 4: Verify GREEN and existing database consumers**

```powershell
node --test test/task-artifact-migration.test.mjs test/task-artifact-summaries.test.mjs test/artifact-upload-lease.test.mjs
```

Expected: all tests pass and the legacy upload reference survives.

- [ ] **Step 5: Commit**

```powershell
git add server/database.mjs web/src/types.ts test/task-artifact-migration.test.mjs
git commit -m "feat: bind Auto-Cut artifacts to runs"
```

---

### Task 2: Add `taskctl artifact report`

**Files:**
- Modify: `cli/taskctl.mjs:1-140,305-477,479-534`
- Modify: `test/cli.test.mjs`

**Interfaces:**
- Consumes `CODEX_AUTOCUT_ARTIFACT_REPORT_URL` and `CODEX_AUTOCUT_ARTIFACT_REPORT_TOKEN`.
- Produces `taskctl artifact report --file PATH`.
- Sends `POST <exact injected URL>` with Bearer token, `x-taskboard-client: taskctl`, and `{ path, sha256 }`.

- [ ] **Step 1: Write failing exact-file CLI tests**

Use a temporary `.zip` file and a fetch spy:

```js
const result = await run(["artifact", "report", "--file", filename], async (url, init) => {
  call = { url: url.toString(), init };
  return response({ artifact: { id: "artifact-1" } }, 201);
}, {
  env: {
    CODEX_AUTOCUT_ARTIFACT_REPORT_URL: "http://127.0.0.1:49123/api/local/tasks/task-1/runs/run-1/artifact-report",
    CODEX_AUTOCUT_ARTIFACT_REPORT_TOKEN: "claim-token",
  },
});
assert.equal(result.exitCode, 0);
assert.equal(call.url, "http://127.0.0.1:49123/api/local/tasks/task-1/runs/run-1/artifact-report");
assert.equal(call.init.headers.authorization, "Bearer claim-token");
assert.deepEqual(JSON.parse(call.init.body), {
  path: path.resolve(filename),
  sha256: createHash("sha256").update(bytes).digest("hex"),
});
```

Also assert missing URL/token, a non-`.zip` path, and a directory all fail before fetch.

- [ ] **Step 2: Run the tests and verify RED**

```powershell
node --test --test-name-pattern="artifact report" test/cli.test.mjs
```

Expected: FAIL with unsupported command `artifact report`.

- [ ] **Step 3: Implement exact-file hashing and reporting**

Dispatch this command before general runtime discovery. Validate the injected URL is loopback HTTP so the capability cannot be sent remotely. Resolve only the supplied file, require a regular `.zip`, and hash it with a stream:

```js
async function sha256File(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}
```

POST the exact JSON body with `redirect: "error"`, normalize the response with the existing JSON error contract, and never call `readdir`, a glob, or the launcher runtime resolver.

- [ ] **Step 4: Verify GREEN**

```powershell
node --test test/cli.test.mjs
```

Expected: all CLI tests pass.

- [ ] **Step 5: Commit**

```powershell
git add cli/taskctl.mjs test/cli.test.mjs
git commit -m "feat: report exact Auto-Cut artifacts"
```

---

### Task 3: Inject Capability Into Trusted Driver Runs

**Files:**
- Modify: `server/ai-chat.mjs:436-580`
- Modify: `server/ai-chat-process.mjs:229-282`
- Modify: `server/app.mjs:3196-3264`
- Modify: `test/task-start-flow.test.mjs`

**Interfaces:**
- `onRunCreated(run)` may return `{ artifactReport: { url, token } }` after binding the run.
- `buildCodexPrompt(..., { artifactReportEnabled })` adds only a fixed private command instruction.
- The spawned process receives the two `CODEX_AUTOCUT_ARTIFACT_REPORT_*` values only for that run.

- [ ] **Step 1: Write failing trusted-context tests**

Extend the fake Codex executable to capture only the two report variables. Create and enable a real `driver_report` subject version, register its trusted task, start it, then assert:

```js
assert.equal(context.url,
  `${baseUrl}/api/local/tasks/${encodeURIComponent(task.id)}/runs/${encodeURIComponent(run.id)}/artifact-report`);
assert.ok(context.token.length >= 32);
assert.match(prompt, /taskctl artifact report --file/);
assert.equal(prompt.includes(context.token), false);
```

For an otherwise trusted `manual_select` task, assert the variables are absent and the prompt has no report command.

- [ ] **Step 2: Run the tests and verify RED**

```powershell
node --test --test-name-pattern="driver-report capability|manual-select.*capability" test/task-start-flow.test.mjs
```

Expected: FAIL because no report capability is injected.

- [ ] **Step 3: Implement run-context return, prompt, and environment**

Move prompt construction until after `createAiChatRun` and the `onRunCreated` callback. Capture that callback's return value; if it contains `artifactReport` without `taskClaimedByServer`, delete the run and reject it. Build the prompt with `artifactReportEnabled: Boolean(runContext?.artifactReport)` only, and spawn with:

```js
env: runContext?.artifactReport
  ? {
      ...this.processEnv,
      CODEX_AUTOCUT_ARTIFACT_REPORT_URL: runContext.artifactReport.url,
      CODEX_AUTOCUT_ARTIFACT_REPORT_TOKEN: runContext.artifactReport.token,
    }
  : this.processEnv,
```

The fixed private prompt says to run `taskctl artifact report --file <absolute path to that exact ZIP>` once after Auto-Cut validation, and explicitly forbids listing a directory or choosing a newest ZIP. It contains no URL, token, task ID, or run ID.

At `startClaimedTaskWithAi`, read the creation-time subject policy. Bind the run first, then return context only when its mode is `driver_report`:

```js
return {
  artifactReport: {
    url: localArtifactReportUrl(claimedTask.id, createdRun.id),
    token: claimedTask.claimToken,
  },
};
```

Build the URL from the currently listening server port and `127.0.0.1`.

- [ ] **Step 4: Verify GREEN and credential stripping**

```powershell
node --test test/task-start-flow.test.mjs test/ai-chat-runner.test.mjs
```

Expected: all tests pass; only the trusted driver run gets report context and existing launcher/Bridge secrets remain stripped.

- [ ] **Step 5: Commit**

```powershell
git add server/ai-chat.mjs server/ai-chat-process.mjs server/app.mjs test/task-start-flow.test.mjs
git commit -m "feat: inject Auto-Cut report capabilities"
```

---

### Task 4: Verify Reports And Reconcile The Exact Artifact

**Files:**
- Modify: `server/app.mjs:457-566,2894-3074,4776-4839`
- Modify: `test/artifact-upload-queue.test.mjs`

**Interfaces:**
- Adds `POST /api/local/tasks/:taskId/runs/:runId/artifact-report` with `{ path, sha256 }`.
- Reuses `artifactService.acceptUpload({ filename, contentType, stream })` and `removeStoredArtifact(storageKey)`.
- Produces a verified `driver_report` row while active, then final status and optional exact-artifact enqueue at run completion.

- [ ] **Step 1: Write the failing automatic success-path test**

Configure an enabled automatic subject with `driver_report`, an actual source directory, and automatic enqueue. Register through the authenticated Feishu route, start a delayed fake Codex run, write a valid Jianying ZIP under the source root, and post:

```js
const report = await request(baseUrl, reportPath, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "x-taskboard-client": "taskctl" },
  json: { path: zipPath, sha256: createHash("sha256").update(zip).digest("hex") },
});
assert.equal(report.response.status, 201);
assert.equal(report.body.artifact.runId, run.id);
assert.equal(report.body.artifact.sourceMode, "driver_report");
assert.equal(report.body.task.status, "in_progress");
```

Allow that run to complete. Assert task `done`, one upload for exactly this artifact ID, and copied bytes with the same hash.

- [ ] **Step 2: Run the success test and verify RED**

```powershell
node --test --test-name-pattern="driver report completes.*automatic" test/artifact-upload-queue.test.mjs
```

Expected: FAIL with 404 for the missing endpoint.

- [ ] **Step 3: Write failing rejection and manual-semantics tests**

Assert no artifact/status/queue mutation for a copied Feishu marker on an ordinary task, a trusted `manual_select` task, task A paired with task B's real run/token, a wrong token, a wrong hash, and a path outside the snapshotted source root. Also assert the existing binary artifact POST rejects a task whose creation-time source mode is `driver_report`, so it cannot create an unbound fallback artifact. Add a manual-execution `driver_report` case that becomes `in_review` only after run completion and is not auto-enqueued before acceptance.

- [ ] **Step 4: Run rejection tests and verify RED**

```powershell
node --test --test-name-pattern="driver report" test/artifact-upload-queue.test.mjs
```

Expected: new tests fail because trust, path, hash, and reconciliation checks are absent.

- [ ] **Step 5: Implement the endpoint and ingestion**

Before opening the file, require loopback, `x-taskboard-client: taskctl`, a trusted Feishu origin, a creation-time `driver_report` policy with source path, an active matching ownership chain, and a constant-time Bearer-token match. Parse only `path` and lowercase 64-character `sha256`.

At the existing binary `POST /api/local/tasks/:id/artifacts` entry, require the creation-time source policy to be `manual_select` before calling `artifactService.acceptUpload`. This leaves every existing manual-select request unchanged while preventing a driver-configured task from bypassing run binding after its claim settles.

Use `realpath` for root and file; reject `path.relative(root, file)` when empty, absolute, or beginning with `..`; require a regular `.zip`. Stream that exact file through `artifactService.acceptUpload`, compare its computed hash, then call:

```js
database.createTaskArtifact(task.id, {
  ...stored,
  sourceMode: "driver_report",
  runId,
  requiredRunClaim: { runId, claimToken: claim.claimToken },
  requiredTaskStatus: "in_progress",
  completedTaskStatus: null,
  actor: CODEX_AGENT_ACTOR,
});
```

Remove the stored copy on every later error and on an idempotent duplicate.

- [ ] **Step 6: Reconcile completion and exact enqueue**

In both live and restart reconciliation, load `getTaskArtifactForRun(taskId, run.id)`. For a completed run with a verified match, settle automatic as `done` and manual as `in_review`; without one, retain current `in_progress`. Failed/interrupted remains `blocked` even when an artifact exists.

Refactor automatic enqueue so live reconciliation calls `enqueueArtifactUpload(task, metadata, artifact, { automaticOnly: true })` with this exact artifact. Keep the existing latest-artifact lookup only for startup recovery of already-completed tasks.

- [ ] **Step 7: Verify GREEN and manual regression**

```powershell
node --test test/artifact-service.test.mjs test/artifact-upload-queue.test.mjs test/task-start-flow.test.mjs
```

Expected: all focused tests pass.

- [ ] **Step 8: Commit**

```powershell
git add server/app.mjs test/artifact-upload-queue.test.mjs
git commit -m "feat: accept trusted Auto-Cut driver reports"
```

---

### Task 5: Enable Configuration And Update Documentation

**Files:**
- Modify: `web/src/components/FeishuWorkflowPanel.tsx:140-155,271-283,440-449`
- Modify: `test/feishu-workflow-ui.test.mjs:51-70`
- Modify: `README.md:195-200`
- Modify: `README.zh-CN.md:191-196`

**Interfaces:**
- Enables selectable `driver_report` with required source root.
- Keeps `watch_directory` disabled and preserves `manual_select`.

- [ ] **Step 1: Write the failing UI test**

```js
assert.match(panel, /<option value="driver_report">Auto-Cut 上报<\/option>/);
assert.match(panel, /<option value="watch_directory" disabled>/);
assert.doesNotMatch(panel, /<option value="driver_report" disabled>/);
```

Also assert enable validation requires a non-empty path only for `driver_report`, while `manual_select` saves null.

- [ ] **Step 2: Run the test and verify RED**

```powershell
node --test --test-name-pattern="ZIP source" test/feishu-workflow-ui.test.mjs
```

Expected: FAIL because driver reporting is still disabled and marked as future work.

- [ ] **Step 3: Enable only driver reporting**

```tsx
<option value="manual_select">手动选择</option>
<option value="watch_directory" disabled>监控目录（后续）</option>
<option value="driver_report">Auto-Cut 上报</option>
```

Allow `driver_report` when its source root is non-empty; retain the existing future-work block for `watch_directory`.

- [ ] **Step 4: Update both READMEs**

Document `taskctl artifact report --file <absolute accepted ZIP>`, active task/run capability validation, source-root containment, independent hash/ZIP verification, automatic completion/enqueue, manual review, and the explicit absence of directory scanning or newest-file selection.

- [ ] **Step 5: Verify GREEN**

```powershell
node --test test/feishu-workflow-ui.test.mjs test/feishu-workflow-store.test.mjs test/project-readme.test.mjs
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```powershell
git add web/src/components/FeishuWorkflowPanel.tsx test/feishu-workflow-ui.test.mjs README.md README.zh-CN.md
git commit -m "docs: expose Auto-Cut driver reporting"
```

---

### Task 6: Direct Verification And Review Handoff

**Files:**
- Verify only; modify an earlier task's files only when direct evidence identifies a concrete defect.

**Interfaces:**
- Produces fresh success, rejection, manual-regression, schema, and review evidence.

- [ ] **Step 1: Run the focused verification set**

```powershell
node --test test/task-artifact-migration.test.mjs test/cli.test.mjs test/ai-chat-runner.test.mjs test/task-start-flow.test.mjs test/artifact-service.test.mjs test/artifact-upload-queue.test.mjs test/feishu-workflow-ui.test.mjs test/feishu-workflow-store.test.mjs test/project-readme.test.mjs
```

Expected: zero failures.

- [ ] **Step 2: Run repository type/lint checks for touched layers**

Read `package.json` and run its existing Web/server typecheck or lint scripts. Do not run native packaging because this path does not change Launcher, native host, updater, signing, or release behavior.

- [ ] **Step 3: Inspect final state**

```powershell
git diff --check origin/main...HEAD
git status --short
git log --oneline --decorate origin/main..HEAD
```

Expected: no whitespace errors or generated files, with only this feature's design and implementation commits.

- [ ] **Step 4: Apply the repository review gate**

Classify this as Pro review because it changes persistent schema, process-scoped credentials, filesystem ingestion, and run reconciliation. First provide the directly verified function to the user and obtain functional confirmation. Only afterward submit the public PR URL and exact head SHA to ChatGPT web Pro for implementation correctness and real bugs, without over-design or defensive scope expansion.

- [ ] **Step 5: Stop before merge or release**

Report changed files, commits, exact SHA, verification, limitations, and review state. Do not merge, release, or mark a Taskboard issue `done` without explicit authorization.
