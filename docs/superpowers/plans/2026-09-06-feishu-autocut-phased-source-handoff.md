# Feishu Auto-Cut Phased Source Handoff Implementation Plan

> **Execution note:** Implement this plan in the isolated worktrees below, following the checked TDD steps task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect three independently configured Feishu workflow stages to one exact Auto-Cut run and one verified ZIP, using an immutable source manifest and the existing driver_report capability.

**Architecture:** The Bridge proves a real status edge and submits an authenticated Feishu record identity plus controlled field values to Taskboard. Taskboard validates the server-owned subject version, freezes the stage snapshot, creates run-private source and naming inputs, and injects the existing short-lived report capability. Auto-Cut-lite reads the manifest with the authorized Feishu user identity, produces an editable JianYing draft and exact ZIP, and Taskboard accepts it only when task, run, stage, version, structure, and hash all match.

**Tech Stack:** Node.js ESM, built-in node:test, SQLite through the existing database wrapper, React/TypeScript, Python 3.11+ runtime scripts, Feishu SDK/OpenAPI through the existing Bridge, and the existing Auto-Cut-lite JianYing pipeline.

## Global Constraints

- Bridge and Taskboard continue to bind only to 127.0.0.1; no Feishu record write-back is added.
- Only a task created through POST /api/local/feishu/tasks with the Bridge client and shared secret can receive automatic execution or artifact registration. Ordinary tasks, description markers, labels, and direct report requests remain ineligible.
- One subject has one real single-select status field. The fixed stages are initial, first_review, and final_review; at least one stage is enabled and enabled stages use distinct option IDs.
- A stage triggers only when the same field changes from a non-target option to its configured target option. Missing or mismatched before/after data is fail-closed; leaving the target and re-entering is required after a disabled period.
- Stage configuration is frozen into the task and then into each run. A later configuration edit cannot change an existing task or run.
- A record document field contains exactly one validated HTTPS Feishu Docx URL. Docx anchors use trimmed, exact text matching and include descendants until the next peer or ancestor heading.
- Docx media is paired in document order. Base attachment sources are opaque field identifiers and must contain exactly one usable attachment. Count, MIME, download, or duration violations block the stage instead of selecting a guess.
- video_original does not read an audio source. replace_original requires one and uses the configured duration tolerance, defaulting to 3 seconds.
- The three stages start from their own complete inputs and never reuse a prior stage ZIP. Auto-Cut package concurrency is fixed at 1; upload workers retain their independent configured concurrency.
- ZIP source and destination directories are local configuration values or approved allowlisted bindings, never values promoted from a Feishu cell into a path, command, or prompt.
- The naming field accepts a normal text value or a formula result already computed by Base; the result must be non-empty before the stage suffix is appended. The configured workflow relies on the user-confirmed invariant that this value is unique.
- Automatic execution keeps the existing approximately five-second delay and enqueues only when the frozen enqueueMode is automatic. Manual selection and manual acceptance remain unchanged.
- No artifact is selected by file name, mtime, directory enumeration, or an inferred most-recent result. The successful Auto-Cut JSON must provide the exact ZIP path and SHA-256.
- FEI-10 remains paused throughout implementation and verification.

## Verified Operation Path Before Implementation

The currently observable path, which the implementation must extend rather than bypass, is:

    Feishu SDK record-change event
    -> D:\codex\codex-feishu\src\feishu-event.mjs normalizes Base/table/record and field values
    -> D:\codex\codex-feishu\src\decide-event.mjs selects a configured subject
    -> D:\codex\codex-feishu\src\bridge.mjs acquires the event lease
    -> POST /api/local/feishu/tasks
    -> D:\codex\dashi-taskboard\server\app.mjs authenticates the loopback client and creates task/origin/package snapshots
    -> server\feishu-execution-coordinator.mjs schedules an automatic run
    -> server\app.mjs startClaimedTaskWithAi creates the AI run and injects the run report capability
    -> Auto-Cut calls driver_report with the exact accepted ZIP
    -> the artifact-report route verifies the ZIP and changes task/upload state.

The new side effect is one run-private source-manifest.json and execution_input.json created between run creation and Auto-Cut start. The observable result is one immutable taskId + runId + stageId + configVersion binding with a validated ZIP, or a stage-level blocking record with a stable reason code.

## Scope Gate: Auto-Cut Source Provenance

The installed D:\codex\Auto-cut-lite directory is a deployment workspace, not a Git checkout. Its reported plugin/runtime versions are 1.6.5+codex.20260903020653 and 1.7.0; its receipt names source commit a3bf96b240e3260c3ee52a3d0e9e2051d55b0fb1. That exact commit is proven in the authoritative public repository https://github.com/fengcong22/auto-cut-lite.git on the history of origin/feature/auto-cut-lite, and its plugin/runtime versions match the receipt and installed package. CopyA and CopyB do not contain that object and have user-owned changes, so neither is a source base. The installed runner has --snapshot-json, --project-json, --execution-input, and --package-zip, but no --source-manifest.

No deployed Auto-Cut file may be edited in place. Auto-Cut Tasks 6 and 7 run only after a fresh isolated clone verifies the receipt commit and creates a worktree pinned to it. Source files in that checkout live under scripts/...; runtime/scripts/... is deployment layout only. Taskboard and Bridge contract work can proceed independently, but an end-to-end completion claim still requires the isolated Auto-Cut worktree and a newly built test package.

## File Map

- server/feishu-workflow-store.mjs and server/feishu-workflow-api.mjs: canonical subject/stage schema, metadata validation, version snapshots, and API payloads.
- server/database.mjs and server/app.mjs: trusted origin/run persistence, source inputs, retry route, report binding, and state transitions.
- server/feishu-source-manifest.mjs: pure canonical manifest normalization, validation, serialization, and SHA-256.
- server/feishu-execution-coordinator.mjs: package-level serial Auto-Cut lease and independent upload scheduling.
- web/src/types.ts, web/src/api.ts, web/src/components/FeishuWorkflowPanel.tsx, and web/src/App.tsx: stage configuration and blocking/retry display.
- D:\codex\worktrees\feishu-autocut-bridge\src\workflow-config.mjs, workflow-config-store.mjs, workflow-runtime.mjs, feishu-base-metadata.mjs, feishu-event.mjs, decide-event.mjs, task-payload.mjs, bridge.mjs, state-store.mjs, and server.mjs: Bridge configuration, event decision, identity, lease, controlled-context refresh, and registration.
- Verified Auto-Cut source worktree: scripts/cli/jy_wrapper_parser.py, scripts/utils/review_document_intake.py, scripts/utils/review_document_runner.py, scripts/review_job.py, scripts/utils/review_job_compiler.py, scripts/utils/review_job_pipeline.py, and focused Python tests.
- Test locations: D:\codex\worktrees\feishu-autocut-taskboard\test, D:\codex\worktrees\feishu-autocut-bridge\test, and D:\codex\worktrees\feishu-autocut-autocut\tests.

From Task 1 onward, every relative Taskboard path and command resolves under D:\codex\worktrees\feishu-autocut-taskboard, every Bridge path and command resolves under D:\codex\worktrees\feishu-autocut-bridge, and every Auto-Cut path and command resolves under D:\codex\worktrees\feishu-autocut-autocut. Do not run an edit, formatter, test that writes fixtures, or commit command from the source repositories or deployed runtime directories.

---

### Task 0: Establish Isolated Worktrees and the Auto-Cut Source Gate

**Files:**
- Read only: D:\codex\dashi-taskboard\AGENTS.md
- Read only: D:\codex\codex-feishu\AGENTS.md
- Read only after isolated checkout: D:\codex\worktrees\feishu-autocut-autocut\AGENTS.md and every nested AGENTS.md governing changed paths
- Read only: D:\codex\插件包ZIP\auto-cut-lite-1.6.5+codex.20260903020653-windows-x64.zip.receipt.json
- Create outside deployed directories: D:\codex\worktrees\feishu-autocut-taskboard
- Create outside deployed directories: D:\codex\worktrees\feishu-autocut-bridge
- Create outside deployed directories: D:\codex\worktrees\auto-cut-lite-source and D:\codex\worktrees\feishu-autocut-autocut

**Interfaces:**
- Produces Taskboard and Bridge implementation branches/worktrees based on their verified current origin/main plus the already committed driver_report dependency.
- Produces an Auto-Cut source worktree pinned to the receipt commit from the authoritative repository.
- Blocks Tasks 6 and 7 if the fresh clone cannot prove the receipt commit and branch ancestry. A deployment copy or dirty user checkout is never substituted.

- [ ] **Step 1: Verify the two Git bases and preserve user changes**

~~~powershell
git -C 'D:\codex\dashi-taskboard' fetch origin
git -C 'D:\codex\dashi-taskboard' status --short --branch
git -C 'D:\codex\dashi-taskboard' rev-parse --verify origin/main
git -C 'D:\codex\dashi-taskboard' merge-base --is-ancestor origin/main codex/feishu-autocut-workflow
git -C 'D:\codex\codex-feishu' fetch origin
git -C 'D:\codex\codex-feishu' status --short --branch
git -C 'D:\codex\codex-feishu' rev-parse --verify origin/main
~~~

Expected: both origin/main refs resolve and every existing dirty path is recorded without reset, checkout, deletion, or overwrite. The ancestry command exits zero. If it does not, update codex/feishu-autocut-workflow with a normal non-rewriting merge of the fetched origin/main, resolve only genuine conflicts, and rerun the check. Record the exact Taskboard prerequisite SHA with git rev-parse codex/feishu-autocut-workflow; it must contain driver_report commits 5e75be10619439b325b9ff4d7e5c1e7a8c7d2f9d, 317829ea69ffbb6be0f347b2fd7a7417a45070f4, 8c939f723064c67e5083f6f58c96141492c3f97b, 2f15e882a4aca03ad8b905f537fedaa339f2c4a4, cdcb89ed843a6f1ec33bef3ba0bf02df222d93d6, and 4c804469e158e5a20f15b75adb25880ae858722f.

- [ ] **Step 2: Verify the Auto-Cut receipt and authoritative source without editing deployment copies**

~~~powershell
$receipt = Get-Content 'D:\codex\插件包ZIP\auto-cut-lite-1.6.5+codex.20260903020653-windows-x64.zip.receipt.json' | ConvertFrom-Json
$receipt.source_git_commit
$autoCutCommit = 'a3bf96b240e3260c3ee52a3d0e9e2051d55b0fb1'
if ($receipt.source_git_commit -ne $autoCutCommit) { throw 'Auto-Cut receipt commit changed' }
git ls-remote 'https://github.com/fengcong22/auto-cut-lite.git' 'refs/heads/feature/auto-cut-lite'
Get-FileHash -Algorithm SHA256 'D:\codex\插件包ZIP\auto-cut-lite-1.6.5+codex.20260903020653-windows-x64.zip'
git -C 'D:\codex\Auto-Cut-CopyA' status --short --branch
~~~

Expected: the receipt commit equals the fixed SHA, the authoritative branch ref resolves, the deployment ZIP hash equals receipt value 2e5462a4f8fda19d66a368569f1b5e4cbdec69c9e4909b50aca5127d0e07efed, and CopyA status is preserved only as evidence that it must not be used.

- [ ] **Step 3: Create isolated feature worktrees**

~~~powershell
New-Item -ItemType Directory -Path 'D:\codex\worktrees' -Force | Out-Null
$taskboardBase = git -C 'D:\codex\dashi-taskboard' rev-parse codex/feishu-autocut-workflow
git -C 'D:\codex\dashi-taskboard' worktree add -b codex/feishu-autocut-phased-handoff 'D:\codex\worktrees\feishu-autocut-taskboard' $taskboardBase
git -C 'D:\codex\codex-feishu' worktree add -b codex/feishu-autocut-phased-handoff 'D:\codex\worktrees\feishu-autocut-bridge' origin/main
$autoCutClone = 'D:\codex\worktrees\auto-cut-lite-source'
$autoCutWorktree = 'D:\codex\worktrees\feishu-autocut-autocut'
$autoCutCommit = 'a3bf96b240e3260c3ee52a3d0e9e2051d55b0fb1'
foreach ($candidate in @($autoCutClone, $autoCutWorktree)) {
  if (Test-Path -LiteralPath $candidate) { throw "Refusing to overwrite $candidate" }
}
git clone --no-checkout --branch feature/auto-cut-lite 'https://github.com/fengcong22/auto-cut-lite.git' $autoCutClone
git -C $autoCutClone cat-file -e "$autoCutCommit^{commit}"
git -C $autoCutClone merge-base --is-ancestor $autoCutCommit origin/feature/auto-cut-lite
git -C $autoCutClone worktree add -b codex/feishu-autocut-source-handoff $autoCutWorktree $autoCutCommit
git -C $autoCutWorktree rev-parse HEAD
git -C $autoCutWorktree status --short --branch
~~~

Expected: each worktree has an isolated branch and the installed Taskboard, Bridge, Auto-Cut runtime, CopyA, and CopyB remain untouched. The Taskboard worktree starts at the exact prerequisite SHA recorded in Step 1, so its already reviewed driver_report history is preserved without merging a moving branch name. Auto-Cut HEAD equals a3bf96b240e3260c3ee52a3d0e9e2051d55b0fb1; otherwise remove no directories, record AUTOCUT_SOURCE_UNVERIFIED, and keep Tasks 6 and 7 blocked.

- [ ] **Step 4: Record the E3 estimate before implementation**

Record this exact path in the implementation issue or task record:

    Feishu status edge -> Bridge decision and authenticated registration
    -> Taskboard subject-version validation and run input files
    -> Auto-Cut user-identity source read and editable draft
    -> exact driver_report ZIP -> Taskboard completion and optional upload enqueue.

Classify the implementation as high risk because it crosses persistence, external Feishu reads, process execution, local/NAS paths, and shared JianYing resources. The direct verification budget is one successful automatic path plus one ambiguous-source blocking path followed by explicit retry.

---

### Task 1: Add the Three-Stage Subject Contract and Metadata Validation

**Files:**
- Modify: server/feishu-workflow-store.mjs
- Modify: server/feishu-workflow-api.mjs
- Modify: web/src/types.ts
- Modify: web/src/api.ts
- Modify: D:\codex\worktrees\feishu-autocut-bridge\src\workflow-config.mjs
- Modify: D:\codex\worktrees\feishu-autocut-bridge\src\workflow-config-store.mjs
- Modify: D:\codex\worktrees\feishu-autocut-bridge\src\workflow-runtime.mjs
- Modify: D:\codex\worktrees\feishu-autocut-bridge\src\feishu-base-metadata.mjs
- Create: D:\codex\worktrees\feishu-autocut-bridge\src\subject-version-history.mjs
- Test: test/feishu-workflow-api.test.mjs
- Test: test/workflow-config.test.mjs
- Test: D:\codex\worktrees\feishu-autocut-bridge\test\workflow-config.test.mjs
- Test: D:\codex\worktrees\feishu-autocut-bridge\test\feishu-base-metadata.test.mjs
- Create: D:\codex\worktrees\feishu-autocut-bridge\test\subject-version-history.test.mjs

**Interfaces:**
- Export STAGE_IDS with initial, first_review, and final_review.
- normalizeStage(stage, metadata, stageId) returns enabled, trigger, videoSource, reviewSource, audio, artifactTargetPath, and nameSuffix.
- validateSubjectConfig(subject) rejects a missing single-select status field, stale option IDs, duplicate enabled target options, invalid source descriptors, invalid audio mode, and a subject with no enabled stage.
- Public subjects expose statusField, documentField, namingField, stages, execution, packageRoute, and upload.
- Bridge synchronization omits each machine-local artifactTargetPath but preserves the stage source descriptors and suffix.
- Each feishu_subject_versions row records the enabled interval used to decide whether a delayed event occurred while that version was active. Bridge history is durable and queryable by both `(subjectKey, configVersion)` and `(subjectKey, occurredAt)`; disabling or deleting the current subject never removes an old version needed by a delayed event or an explicit retry.
- Bridge workflow storage appends the same immutable subject version with enabledAt/closedAt and exposes getSubjectVersion(subjectKey, configVersion) plus resolveSubjectVersionAt(subjectKey, occurredAt). It never reconstructs an old version from the current subject.
- `subject-version-history.mjs` persists a versioned sidecar next to the Bridge workflow config under the same state lock; each entry contains subjectKey, configVersion, enabledAt, closedAt, lifecycle, and the full portable subject snapshot. History writes and current-config writes occur in one serialized store mutation, and an interrupted write leaves the previous pair intact.

- [ ] **Step 1: Write failing fixed-stage and source-mode tests**

~~~js
test("normalizes all fixed stages and rejects duplicate enabled options", () => {
  const subject = validSubjectWithStages();
  const normalized = validateSubjectConfig(subject);
  assert.deepEqual(Object.keys(normalized.stages), ["initial", "first_review", "final_review"]);
  assert.equal(normalized.stages.initial.trigger.optionId, "opt_initial");
  const duplicate = structuredClone(subject);
  duplicate.stages.final_review.trigger = structuredClone(duplicate.stages.initial.trigger);
  assert.throws(
    () => validateSubjectConfig(duplicate),
    /enabled stage trigger options must be unique/,
  );
});

test("requires external audio only for replace_original", () => {
  const subject = validSubjectWithStages();
  subject.stages.initial.audio = { mode: "replace_original", source: null, durationToleranceSeconds: 3 };
  assert.throws(() => validateSubjectConfig(subject), /audio source is required/);
  subject.stages.initial.audio = { mode: "video_original" };
  assert.equal(validateSubjectConfig(subject).stages.initial.audio.mode, "video_original");
});

test("retains immutable enabled intervals for delayed events and retries", async () => {
  await store.syncSubject(version(7, { lifecycle: "enabled", enabledAt: 1000 }));
  await store.syncSubject(version(8, { lifecycle: "disabled", enabledAt: 2000 }));
  assert.equal((await store.resolveSubjectVersionAt(subjectKey, 1500)).configVersion, 7);
  assert.equal((await store.getSubjectVersion(subjectKey, 7)).documentField.fieldId, "fld_document_v7");
  assert.equal(await store.resolveSubjectVersionAt(subjectKey, 2500), null);
});

test("history is not rewritten when the current subject is edited", async () => {
  await store.syncSubject(version(7, { lifecycle: "enabled", enabledAt: 1000 }));
  await store.saveDraft(subjectKey, { documentField: { fieldId: "fld_document_v8" } });
  assert.equal((await store.getSubjectVersion(subjectKey, 7)).documentField.fieldId, "fld_document_v7");
});
~~~

Also assert that docx_section accepts only non-empty anchorText, base_attachment accepts only configured Base/table/record field identity, enabled stage trigger field IDs equal statusField.fieldId, and machine-local paths are cleared from Bridge/share payloads.

- [ ] **Step 2: Run focused tests and verify RED**

~~~powershell
node --test test/workflow-config.test.mjs test/feishu-workflow-api.test.mjs
Push-Location 'D:\codex\worktrees\feishu-autocut-bridge'; node --test test/workflow-config.test.mjs test/feishu-base-metadata.test.mjs; Pop-Location
~~~

Expected: failure because the current contract has a single trigger and no document, naming, stages, or stage source model.

- [ ] **Step 3: Implement the canonical stage types and normalizers**

Use this exact shape in Taskboard and Bridge:

~~~js
const STAGE_IDS = Object.freeze(["initial", "first_review", "final_review"]);

const stage = {
  enabled: true,
  trigger: { fieldId: "fld_status", optionId: "opt_initial", value: "待初稿" },
  videoSource: { kind: "docx_section", anchorText: "录屏" },
  reviewSource: { kind: "docx_section", anchorText: "修改意见" },
  audio: { mode: "video_original" },
  artifactTargetPath: "D:\\Approved\\Initial",
  nameSuffix: "_初稿",
};
~~~

A video or audio source is exactly one of docx_section with trimmed anchorText or base_attachment with fieldId. reviewSource is always docx_section. Base/table/record identity is added from the trusted event during manifest creation, never accepted inside a subject source. For replace_original, normalize durationToleranceSeconds to a positive finite value and default it to 3. For video_original, remove any supplied audio source.

- [ ] **Step 4: Validate live metadata and freeze config versions**

During subject enable/sync, use current Base metadata to require statusField to be a single-select field, map every enabled trigger optionId to the same stored display value, and verify document/naming/attachment fields exist and have compatible types. Require at least one enabled stage and unique enabled option IDs. Persist the normalized subject as the next immutable configVersion using the existing expected-version transaction.

Record enabledAt when a version becomes active and closedAt when a later enabled/disabled version supersedes it. This interval is server-owned and is not copied from a Bridge registration request. The authenticated Taskboard-to-Bridge subject sync carries the resulting configVersion and interval timestamp; Bridge appends that exact portable version to a subject-version sidecar under the same state lock as the current workflow document and closes the previous interval without mutating its content. A disabled version closes the active interval but is not resolvable as an enabled event version. getSubjectVersion uses subjectKey + configVersion for retry refresh; resolveSubjectVersionAt uses subjectKey + event occurredAt for delayed event decisions. Missing occurredAt may resolve only the currently enabled version. Add a migration test for an existing workflow file with no sidecar: the first sync creates history from the newly received immutable version, while an old event with no provable interval is blocked rather than mapped to the current version.

Keep existing one-trigger subjects readable as legacy manual workflows. Do not silently grant them phased automatic eligibility; only a newly validated stages snapshot can create a phased Auto-Cut task.

- [ ] **Step 5: Verify GREEN and commit each repository**

~~~powershell
node --test test/workflow-config.test.mjs test/feishu-workflow-api.test.mjs
Push-Location 'D:\codex\worktrees\feishu-autocut-bridge'; node --test test/workflow-config.test.mjs test/feishu-base-metadata.test.mjs; Pop-Location
git -C 'D:\codex\worktrees\feishu-autocut-taskboard' diff --check
git -C 'D:\codex\worktrees\feishu-autocut-bridge' diff --check
~~~

Expected: all focused contract tests pass; portable exports and Bridge snapshots contain no machine-local target paths; an event timestamp resolves only the immutable version whose enabled interval contains it.

~~~powershell
git -C 'D:\codex\worktrees\feishu-autocut-taskboard' add server/feishu-workflow-store.mjs server/feishu-workflow-api.mjs web/src/types.ts web/src/api.ts test/workflow-config.test.mjs test/feishu-workflow-api.test.mjs
git -C 'D:\codex\worktrees\feishu-autocut-taskboard' commit -m "feat: add phased Feishu Auto-Cut configuration"
  git -C 'D:\codex\worktrees\feishu-autocut-bridge' add src/workflow-config.mjs src/workflow-config-store.mjs src/workflow-runtime.mjs src/feishu-base-metadata.mjs src/subject-version-history.mjs test/workflow-config.test.mjs test/feishu-base-metadata.test.mjs test/subject-version-history.test.mjs
git -C 'D:\codex\worktrees\feishu-autocut-bridge' commit -m "feat: sync phased Feishu Auto-Cut configuration"
~~~

---

### Task 2: Make Bridge Status-Edge Decisions Explicit and Idempotent

**Files:**
- Modify: D:\codex\worktrees\feishu-autocut-bridge\src\feishu-event.mjs
- Modify: D:\codex\worktrees\feishu-autocut-bridge\src\decide-event.mjs
- Modify: D:\codex\worktrees\feishu-autocut-bridge\src\task-payload.mjs
- Modify: D:\codex\worktrees\feishu-autocut-bridge\src\bridge.mjs
- Modify: D:\codex\worktrees\feishu-autocut-bridge\src\state-store.mjs
- Modify: D:\codex\worktrees\feishu-autocut-bridge\src\feishu-record-reader.mjs
- Modify: D:\codex\worktrees\feishu-autocut-bridge\src\server.mjs
- Test: D:\codex\worktrees\feishu-autocut-bridge\test\feishu-event.test.mjs
- Test: D:\codex\worktrees\feishu-autocut-bridge\test\decide-event.test.mjs
- Test: D:\codex\worktrees\feishu-autocut-bridge\test\bridge.test.mjs
- Test: D:\codex\worktrees\feishu-autocut-bridge\test\state-store.test.mjs
- Test: D:\codex\worktrees\feishu-autocut-bridge\test\feishu-record-reader.test.mjs
- Test: D:\codex\worktrees\feishu-autocut-bridge\test\server.test.mjs

**Interfaces:**
- normalizeBitableRecordChanged(payload, table) preserves beforePresent, afterPresent, beforeOptionId, afterOptionId, statusFieldId, eventOccurredAt, eventOccurredAtPresent, and a stable eventId.
- decideRecordChange(subjectVersion, event) returns register, archive_waiting, blocked, or ignored and binds a successful decision to subjectKey, configVersion, and stageId. The caller obtains subjectVersion through resolveSubjectVersionAt(subjectKey, eventOccurredAt), never from the mutable current subject. A register decision also carries archiveWaiting when the same edge leaves another configured stage target.
- readControlledRecordContext(table, recordId) returns a typed snapshot with documentLinks, namingDisplayValue, and namingValueUnique. It does not turn invalid document cardinality or an empty naming result into a Bridge rejection; those values must reach a trusted blocked run. `namingValueUnique` is false when an exact normalized naming result appears on another record in the same configured table, and is also false when the read/search proof is unavailable.
- POST /api/feishu/workflow/controlled-context accepts only `{ subjectKey, configVersion, baseToken, tableId, recordId }`, authenticates a loopback Taskboard caller with `x-feishu-bridge-client: taskboard` plus the shared `x-feishu-bridge-secret`, resolves the exact immutable Bridge subject version, re-reads that version's document and naming fields with the Bridge application identity, and returns `{ documentLinks, namingDisplayValue, namingValueUnique }`. It never accepts caller-supplied field IDs and never returns paths, commands, prompts, package aliases, or credentials.
- buildTrustedTaskPayload(decision, context) contains no local path, package override, command, prompt, or guessed artifact.

- [ ] **Step 1: Write failing status-edge and replay tests**

~~~js
test("registers only a non-target to target option edge", () => {
  const decision = decideRecordChange(config(), edge("opt_other", "opt_initial"));
  assert.equal(decision.kind, "register");
  assert.equal(decision.stageId, "initial");
  assert.equal(decision.archiveWaiting, false);
  assert.equal(decideRecordChange(config(), edge("opt_initial", "opt_initial")).kind, "ignored");
});

test("leaving a target archives waiting work without stopping active work", async () => {
  const leave = decideRecordChange(config(), edge("opt_initial", "opt_other"));
  assert.equal(leave.kind, "archive_waiting");
  await bridge.handle(edge("opt_initial", "opt_other", { eventId: "evt-leave" }));
  assert.deepEqual(archiveRequests, [{ statusFieldId: "fld_status", beforeOptionId: "opt_initial" }]);
  assert.deepEqual(tasks.map(({ status }) => status), ["archived", "in_progress", "in_review", "done"]);
});

test("moving between stage targets archives old waiting work before registering the new stage", async () => {
  const move = decideRecordChange(config(), edge("opt_initial", "opt_first_review"));
  assert.equal(move.kind, "register");
  assert.equal(move.stageId, "first_review");
  assert.equal(move.archiveWaiting, true);
  await bridge.handle(edge("opt_initial", "opt_first_review", { eventId: "evt-move" }));
  assert.deepEqual(sideEffects, ["archive_waiting", "register:first_review"]);
});

test("missing before or after is fail-closed", () => {
  const result = decideRecordChange(config(), { ...edge("opt_other", "opt_initial"), beforePresent: false });
  assert.deepEqual(
    { kind: result.kind, reasonCode: result.reasonCode },
    { kind: "blocked", reasonCode: "MISSING_STATUS_EDGE" },
  );
});

test("a delayed event retains its provider occurrence time", () => {
  const normalized = normalizeBitableRecordChanged(providerEvent({ createTime: 1788652800000 }), table)[0];
  assert.equal(normalized.eventOccurredAt, 1788652800000);
  assert.equal(normalized.eventOccurredAtPresent, true);
});

test("a delayed edge uses the version active when the provider event occurred", async () => {
  await syncVersion(version(7, { enabledAt: 1000, triggerOptionId: "opt_initial" }));
  await syncVersion(version(8, { lifecycle: "disabled", enabledAt: 2000 }));
  const result = await decidePersistedEvent(edge("opt_other", "opt_initial", {
    eventId: "evt-delayed",
    eventOccurredAt: 1500,
  }));
  assert.equal(result.kind, "register");
  assert.equal(result.configVersion, 7);
});

test("a replay reuses the same registration identity", async () => {
  await bridge.handle(edge("opt_other", "opt_initial", { eventId: "evt-1" }));
  await bridge.handle(edge("opt_other", "opt_initial", { eventId: "evt-1" }));
  assert.equal(posts.length, 1);
  assert.equal(state.registrationForEvent("evt-1").stageId, "initial");
});
~~~

Add a test in which the stage is disabled during the edge and no task is created after later enablement; then send a new leave event and a new re-entry event and assert exactly one new registration.

- [ ] **Step 2: Run focused Bridge tests and verify RED**

~~~powershell
Push-Location 'D:\codex\worktrees\feishu-autocut-bridge'; node --test test/feishu-event.test.mjs test/decide-event.test.mjs test/bridge.test.mjs test/state-store.test.mjs test/server.test.mjs; Pop-Location
~~~

Expected: failure because current normalization converts absent values to empty strings, uses display-value matching, and routes one trigger only.

- [ ] **Step 3: Implement presence-aware option matching**

Resolve the immutable subject version whose enabled interval contains eventOccurredAt, then use that version's configured status field ID and option IDs as the decision key. If eventOccurredAt is absent, only the currently enabled version may be used; if no version is provable, persist blocked reason MISSING_ACTIVE_CONFIG_VERSION and do not register. The pure matcher is:

~~~js
function matchingStage(table, event) {
  if (!event.beforePresent || !event.afterPresent) {
    return { kind: "blocked", reasonCode: "MISSING_STATUS_EDGE" };
  }
  if (event.statusFieldId !== table.statusField.fieldId) {
    return { kind: "ignored", reason: "unrelated_field" };
  }
  const previousEntry = Object.entries(table.stages).find(([, candidate]) => (
    candidate.trigger.optionId === event.beforeOptionId
  ));
  const entry = Object.entries(table.stages).find(([, candidate]) => (
    candidate.enabled && candidate.trigger.optionId === event.afterOptionId
  ));
  if (!entry) {
    return previousEntry
      ? { kind: "archive_waiting", stageId: previousEntry[0], stage: previousEntry[1] }
      : { kind: "ignored", reason: "new_value_not_trigger" };
  }
  if (event.beforeOptionId === event.afterOptionId) {
    return { kind: "ignored", reason: "already_at_trigger" };
  }
  return {
    kind: "register",
    stageId: entry[0],
    stage: entry[1],
    archiveWaiting: Boolean(previousEntry),
    previousStageId: previousEntry?.[0] ?? null,
  };
}
~~~

For an event without a provider event ID, hash the immutable raw action envelope plus baseToken, tableId, recordId, statusFieldId, before option, after option, and occurrence index. Do not create a new ID from a later record read.

For archive_waiting, call the existing Taskboard lifecycle route with the immutable Base/table/record/status-field and previous option binding. It may archive only matching todo tasks. For a register decision with archiveWaiting, perform that archive call first and then post the new-stage registration under the same persisted event decision; a retry resumes whichever side effect is not yet durable and never repeats a successful registration.

- [ ] **Step 4: Read only controlled fields and persist the decision before posting**

When the event has only the changed status field, use the existing Feishu application-identity record reader to obtain the configured document field and naming field. Preserve zero, one, or multiple URL candidates as documentLinks and preserve the computed naming display value, including an empty result, in a bounded typed snapshot. Do not reject source cardinality or naming emptiness here: a valid trusted stage registration must still create a task whose first attempt can become blocked with an observable reason. Media bytes and Base attachment tokens are not read in this step.

Expose the same read through POST /api/feishu/workflow/controlled-context for explicit retries. Reuse the existing two-direction loopback authentication contract: Taskboard-to-Bridge requests carry `x-feishu-bridge-client: taskboard` and `x-feishu-bridge-secret: CODEX_FEISHU_BRIDGE_SECRET`; Bridge-to-Taskboard requests carry `x-taskboard-client: feishu-bridge` and the same secret. Both services compare the secret in constant time, require the request to arrive on 127.0.0.1, and never log or persist it. Require subjectKey + configVersion + baseToken + tableId + recordId, load that exact immutable Bridge version through getSubjectVersion, verify the supplied identity equals the version, and return only documentLinks, namingDisplayValue, and namingValueUnique. Add a test that syncs a later version with different field IDs and proves a retry for version 7 still reads only version 7's document and naming fields. The endpoint is read-only and never writes Feishu.

Persist eventId, eventOccurredAt, subjectKey, configVersion, stageId, edge values, and the controlled context before the HTTP call. The existing lease then makes replays and process restarts retry the same registration rather than reevaluating against a newer config. If the provider occurrence time is absent, a request targeting a no-longer-current version is fail-closed because Taskboard cannot prove that the edge preceded disablement.

- [ ] **Step 5: Verify GREEN and commit**

~~~powershell
Push-Location 'D:\codex\worktrees\feishu-autocut-bridge'; node --test test/feishu-event.test.mjs test/decide-event.test.mjs test/bridge.test.mjs test/state-store.test.mjs test/feishu-record-reader.test.mjs test/server.test.mjs; Pop-Location
git -C 'D:\codex\worktrees\feishu-autocut-bridge' diff --check
~~~

Expected: the focused suite passes, a missing edge never posts, a replay posts at most once, and re-entry with a new event ID registers once.

~~~powershell
git -C 'D:\codex\worktrees\feishu-autocut-bridge' add src/feishu-event.mjs src/decide-event.mjs src/task-payload.mjs src/bridge.mjs src/state-store.mjs src/feishu-record-reader.mjs src/server.mjs test/feishu-event.test.mjs test/decide-event.test.mjs test/bridge.test.mjs test/state-store.test.mjs test/feishu-record-reader.test.mjs test/server.test.mjs
git -C 'D:\codex\worktrees\feishu-autocut-bridge' commit -m "feat: bind Feishu task registration to stage edges"
~~~


---

### Task 3: Validate and Persist Trusted Stage Registration in Taskboard

**Files:**
- Modify: server/database.mjs
- Modify: server/app.mjs
- Modify: server/feishu-workflow-store.mjs
- Modify: web/src/types.ts
- Test: test/feishu-task-origin-api.test.mjs
- Create: test/feishu-stage-registration.test.mjs
- Create: test/feishu-origin-stage-migration.test.mjs

**Interfaces:**
- parseFeishuStageRegistrationBody(body) accepts event, binding, and controlledContext only.
- createFeishuStageTask(registration, derivedTask, packageSnapshot) inserts the task, queryable origin binding, and package snapshot in one transaction.
- findFeishuTaskByRegistration(identity) performs an indexed lookup.
- getFeishuSubjectVersion(subjectKey, configVersion) returns the immutable stored subject snapshot or null.
- POST /api/local/feishu/tasks returns 201 for a fresh binding, 200 with the existing task for an identical replay, and 409 FEISHU_EVENT_BINDING_CONFLICT for the same event identity with different immutable data.

**Canonical request body:**

~~~json
{
  "event": {
    "eventId": "evt-1",
    "baseToken": "bas_demo",
    "tableId": "tbl_math",
    "recordId": "rec_1",
    "statusFieldId": "fld_status",
    "beforeOptionId": "opt_other",
    "afterOptionId": "opt_initial",
    "occurredAt": 1788652800000
  },
  "binding": {
    "subjectKey": "bas_demo:tbl_math",
    "configVersion": 7,
    "stageId": "initial"
  },
  "controlledContext": {
    "documentLinks": ["https://guanghe.feishu.cn/docx/opaque-token"],
    "namingDisplayValue": "课程001",
    "namingValueUnique": true
  }
}
~~~

Base attachment cell contents are not inserted into this request. Their configured field IDs are already in the frozen stage snapshot, and Auto-Cut reads those fields later with its user identity.

- [ ] **Step 1: Write failing registration and migration tests**

~~~js
test("derives execution policy from the stored enabled subject version", async () => {
  const result = await postRegistration(server, validRegistration({
    binding: { subjectKey, configVersion: 7, stageId: "initial" },
  }));
  assert.equal(result.status, 201);
  assert.equal(result.body.task.feishuOrigin.stageId, "initial");
  assert.equal(result.body.task.feishuOrigin.configVersion, 7);
  assert.equal(result.body.task.feishuOrigin.packageAlias, "Auto-cut-lite");
  assert.equal(result.body.task.feishuOrigin.executionMode, "automatic");
});

test("an identical event replay is idempotent but a changed binding conflicts", async () => {
  const first = await postRegistration(server, validRegistration());
  const replay = await postRegistration(server, validRegistration());
  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.task.id, first.body.task.id);
  const conflict = await postRegistration(server, validRegistration({
    binding: { subjectKey, configVersion: 7, stageId: "final_review" },
  }));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "FEISHU_EVENT_BINDING_CONFLICT");
});

test("a trusted stage with invalid source values is registered for an observable blocked attempt", async () => {
  const result = await postRegistration(server, validRegistration({
    controlledContext: { documentLinks: [], namingDisplayValue: "" },
  }));
  assert.equal(result.status, 201);
  assert.equal(result.body.task.feishuOrigin.stageId, "initial");
  assert.deepEqual(result.body.task.feishuOrigin.controlledContext.documentLinks, []);
  assert.equal(result.body.task.feishuOrigin.controlledContext.namingValueUnique, false);
});
~~~

Also migrate a database containing legacy feishu_task_origins rows, assert those rows remain readable but have null stage columns, and assert the new partial unique index exists. Test forged normal-task descriptions and labels through POST /api/tasks and direct artifact-report requests; neither may gain a registration row or automatic eligibility.

- [ ] **Step 2: Run tests and verify RED**

~~~powershell
node --test test/feishu-task-origin-api.test.mjs test/feishu-stage-registration.test.mjs test/feishu-origin-stage-migration.test.mjs
~~~

Expected: failure because the current route trusts description metadata and feishu_task_origins has no queryable stage/version/event columns.

- [ ] **Step 3: Add queryable immutable registration columns**

Migrate feishu_task_origins to preserve metadata_json and add:

~~~sql
subject_key TEXT,
config_version INTEGER,
stage_id TEXT,
event_id TEXT,
base_token TEXT,
table_id TEXT,
record_id TEXT,
status_field_id TEXT,
before_option_id TEXT,
after_option_id TEXT,
event_occurred_at INTEGER,
stage_snapshot_json TEXT,
controlled_context_json TEXT
~~~

Create this partial unique index:

~~~sql
CREATE UNIQUE INDEX feishu_task_origins_event
ON feishu_task_origins(
  base_token,
  table_id,
  record_id,
  status_field_id,
  stage_id,
  event_id
)
WHERE event_id IS NOT NULL AND stage_id IS NOT NULL;
~~~

Legacy rows keep null stage columns and remain eligible only for their preexisting manual behavior. The event index follows the approved `(base, table, record, field, stage, event)` identity. Before insertion, also query the same identity without stage_id; if a row exists for a different stage or immutable binding, return FEISHU_EVENT_BINDING_CONFLICT. This preserves the stage-inclusive schema while preventing one provider event from being rebound concurrently. New phased registration inserts all columns and the existing metadata_json in the same BEGIN IMMEDIATE transaction as task and package snapshot creation.

- [ ] **Step 4: Derive all executable policy server-side**

In POST /api/local/feishu/tasks, authenticate the loopback Bridge first, parse the canonical request, then load subjectKey + configVersion from feishu_subject_versions. Require that the stored version was enabled at event.occurredAt, stageId exists and was enabled, trigger field/option exactly matches the event edge, projectId equals subjectProjectId(subjectKey), package alias exists and is enabled, and the stage destination belongs to the saved local subject configuration. When occurredAt is absent, accept only the currently active version; otherwise return STALE_STAGE_EVENT. Validate controlledContext only as bounded inert data with the exact documentLinks, namingDisplayValue, and boolean namingValueUnique keys; do not require one link or a non-empty name at registration time. Those source checks run after the attempt row exists, so a trusted task can expose and retry the failure without granting it artifact eligibility.

Derive title, project, labels, executionMode, packageAlias, package revision, enqueueMode, package source root, stage destination, suffix, and prompt from server-owned snapshots. Store controlledContext.documentLinks, controlledContext.namingDisplayValue, and the Bridge-provided namingValueUnique proof only as inert snapshot data for the first attempt, never as a command, local path, package name, or prompt. The run-preparation boundary is responsible for requiring exactly one official Feishu HTTPS Docx URL, a non-empty computed naming value, and namingValueUnique === true.

- [ ] **Step 5: Implement indexed idempotency in the same transaction**

Before insertion, look up the full unique identity. If an existing row has byte-equivalent binding and controlled-context canonical JSON, return its task. If any immutable value differs, throw FEISHU_EVENT_BINDING_CONFLICT. On a concurrent unique-index failure, repeat that comparison rather than creating another task.

- [ ] **Step 6: Verify GREEN and commit**

~~~powershell
node --test test/feishu-task-origin-api.test.mjs test/feishu-stage-registration.test.mjs test/feishu-origin-stage-migration.test.mjs
git diff --check
~~~

Expected: fresh registration is 201, identical replay is 200, conflicts are 409, and untrusted task creation cannot create a stage-bound origin.

~~~powershell
git add server/database.mjs server/app.mjs server/feishu-workflow-store.mjs web/src/types.ts test/feishu-task-origin-api.test.mjs test/feishu-stage-registration.test.mjs test/feishu-origin-stage-migration.test.mjs
git commit -m "feat: persist trusted Feishu stage registrations"
~~~

---

### Task 4: Create Canonical Run Manifests, Naming Inputs, and Attempt Records

**Files:**
- Create: server/feishu-source-manifest.mjs
- Modify: server/database.mjs
- Create: test/feishu-source-manifest.test.mjs
- Create: test/feishu-autocut-run-migration.test.mjs

**Interfaces:**
- SOURCE_MANIFEST_SCHEMA_VERSION equals 1.
- createSourceManifest(input) returns a deeply normalized plain object using the snake_case JSON contract below.
- canonicalSourceManifestJson(manifest) returns deterministic UTF-8 JSON with recursively sorted object keys and preserved array order.
- sourceManifestSha256(manifest) returns a lowercase 64-character SHA-256.
- createFeishuAutoCutRun(input) stores one preparing attempt for taskId + runId before any current-field or manifest validation and rejects another task/run binding.
- markFeishuAutoCutRunPrepared(runId, input) fills the immutable manifest, execution input, artifact naming, and output path columns exactly once.
- getFeishuAutoCutRun(runId) returns its immutable binding, paths, digests, attempt number, state, errorCode, and errorMessage.
- markFeishuAutoCutRunBlocked(runId, error) records a stable stage-level failure without completing or uploading the task.

**Canonical source-manifest.json:**

~~~json
{
  "schema_version": 1,
  "binding": {
    "task_id": "task-1",
    "run_id": "run-1",
    "subject_key": "bas_demo:tbl_math",
    "config_version": 7,
    "stage_id": "initial",
    "event_id": "evt-1"
  },
  "record": {
    "base_token": "bas_demo",
    "table_id": "tbl_math",
    "record_id": "rec_1"
  },
  "document": {
    "field_id": "fld_document",
    "url": "https://guanghe.feishu.cn/docx/opaque-token"
  },
  "sources": {
    "video": {
      "kind": "docx_section",
      "anchor_text": "录屏"
    },
    "review": {
      "kind": "docx_section",
      "anchor_text": "修改意见"
    },
    "audio": {
      "mode": "replace_original",
      "duration_tolerance_seconds": 3,
      "source": {
        "kind": "base_attachment",
        "field_id": "fld_audio"
      }
    }
  }
}
~~~

execution_input.json is exactly:

~~~json
{
  "schema_version": 1,
  "artifact_name": "课程001_初稿"
}
~~~

- [ ] **Step 1: Write failing canonicalization and validation tests**

~~~js
test("canonical manifest preserves document order semantics and has a stable digest", () => {
  const manifest = createSourceManifest(validManifestInput());
  const reorderedInput = reorderObjectKeys(validManifestInput());
  assert.equal(
    canonicalSourceManifestJson(manifest),
    canonicalSourceManifestJson(createSourceManifest(reorderedInput)),
  );
  assert.match(sourceManifestSha256(manifest), /^[a-f0-9]{64}$/u);
  assert.equal(manifest.binding.stage_id, "initial");
});

test("manifest rejects paths, prompts, credentials, and unsupported sources", () => {
  for (const injected of [
    { prompt: "edit this" },
    { command: "ffmpeg" },
    { local_path: "D:\\media\\x.mp4" },
    { access_token: "secret" },
  ]) {
    assert.throws(
      () => createSourceManifest({ ...validManifestInput(), ...injected }),
      /SOURCE_MANIFEST_INVALID/,
    );
  }
});
~~~

Also test one official HTTPS Docx URL, exact trimmed anchors, video_original removing source/tolerance, replace_original requiring its source, positive tolerance, fixed stage IDs, and Base attachment field IDs without file paths or attachment-name selection.

- [ ] **Step 2: Run tests and verify RED**

~~~powershell
node --test test/feishu-source-manifest.test.mjs test/feishu-autocut-run-migration.test.mjs
~~~

Expected: module and run-attempt table do not exist.

- [ ] **Step 3: Implement strict canonical manifest normalization**

Reject unknown keys at every level. Accept document hosts ending in .feishu.cn, an HTTPS protocol, no username/password, and a pathname matching /docx/{opaque-token}. Preserve only origin and pathname; reject query and fragment. Trim anchors only at their edges and keep their remaining code points unchanged. Keep array order stable and never sort source media.

Canonicalize with a recursive key-sort function:

~~~js
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
  );
}

export function canonicalSourceManifestJson(manifest) {
  return JSON.stringify(canonicalValue(validateSourceManifest(manifest)));
}
~~~

Hash exactly Buffer.from(canonicalSourceManifestJson(manifest), "utf8").

- [ ] **Step 4: Add immutable run-attempt persistence**

Create feishu_autocut_runs with:

~~~sql
run_id TEXT PRIMARY KEY,
task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
attempt INTEGER NOT NULL CHECK (attempt > 0),
subject_key TEXT NOT NULL,
config_version INTEGER NOT NULL CHECK (config_version > 0),
stage_id TEXT NOT NULL CHECK (stage_id IN ('initial', 'first_review', 'final_review')),
event_id TEXT NOT NULL,
manifest_path TEXT,
manifest_sha256 TEXT,
execution_input_path TEXT,
drafts_root TEXT,
result_path TEXT NOT NULL,
package_zip_path TEXT,
artifact_name TEXT,
state TEXT NOT NULL CHECK (state IN ('preparing', 'prepared', 'running', 'blocked', 'reported', 'completed')),
error_code TEXT,
error_message TEXT,
created_at TEXT NOT NULL,
updated_at TEXT NOT NULL,
UNIQUE(task_id, attempt)
~~~

createFeishuAutoCutRun runs inside the run-created callback immediately after the AI run row exists and before the Bridge refresh or manifest validation. It validates the task origin binding again, uses MAX(attempt) + 1 for that task in the same immediate transaction, and stores the server-owned result_path while the not-yet-created manifest, execution, draft-root, package-ZIP, and naming columns remain null. markFeishuAutoCutRunPrepared fills those nullable columns once after validation. A preparation failure updates the same row to blocked with its stable code, so the UI and explicit retry path always have a preserved attempt. Paths always point below the server-owned run root, except package_zip_path, which is explicitly created below the frozen package snapshot's realpath zipSourceDirectory and is checked against that source root at report time.

- [ ] **Step 5: Verify GREEN and commit**

~~~powershell
node --test test/feishu-source-manifest.test.mjs test/feishu-autocut-run-migration.test.mjs
git diff --check
~~~

Expected: canonical hashes are stable, invalid executable-like fields fail, legacy databases migrate, and one run cannot be rebound across tasks or stages.

~~~powershell
git add server/feishu-source-manifest.mjs server/database.mjs test/feishu-source-manifest.test.mjs test/feishu-autocut-run-migration.test.mjs
git commit -m "feat: persist Auto-Cut run source manifests"
~~~

---

### Task 5: Generate and Inject Run-Private Inputs

**Files:**
- Create: server/feishu-run-inputs.mjs
- Create: server/feishu-controlled-context-client.mjs
- Modify: server/app.mjs
- Modify: server/ai-chat.mjs
- Modify: server/ai-chat-process.mjs
- Modify: server/feishu-execution-coordinator.mjs
- Test: test/feishu-run-inputs.test.mjs
- Create: test/feishu-controlled-context-client.test.mjs
- Test: test/task-start-flow.test.mjs
- Test: test/feishu-execution-coordinator.test.mjs

**Interfaces:**
- readCurrentControlledContext({ bridgeUrl, bridgeSecret, origin, subjectVersion }) POSTs to `POST ${bridgeUrl}/api/feishu/workflow/controlled-context` with `{ subjectKey, configVersion, baseToken, tableId, recordId }` and returns only documentLinks, namingDisplayValue, and namingValueUnique.
- prepareFeishuRunInputs({ dataDirectory, task, run, origin, subjectVersion, packageSnapshot, controlledContext }) returns manifestPath, manifestSha256, executionInputPath, resultPath, packageZipPath, artifactName, stageDestinationPath, and attempt.
- runContext.sourceManifest contains path and sha256.
- runContext.executionInput contains path.
- runContext.autoCutBinding contains taskId, runId, subjectKey, configVersion, stageId, and eventId copied from the persisted immutable binding.
- A trusted local Codex process receives CODEX_AUTOCUT_SOURCE_MANIFEST_PATH, CODEX_AUTOCUT_SOURCE_MANIFEST_SHA256, and CODEX_AUTOCUT_EXECUTION_INPUT_PATH.
- The same process receives server-owned CODEX_AUTOCUT_JOB_ROOT, CODEX_AUTOCUT_DRAFTS_ROOT, CODEX_AUTOCUT_RESULT_PATH, and CODEX_AUTOCUT_PACKAGE_ZIP_PATH. `CODEX_AUTOCUT_JOB_ROOT`, `CODEX_AUTOCUT_DRAFTS_ROOT`, and `CODEX_AUTOCUT_RESULT_PATH` are created below the Taskboard data directory's run-private root. `CODEX_AUTOCUT_PACKAGE_ZIP_PATH` is a new run-specific child of the realpath of the frozen package snapshot's `zipSourceDirectory` (the existing driver-report allowlist); Taskboard creates that child before spawning Auto-Cut and rejects any package without an absolute configured source directory. The trusted runner invocation passes all four values explicitly (`--job-root`, `--drafts-root`, `--result-path`, and `--package-zip`), and the report route checks the ZIP against that same frozen source root. None comes from a Feishu cell.
- The same process receives CODEX_AUTOCUT_TASK_ID, CODEX_AUTOCUT_RUN_ID, CODEX_AUTOCUT_SUBJECT_KEY, CODEX_AUTOCUT_CONFIG_VERSION, CODEX_AUTOCUT_STAGE_ID, and CODEX_AUTOCUT_EVENT_ID from the immutable database binding. Auto-Cut compares all six with the manifest before any source read.
- No user-authored prompt contains the document URL, anchor text, naming value, report token, or local/NAS destination.
- executionRequestForTask always uses maxConcurrent 1 for phased Auto-Cut, regardless of a larger package value.

- [ ] **Step 1: Write failing run-input and process-environment tests**

~~~js
test("writes one immutable manifest and naming input under the run root", async () => {
  const result = await prepareFeishuRunInputs(fixture());
  assert.equal(
    JSON.parse(await readFile(result.manifestPath, "utf8")).binding.run_id,
    "run-1",
  );
  assert.deepEqual(
    JSON.parse(await readFile(result.executionInputPath, "utf8")),
    { schema_version: 1, artifact_name: "课程001_初稿" },
  );
  assert.equal(result.manifestSha256, sourceManifestSha256(
    JSON.parse(await readFile(result.manifestPath, "utf8")),
  ));
  assert.equal(path.dirname(result.resultPath), path.dirname(result.manifestPath));
  assert.equal(path.extname(result.packageZipPath), ".zip");
  assert.match(result.packageZipPath, /Approved[\\/]Initial[\\/]\.taskboard-autocut[\\/]task-1[\\/]run-1[\\/]课程001_初稿\.zip$/u);
  assert.match(result.draftsRoot, /autocut-runs[\\/]task-1[\\/]run-1[\\/]drafts$/u);
});

test("injects only server-owned input paths and digests", async () => {
  const spawn = await startTrustedTurn();
  assert.equal(spawn.env.CODEX_AUTOCUT_SOURCE_MANIFEST_SHA256, expectedDigest);
  assert.equal(spawn.env.CODEX_AUTOCUT_SOURCE_MANIFEST_PATH, expectedManifestPath);
  assert.equal(spawn.env.CODEX_AUTOCUT_EXECUTION_INPUT_PATH, expectedExecutionInputPath);
  assert.equal(spawn.env.CODEX_AUTOCUT_TASK_ID, "task-1");
  assert.equal(spawn.env.CODEX_AUTOCUT_RUN_ID, "run-1");
  assert.equal(spawn.env.CODEX_AUTOCUT_SUBJECT_KEY, "bas_demo:tbl_math");
  assert.equal(spawn.env.CODEX_AUTOCUT_CONFIG_VERSION, "7");
  assert.equal(spawn.env.CODEX_AUTOCUT_STAGE_ID, "initial");
  assert.equal(spawn.env.CODEX_AUTOCUT_EVENT_ID, "evt-1");
  assert.equal(spawn.env.CODEX_FEISHU_BRIDGE_SECRET, undefined);
  assert.doesNotMatch(spawn.prompt, /guanghe\.feishu\.cn|录屏|课程001|claim-token/u);
});

test("controlled-context refresh sends the immutable version and record identity", async () => {
  const response = await readCurrentControlledContext({
    bridgeUrl: bridge.url,
    bridgeSecret: "bridge-secret",
    origin: { subjectKey: "bas_demo:tbl_math", configVersion: 7, baseToken: "bas_demo", tableId: "tbl_math", recordId: "rec_1" },
    subjectVersion: { documentField: { fieldId: "fld_document_v7" }, namingField: { fieldId: "fld_name_v7" } },
  });
  assert.deepEqual(response, { documentLinks: ["https://guanghe.feishu.cn/docx/fixed"], namingDisplayValue: "课程001" });
  assert.deepEqual(lastBridgeRequest.body, {
    subjectKey: "bas_demo:tbl_math", configVersion: 7, baseToken: "bas_demo", tableId: "tbl_math", recordId: "rec_1",
  });
});

test("refreshes controlled fields for every attempt and preserves a blocked attempt", async () => {
  bridgeContexts.push(
    { documentLinks: [], namingDisplayValue: "" },
    { documentLinks: ["https://guanghe.feishu.cn/docx/fixed"], namingDisplayValue: "课程001" },
  );
  const first = await startPhasedAttempt(task.id);
  assert.equal(first.state, "blocked");
  assert.equal(first.errorCode, "document_link_missing");
  const second = await retryPhasedAttempt(task.id);
  assert.equal(second.attempt, 2);
  assert.equal(second.state, "prepared");
  assert.notEqual(first.runId, second.runId);
});
~~~

Add cases for initial, first_review, and final_review suffixes; a missing naming value; a document field with zero or two links; and a task origin whose stage/version no longer matches the stored immutable snapshot.
Add an automatic scheduling assertion that readyAt is approximately now + 5000 milliseconds and the task remains waiting until that deadline.

- [ ] **Step 2: Run tests and verify RED**

~~~powershell
node --test test/feishu-run-inputs.test.mjs test/feishu-controlled-context-client.test.mjs test/task-start-flow.test.mjs test/feishu-execution-coordinator.test.mjs
~~~

Expected: run input module and source manifest environment do not exist.

- [ ] **Step 3: Create the run-private files atomically**

Resolve the run root as dataDirectory/autocut-runs/{taskId}/{runId} and the draft root as dataDirectory/autocut-runs/{taskId}/{runId}/drafts. Resolve the frozen package snapshot's absolute zipSourceDirectory with realpath, verify it is a regular configured directory, and place the ZIP at {zipSourceDirectory}/.taskboard-autocut/{taskId}/{runId}/{sanitizedArtifactName}.zip. Validate every identifier and name segment, reject an existing different file, and never let a Feishu value choose any parent directory. Create the run and draft directories with owner-only permissions where supported, write temporary files with flag wx, fsync, then rename to source-manifest.json and execution_input.json.

Require controlledContext.documentLinks to contain exactly one official HTTPS Docx URL, controlledContext.namingValueUnique to be true, and controlledContext.namingDisplayValue to be non-empty after trimming. Build artifact_name by trimming controlledContext.namingDisplayValue, rejecting control-character values, and appending the frozen stage nameSuffix. Use all three only as inert manifest/execution data; do not interpolate them into the Codex instruction text.

- [ ] **Step 4: Integrate preparation into onRunCreated**

After bindTaskAiStartRun succeeds, reload task, trusted origin, immutable subject version, and package snapshot. Insert the preparing feishu_autocut_runs attempt first. Then call readCurrentControlledContext with the fixed CODEX_FEISHU_BRIDGE_URL and server-held CODEX_FEISHU_BRIDGE_SECRET, pass its result to prepareFeishuRunInputs, and atomically mark the attempt prepared before returning this context:

~~~js
return {
  artifactReport: {
    url: localArtifactReportUrl(task.id, createdRun.id),
    token: claimedTask.claimToken,
  },
  sourceManifest: {
    path: prepared.manifestPath,
    sha256: prepared.manifestSha256,
  },
  executionInput: {
    path: prepared.executionInputPath,
  },
  autoCutBinding: {
    taskId: task.id,
    runId: run.id,
    subjectKey: origin.subjectKey,
    configVersion: origin.configVersion,
    stageId: origin.stageId,
    eventId: origin.eventId,
  },
  autoCutRuntime: {
    jobRoot: path.dirname(prepared.manifestPath),
    draftsRoot: prepared.draftsRoot,
    resultPath: prepared.resultPath,
    packageZipPath: prepared.packageZipPath,
  },
};
~~~

If refresh or preparation fails, keep the just-created feishu_autocut_runs row and its AI run identity, mark the attempt and task blocked with the stable source error, clear its execution lease through the existing terminal failure path, and do not spawn Codex. Never delete or rewrite the failed attempt. The retry route runs this same refresh again, so correcting the Base document link or computed naming field is visible to the new run while the original stage configuration remains frozen.

- [ ] **Step 5: Inject environment and keep package-level editing serial**

Extend ai-chat.mjs validation so sourceManifest, executionInput, autoCutBinding, and autoCutRuntime are accepted only with taskClaimedByServer true and artifactReport present. Validate autoCutBinding against the current task/run before mapping it to the six immutable binding variables; add those plus the seven path/runtime variables (including CODEX_AUTOCUT_DRAFTS_ROOT) beside the existing report variables in the local spawn environment. Add this exact trusted instruction, with values supplied only through environment variables:

~~~text
python scripts/jy_wrapper.py review-document-run --source-manifest "$env:CODEX_AUTOCUT_SOURCE_MANIFEST_PATH" --execution-input "$env:CODEX_AUTOCUT_EXECUTION_INPUT_PATH" --job-root "$env:CODEX_AUTOCUT_JOB_ROOT" --drafts-root "$env:CODEX_AUTOCUT_DRAFTS_ROOT" --package-zip "$env:CODEX_AUTOCUT_PACKAGE_ZIP_PATH" --json
~~~

Require the process to read the successful JSON at `$env:CODEX_AUTOCUT_RESULT_PATH`, verify its `package_zip` path is exactly `$env:CODEX_AUTOCUT_PACKAGE_ZIP_PATH`, then invoke taskctl artifact report with that exact path. Keep the fixed package group autocut:{packageAlias}, but force maxConcurrent to 1 for an origin with stageId; upload concurrency remains in the upload worker and is not added as a resource group.

- [ ] **Step 6: Verify GREEN and commit**

~~~powershell
node --test test/feishu-run-inputs.test.mjs test/feishu-controlled-context-client.test.mjs test/task-start-flow.test.mjs test/feishu-execution-coordinator.test.mjs
git diff --check
~~~

Expected: the exact run paths and digest reach only the trusted process, two same-package phased runs serialize, and upload worker tests retain their existing concurrency.

~~~powershell
git add server/feishu-run-inputs.mjs server/feishu-controlled-context-client.mjs server/app.mjs server/ai-chat.mjs server/ai-chat-process.mjs server/feishu-execution-coordinator.mjs test/feishu-run-inputs.test.mjs test/feishu-controlled-context-client.test.mjs test/task-start-flow.test.mjs test/feishu-execution-coordinator.test.mjs
git commit -m "feat: inject run-scoped Auto-Cut source inputs"
~~~


---

### Task 6: Add Strict Source-Manifest Intake to Verified Auto-Cut Source

**Gate:** Run this task only in the source worktree proven in Task 0. Do not edit D:\codex\Auto-cut-lite or a dirty CopyA checkout.

**Files:**
- Modify in verified Auto-Cut source: scripts/cli/jy_wrapper_parser.py
- Create in verified Auto-Cut source: scripts/utils/source_manifest.py
- Modify in verified Auto-Cut source: scripts/utils/review_document_intake.py
- Modify in verified Auto-Cut source: scripts/utils/review_document_runner.py
- Test in verified Auto-Cut source: tests/test_source_manifest.py
- Test in verified Auto-Cut source: tests/test_review_document_intake.py
- Test in verified Auto-Cut source: tests/test_review_document_runner.py

**Interfaces:**
- review-document-run accepts exactly one of --doc-url, --snapshot-json, or --source-manifest.
- load_source_manifest(path) validates schema_version 1 and returns LoadedSourceManifest(data: dict, canonical_sha256: str).
- select_docx_section(parsed_document, anchor_text, configured_anchors) returns ordered text blocks and ordered attachment descriptors.
- fetch_base_attachment_source(manifest, source, destination, command_runner) reads one projected field and downloads exactly its one attachment.
- materialize_manifest_sources(manifest, job_root, command_runner) returns document metadata, ordered review items, ordered video paths, ordered audio paths, and per-file receipts.
- Every Feishu command is preceded by lark_whoami and requires available true, identity user, and defaultAs user.

- [ ] **Step 1: Write failing parser and schema tests**

~~~python
def test_parser_accepts_source_manifest_as_an_exclusive_input():
    args = build_parser().parse_args([
        "review-document-run",
        "--source-manifest", "source-manifest.json",
        "--job-root", "job",
        "--drafts-root", "drafts",
        "--package-zip", "out.zip",
    ])
    assert args.source_manifest_json == "source-manifest.json"

def test_source_manifest_rejects_binding_or_digest_changes(tmp_path):
    manifest_path = write_manifest(tmp_path, valid_manifest())
    loaded = load_source_manifest(manifest_path)
    assert loaded.data["binding"]["stage_id"] == "initial"
    changed = valid_manifest()
    changed["binding"]["run_id"] = "another-run"
    assert canonical_sha256(changed) != loaded.canonical_sha256

def test_heading_anchor_stops_before_the_next_configured_label():
    document = parsed_document([
        heading(2, "录屏"),
        attachment("video.mp4"),
        plain_text("录音"),
        attachment("voice.wav"),
    ])
    selected = select_docx_section(document, "录屏", {"录屏", "录音"})
    assert [item.filename for item in selected.attachments] == ["video.mp4"]
~~~

Also assert --source-manifest conflicts with --doc-url and --snapshot-json, JSON mode still requires --project-json, unknown keys fail, and the Taskboard-provided SHA environment must equal the canonical manifest digest.

- [ ] **Step 2: Run focused tests and verify RED**

~~~powershell
python -m pytest tests/test_source_manifest.py tests/test_review_document_intake.py tests/test_review_document_runner.py -q
~~~

Expected: --source-manifest and source_manifest.py do not exist.

- [ ] **Step 3: Implement strict manifest loading and job identity**

Read the manifest once from an absolute regular file into LoadedSourceManifest(data: dict, canonical_sha256: str), require task_id, run_id, subject_key, config_version, stage_id, and event_id to match CODEX_AUTOCUT_TASK_ID, CODEX_AUTOCUT_RUN_ID, CODEX_AUTOCUT_SUBJECT_KEY, CODEX_AUTOCUT_CONFIG_VERSION, CODEX_AUTOCUT_STAGE_ID, and CODEX_AUTOCUT_EVENT_ID, calculate canonical SHA-256, and compare it with CODEX_AUTOCUT_SOURCE_MANIFEST_SHA256 using hmac.compare_digest. Do not follow a manifest path from document content.

Add these fields to review_document_runner job_identity before input_digest is calculated:

~~~python
job_identity = {
    **job_identity,
    "source_manifest_sha256": source_manifest.canonical_sha256,
    "task_id": source_manifest.data["binding"]["task_id"],
    "run_id": source_manifest.data["binding"]["run_id"],
    "stage_id": source_manifest.data["binding"]["stage_id"],
    "config_version": source_manifest.data["binding"]["config_version"],
}
~~~

A different document field, anchor, attachment field, stage, version, task, or run therefore cannot hit an older input cache.

- [ ] **Step 4: Select exact Docx ranges without whole-document media guessing**

Reuse fetch_lark_document and parse_lark_document only for fetching/XML parsing. Add top-level block metadata sufficient to identify heading level, standalone text labels, attachment position, and source text. Match anchor_text after trimming only leading and trailing whitespace. Zero matches raises docx_anchor_missing; multiple matches raises docx_anchor_ambiguous.

For every anchor type, stop before the next configured anchor label. A heading anchor also stops at the next heading of the same or higher level; a standalone plain or bold text anchor also stops at the next heading that ends its containing section. Use the earliest applicable boundary, preserve attachment order by document position, and exclude the boundary block itself. The video selector receives only the configured video range, the audio selector only its range, and review compilation only the review range. Never call the existing whole-document source-video score or byte-size tie-breaker for manifest mode.

- [ ] **Step 5: Add exact user-identity Base attachment reads**

Use lark-cli with these read-only calls through the existing command runner:

~~~text
lark-cli whoami
lark-cli base +record-get --base-token VALUE --table-id VALUE --record-id VALUE --field-id VALUE --format json
lark-cli base +record-download-attachment --base-token VALUE --table-id VALUE --record-id VALUE --file-token VALUE --output RUN_PRIVATE_PATH --format json
~~~

Parse exactly the configured field. Empty or more than one attachment raises base_attachment_count_mismatch. Download only the returned file_token, preserve the provider file name, add a numeric suffix for a same-run collision, verify a regular non-empty file, and record MIME, extension, byte size, SHA-256, field ID, and token digest. Do not expose the token in public errors.

- [ ] **Step 6: Classify ordered media and review content**

Classify with provider MIME first and a recognized extension second. A video source range containing no video or any unclassifiable attachment raises video_source_invalid. In replace_original, an audio range containing no audio or any unclassifiable attachment raises audio_source_invalid. In video_original, do not read the configured audio source at all.

Create review items only from the exact review range. Empty meaningful review content raises review_source_empty. Document text becomes structured review input; it is never passed to a shell or the Codex outer prompt.

- [ ] **Step 7: Verify GREEN and commit**

~~~powershell
python -m pytest tests/test_source_manifest.py tests/test_review_document_intake.py tests/test_review_document_runner.py -q
git diff --check
~~~

Expected: manifest mode uses strict user identity, exact sections and fields, retains document order, and never invokes whole-document candidate selection.

~~~powershell
git add scripts/cli/jy_wrapper_parser.py scripts/utils/source_manifest.py scripts/utils/review_document_intake.py scripts/utils/review_document_runner.py tests/test_source_manifest.py tests/test_review_document_intake.py tests/test_review_document_runner.py
git commit -m "feat: read phased Feishu sources from manifests"
~~~

---

### Task 7: Support Ordered Media Pairs, Sound Modes, Naming, and Exact ZIP Receipts

**Gate:** Run this task in the same verified Auto-Cut source worktree as Task 6.

**Files:**
- Modify: scripts/utils/review_document_runner.py
- Modify: scripts/review_job.py
- Modify: scripts/utils/review_job_compiler.py
- Modify: scripts/utils/revision_models.py
- Modify: scripts/utils/lite_revision.py
- Modify: scripts/utils/review_job_pipeline.py
- Test: tests/test_review_document_runner.py
- Test: tests/test_review_job_compiler.py
- Test: tests/test_revision_models.py
- Test: tests/test_lite_revision.py
- Test: tests/test_review_job_pipeline.py

**Interfaces:**
- Manifest-mode project JSON contains source_pairs as an ordered non-empty array.
- Each pair contains video_path, video_sha256, and either audio_mode video_original or replacement_audio_path plus replacement_audio_sha256.
- validate_source_pairs(project, tolerance_seconds, ffprobe) returns probed durations or raises media_count_mismatch or media_duration_mismatch.
- The editable Lite draft retains one source material and visible segment boundary for every pair.
- Successful JSON contains the same absolute ZIP path and SHA-256 in data.package_zip, data.output_artifacts.package_zip, and the package receipt.
- Every terminal invocation atomically writes the exact CODEX_AUTOCUT_RESULT_PATH with its binding, manifest digest, status, and either package data or a stable failure code.

- [ ] **Step 1: Write failing pairing and sound-mode tests**

~~~python
def test_manifest_media_pairs_keep_document_order():
    project = compile_manifest_project(
        videos=[media("v2.mp4"), media("v1.mp4")],
        audios=[media("a2.wav"), media("a1.wav")],
        mode="replace_original",
        tolerance_seconds=3,
    )
    assert [
        (Path(row["video_path"]).name, Path(row["replacement_audio_path"]).name)
        for row in project["source_pairs"]
    ] == [("v2.mp4", "a2.wav"), ("v1.mp4", "a1.wav")]

def test_pair_count_and_duration_mismatch_block():
    with pytest.raises(SourceManifestError, match="media_count_mismatch"):
        compile_manifest_project(videos=[media("v1.mp4"), media("v2.mp4")], audios=[media("a1.wav")], mode="replace_original")
    with pytest.raises(SourceManifestError, match="media_duration_mismatch"):
        validate_source_pairs(project_with_durations(10.0, 14.1), 3.0, fake_probe)

def test_terminal_failure_writes_a_bound_taskboard_result(tmp_path, monkeypatch):
    result_path = tmp_path / "taskboard-result.json"
    monkeypatch.setenv("CODEX_AUTOCUT_RESULT_PATH", str(result_path))
    response = run_manifest_job_with_missing_anchor()
    assert response["ok"] is False
    saved = json.loads(result_path.read_text(encoding="utf-8"))
    assert saved["binding"]["run_id"] == "run-1"
    assert saved["status"] == "blocked"
    assert saved["error"]["code"] == "docx_anchor_missing"
~~~

Add video_original coverage proving no external audio call occurs, custom tolerance coverage, duplicate file-name numbering, and the single-video/single-audio case.

- [ ] **Step 2: Run focused tests and verify RED**

~~~powershell
python -m pytest tests/test_review_document_runner.py tests/test_review_job_compiler.py tests/test_revision_models.py tests/test_lite_revision.py tests/test_review_job_pipeline.py -q
~~~

Expected: project schema supports one source_video only and manifest source_pairs are unsupported.

- [ ] **Step 3: Add ordered source_pairs to the project/compiler model**

For one or many videos, create source_pairs directly from manifest order. replace_original requires equal non-zero video/audio counts; video_original creates one pair per video and omits replacement audio. Probe every pair with the existing ffprobe adapter. A replacement duration whose absolute difference exceeds duration_tolerance_seconds raises media_duration_mismatch with only pair index and measured durations.

Keep compatibility source_video and source_audio fields for non-manifest invocations. Manifest mode must use source_pairs as authoritative and must not sort by path, name, size, mtime, or duration.

- [ ] **Step 4: Preserve editable JianYing materials and boundaries**

Extend revision_models and lite_revision so each source pair becomes distinct source material rows and consecutive editable timeline segments. In replace_original, mute each video's embedded audio and place the matching replacement audio on the editable audio lane. In video_original, retain the video's own audio material. Add one trace marker per source pair boundary and preserve all existing review-item markers.

Validation fails if source pair count, order, SHA-256, segment boundaries, or replacement-audio references differ between the compiled request and saved draft. Do not flatten the sequence into one rendered video/audio file.

- [ ] **Step 5: Apply the externally supplied artifact name**

Load only the Taskboard execution_input.json path from CODEX_AUTOCUT_EXECUTION_INPUT_PATH or the explicit --execution-input argument. Its artifact_name controls both the JianYing draft directory and ZIP base name through the existing resolve_artifact_name sanitizer. Record requested_name, final_name, and whether sanitization occurred in the receipt. Do not derive the name from source media names or the document title when manifest mode is active.

- [ ] **Step 6: Return the exact accepted package path and digest**

After editable-draft validation and ZIP CRC/structure validation succeed, calculate the ZIP SHA-256 once and write:

~~~python
data["package_zip"] = str(package_path.resolve())
data["archive_sha256"] = archive_sha256
data["output_artifacts"]["package_zip"] = str(package_path.resolve())
data["output_artifacts"]["archive_sha256"] = archive_sha256
~~~

Write the same path, archive_sha256, manifest digest, task/run/stage binding, draft name, source-pair receipts, and validation result to the adjacent package receipt. A failed validation returns no successful package_zip field.

For every terminal success or failure, atomically write taskboard-result.json to the exact server-owned CODEX_AUTOCUT_RESULT_PATH. Success includes the same package path and archive SHA-256. Failure includes only the manifest binding, digest, status blocked, stable error code, sanitized message, and public details; it contains no credentials, attachment tokens, source text, or local paths other than the server-owned result/package paths. Taskboard never locates this file by directory enumeration.

- [ ] **Step 7: Verify GREEN and commit**

~~~powershell
python -m pytest tests/test_review_document_runner.py tests/test_review_job_compiler.py tests/test_revision_models.py tests/test_lite_revision.py tests/test_review_job_pipeline.py -q
git diff --check
~~~

Expected: ordered pairs remain editable, sound mode is correct, duration/count failures block, naming is external, and success identifies exactly one ZIP without directory enumeration.

~~~powershell
git add scripts/utils/review_document_runner.py scripts/review_job.py scripts/utils/review_job_compiler.py scripts/utils/revision_models.py scripts/utils/lite_revision.py scripts/utils/review_job_pipeline.py tests/test_review_document_runner.py tests/test_review_job_compiler.py tests/test_revision_models.py tests/test_lite_revision.py tests/test_review_job_pipeline.py
git commit -m "feat: build editable drafts from ordered source pairs"
~~~

---

### Task 8: Bind Driver Reports to the Manifest Run and Add Explicit Retry

**Files:**
- Modify: cli/taskctl.mjs
- Modify: server/app.mjs
- Modify: server/database.mjs
- Modify: server/feishu-execution-coordinator.mjs
- Modify: web/src/api.ts
- Modify: web/src/types.ts
- Test: test/cli.test.mjs
- Test: test/artifact-upload-queue.test.mjs
- Test: test/task-start-flow.test.mjs
- Test: test/feishu-execution-coordinator.test.mjs
- Create: test/feishu-autocut-retry.test.mjs

**Interfaces:**
- taskctl artifact report continues to accept --file PATH; it sends manifestSha256 only when the trusted phased-run environment includes CODEX_AUTOCUT_SOURCE_MANIFEST_SHA256, while legacy/manual bodies remain unchanged.
- The artifact-report route revalidates run binding against feishu_autocut_runs before opening the ZIP and again in the artifact transaction.
- GET /api/local/tasks/:id/autocut-runs returns sanitized ordered attempts for the local Taskboard UI.
- POST /api/local/tasks/:id/autocut-retry with version creates a retry execution only for a blocked trusted phased task.
- Retry trigger is stored as retry, creates a new AI run and attempt, and retains all older runs, manifests, receipts, and artifacts.
- upload destination comes from the frozen stage artifactTargetPath; upload target identity and worker concurrency remain the subject-wide values.

- [ ] **Step 1: Write failing report-binding and retry tests**

~~~js
test("a report must match the prepared manifest run", async () => {
  const run = await createPreparedRun();
  const response = await reportArtifact(run, {
    path: acceptedZip,
    sha256: zipSha256,
    manifestSha256: run.manifestSha256,
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.artifact.runId, run.runId);
  assert.equal(database.getFeishuAutoCutRun(run.runId).state, "reported");

  const crossed = await reportArtifact(run, {
    path: acceptedZip,
    sha256: zipSha256,
    manifestSha256: anotherRun.manifestSha256,
  });
  assert.equal(crossed.status, 409);
  assert.equal(crossed.body.error.code, "AUTOCUT_RUN_BINDING_MISMATCH");
});

test("explicit retry creates a new run attempt and keeps the old one", async () => {
  const blocked = await createBlockedPhasedTask();
  const retry = await requestRetry(blocked.id, blocked.version);
  assert.equal(retry.status, 202);
  await waitForAutoCutAttempts(blocked.id, 2);
  const attempts = database.listFeishuAutoCutRuns(blocked.id);
  assert.deepEqual(attempts.map((row) => row.attempt), [1, 2]);
  assert.equal(attempts[0].state, "blocked");
  assert.notEqual(attempts[0].runId, attempts[1].runId);
});

test("legacy and manual driver reports keep the existing exact-file body", async () => {
  const request = await reportArtifact({ file: exactZip }, legacyReportEnvironment());
  assert.deepEqual(JSON.parse(request.body), {
    path: path.resolve(exactZip),
    sha256: await sha256File(exactZip),
  });
});
~~~

Also test a normal task, legacy Feishu task, non-blocked task, wrong version, cross-task token, cross-stage digest, and automatic retry without button action. Each must fail without starting or registering an artifact.

- [ ] **Step 2: Run tests and verify RED**

~~~powershell
node --test test/cli.test.mjs test/artifact-upload-queue.test.mjs test/task-start-flow.test.mjs test/feishu-execution-coordinator.test.mjs test/feishu-autocut-retry.test.mjs
~~~

Expected: the report body has no manifest digest, the artifact route does not join feishu_autocut_runs, and the retry route does not exist.

- [ ] **Step 3: Extend the exact-file report without discovery behavior**

Keep the existing --file requirement and streaming SHA-256 calculation. Add manifestSha256 only when the server injected CODEX_AUTOCUT_SOURCE_MANIFEST_SHA256 for a trusted phased run:

~~~js
const body = { path: resolvedFile, sha256: await sha256File(resolvedFile) };
if (env.CODEX_AUTOCUT_SOURCE_MANIFEST_SHA256 !== undefined) {
  body.manifestSha256 = requireSha256(
    env.CODEX_AUTOCUT_SOURCE_MANIFEST_SHA256,
    "CODEX_AUTOCUT_SOURCE_MANIFEST_SHA256",
  );
}
~~~

Do not invoke readdir, glob, mtime comparison, filename inference, runtime discovery, or a fallback path. A legacy/manual process without the manifest environment sends the exact existing { path, sha256 } body unchanged.

- [ ] **Step 4: Revalidate ownership before storing the artifact**

The driver route remains POST /api/local/tasks/:taskId/runs/:runId/artifact-report; the task ID and run ID come only from the server-injected URL, not the JSON body. For a phased trusted run, require all of these to agree: task ID in route, run ID in route, active claim token, AI thread/run ownership, trusted origin taskId, subjectKey, configVersion, stageId, eventId, stored manifest SHA-256, body manifestSha256, package snapshot, exact source root, report SHA-256, ZIP bytes, ZIP CRC/structure, and expected sanitized draft/ZIP name. For a legacy/manual driver_report run with no feishu_autocut_runs row, preserve the existing route validation and { path, sha256 } contract; do not require a manifest digest.

Use one transaction to re-read the binding, insert or idempotently return the one driver_report artifact for the run, link it to task completion when appropriate, and mark the run reported. Different bytes or a different manifest for a previously reported run raises ARTIFACT_RUN_CONFLICT.

- [ ] **Step 5: Preserve automatic and manual completion semantics**

After the Codex run terminates, read only that run's stored result_path and validate its binding and manifest digest. A bound blocked result stores its stable error and moves the task to blocked; a missing or malformed result uses autocut_result_missing or autocut_result_invalid. A successful result must match the same run's verified artifact. automatic then moves to done and, only when the frozen enqueueMode is automatic, creates one upload row for that exact artifact using the stage artifactTargetPath. manual moves to in_review and does not auto-enqueue. A report received before run completion remains in_progress until reconciliation; a completed run without a valid result/report becomes blocked with an observable reason.

- [ ] **Step 6: Add explicit retry**

Accept retry only through the loopback local route for a non-archived blocked task with a phased trusted origin and optimistic version match. Keep the task ID and immutable stage configuration. Clear only the active execution lease, create a retry execution with a new run/attempt and run directory, and move the task into the existing queued/processing flow. Do not delete or mutate prior feishu_autocut_runs, result files, or task_artifacts rows, and do not retry automatically after a material or validation failure.

- [ ] **Step 7: Verify GREEN and commit**

~~~powershell
node --test test/cli.test.mjs test/artifact-upload-queue.test.mjs test/task-start-flow.test.mjs test/feishu-execution-coordinator.test.mjs test/feishu-autocut-retry.test.mjs
git diff --check
~~~

Expected: only the exact prepared run accepts the report, automatic and manual diverge as specified, destination is stage-specific, and explicit retry creates a new preserved attempt.

~~~powershell
git add cli/taskctl.mjs server/app.mjs server/database.mjs server/feishu-execution-coordinator.mjs web/src/api.ts web/src/types.ts test/cli.test.mjs test/artifact-upload-queue.test.mjs test/task-start-flow.test.mjs test/feishu-execution-coordinator.test.mjs test/feishu-autocut-retry.test.mjs
git commit -m "feat: retry and complete manifest-bound Auto-Cut runs"
~~~


---

### Task 9: Add Stage Configuration and Run Recovery UI

**Files:**
- Create: web/src/components/FeishuStageEditor.tsx
- Create: web/src/components/AutoCutRunSummary.tsx
- Modify: web/src/components/FeishuWorkflowPanel.tsx
- Modify: web/src/components/TaskDetail.tsx
- Modify: web/src/App.tsx
- Modify: web/src/styles.css
- Modify: web/src/types.ts
- Modify: web/src/api.ts
- Modify: package.json
- Create: web/src/components/FeishuWorkflowPanel.test.tsx
- Create: web/src/components/AutoCutRunSummary.test.tsx
- Modify: test/feishu-workflow-ui.test.mjs

**Interfaces:**
- FeishuStageEditor receives stageId, value, metadataFields, statusOptions, disabled, onChange, and validationErrors.
- AutoCutRunSummary receives task, attempts, retrying, and onRetry.
- getTaskAutoCutRuns(taskId) returns ordered immutable attempts.
- getTaskAutoCutRuns(taskId) calls GET /api/local/tasks/:id/autocut-runs.
- retryTaskAutoCut(taskId, version) calls POST /api/local/tasks/:id/autocut-retry and returns the updated task plus execution.
- The configuration form saves the exact server contract from Task 1.

- [ ] **Step 1: Write failing component interaction tests**

~~~tsx
it("keeps three fixed stages and requires one enabled stage", async () => {
  render(<FeishuWorkflowPanel {...propsWithSubject()} />);
  expect(screen.getByText("初稿")).toBeVisible();
  expect(screen.getByText("初审修改")).toBeVisible();
  expect(screen.getByText("终审修改")).toBeVisible();
  await user.click(screen.getByRole("checkbox", { name: "启用初稿" }));
  await user.click(screen.getByRole("checkbox", { name: "启用初审修改" }));
  await user.click(screen.getByRole("checkbox", { name: "启用终审修改" }));
  expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
  expect(screen.getByText("至少启用一个阶段")).toBeVisible();
});

it("shows the blocked attempt and sends an explicit retry", async () => {
  render(<AutoCutRunSummary task={blockedTask} attempts={[blockedAttempt]} onRetry={onRetry} />);
  expect(screen.getByText("docx_anchor_missing")).toBeVisible();
  expect(screen.getByText("run-1")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "重试 Auto-Cut" }));
  expect(onRetry).toHaveBeenCalledWith(blockedTask.id, blockedTask.version);
});
~~~

Also test trigger options come only from the selected status field, replace_original reveals and requires an audio source, video_original hides it, every stage retains its own source/suffix/destination values, and disabled stages are not removed.

- [ ] **Step 2: Run component tests and verify RED**

~~~powershell
npx vitest run web/src/components/FeishuWorkflowPanel.test.tsx web/src/components/AutoCutRunSummary.test.tsx --environment jsdom
node --test test/feishu-workflow-ui.test.mjs
~~~

Expected: new components and APIs do not exist.

- [ ] **Step 3: Build the common field selectors and fixed stage editors**

At the top of the existing subject configuration, render compact selectors for status field, document-link field, and naming field. After a status field is selected, list only that field's actual single-select options in each stage trigger menu.

Render the three stages in their fixed order as unframed collapsible sections. Each section has a checkbox toggle, trigger option menu, video source kind and field/anchor controls, review anchor, sound-mode segmented control, conditional audio source and numeric tolerance input, stage destination path, and name suffix. Use existing semantic icons and form styling. Keep control dimensions stable and let long field names wrap without overlapping.

- [ ] **Step 4: Apply client validation without inventing execution policy**

Disable save when no stage is enabled, enabled option IDs collide, a required source field/anchor is empty, replace_original has no audio source, tolerance is not positive, a suffix is empty, or a stage destination is empty for automatic upload. Show the server error code/message unchanged enough to diagnose stale metadata. The server remains authoritative.

- [ ] **Step 5: Show run binding, blocking reason, and retry**

Load attempts when TaskDetail opens for a phased trusted task. Show stage label, attempt, run ID, manifest digest prefix, state, and stable blocking reason in AutoCutRunSummary. Render one Retry Auto-Cut command button only when the task is blocked and no retry is pending. Disable it during the request and refresh task/runs after a 202 response.

Do not expose the report token, document URL, attachment tokens, full local source path, or source text in this view.

- [ ] **Step 6: Add the component tests to the repository test command**

Change test:components so it includes MarkdownDocument.test.tsx, FeishuWorkflowPanel.test.tsx, and AutoCutRunSummary.test.tsx under jsdom. Do not broaden it to unrelated browser packaging.

- [ ] **Step 7: Verify GREEN, build the UI, and commit**

~~~powershell
npx vitest run web/src/components/FeishuWorkflowPanel.test.tsx web/src/components/AutoCutRunSummary.test.tsx --environment jsdom
node --test test/feishu-workflow-ui.test.mjs
npm run typecheck
npm run build:web
git diff --check
~~~

Expected: component tests, typecheck, and Web build pass. The built UI has three fixed stages, independent controls, visible blocked-run evidence, and one explicit retry action.

~~~powershell
git add web/src/components/FeishuStageEditor.tsx web/src/components/AutoCutRunSummary.tsx web/src/components/FeishuWorkflowPanel.tsx web/src/components/TaskDetail.tsx web/src/App.tsx web/src/styles.css web/src/types.ts web/src/api.ts package.json web/src/components/FeishuWorkflowPanel.test.tsx web/src/components/AutoCutRunSummary.test.tsx test/feishu-workflow-ui.test.mjs
git commit -m "feat: configure and retry phased Auto-Cut runs"
~~~

---

### Task 10: Document, Verify, Demonstrate, and Review the Complete Path

**Files:**
- Modify: README.md
- Modify: D:\codex\worktrees\feishu-autocut-bridge\README.md
- Modify in verified Auto-Cut source: README.md
- Create in verified Auto-Cut source: docs/source-manifest.md
- Modify focused tests only if direct verification exposes a concrete defect in the implemented path.

**Interfaces:**
- Documentation names the same stage IDs, source kinds, sound modes, environment variables, API statuses, error codes, and success JSON fields implemented above.
- The demo uses a dedicated test subject/record and never resumes FEI-10.
- Review inputs are public PR URLs plus exact head SHAs only; no credentials, local paths, document contents, or private tokens are submitted.

- [ ] **Step 1: Update Taskboard and Bridge README sections**

Document:

1. Selecting one status field and its actual options for initial, first_review, and final_review.
2. Independent stage toggles, sources, sound modes, 3-second default tolerance, suffixes, and destination paths.
3. Exact-trimmed Docx anchors, descendant range rules, document-order pairing, and unique Base attachment behavior.
4. Frozen task/run configuration, approximately five-second automatic delay, package concurrency 1, and independent upload concurrency.
5. Stage blocking and explicit Retry Auto-Cut creating a new retained run.
6. Dedicated Bridge route trust, user identity for Auto-Cut reads, no Feishu write-back, no cell-to-path/command/prompt conversion, and no artifact discovery by directory recency.
7. Existing manual behavior and exact driver_report behavior.

- [ ] **Step 2: Document the Auto-Cut manifest CLI and receipt**

Include this source-worktree invocation contract without real local paths or tokens (the packaged deployment uses the equivalent installed command path, but never changes the input contract):

~~~powershell
python scripts/jy_wrapper.py review-document-run --source-manifest $env:CODEX_AUTOCUT_SOURCE_MANIFEST_PATH --execution-input $env:CODEX_AUTOCUT_EXECUTION_INPUT_PATH --job-root $env:CODEX_AUTOCUT_JOB_ROOT --drafts-root $env:CODEX_AUTOCUT_DRAFTS_ROOT --result-path $env:CODEX_AUTOCUT_RESULT_PATH --package-zip $env:CODEX_AUTOCUT_PACKAGE_ZIP_PATH --json
~~~

State that successful callers must read data.package_zip or data.output_artifacts.package_zip and archive_sha256 from that same JSON response, verify the adjacent receipt, and report exactly that file. State that source-manifest mode requires Feishu default user identity and never falls back to whole-document media ranking.

- [ ] **Step 3: Run focused automated verification across all three repositories**

~~~powershell
Push-Location 'D:\codex\worktrees\feishu-autocut-taskboard'
node --test test/workflow-config.test.mjs test/feishu-workflow-api.test.mjs test/feishu-task-origin-api.test.mjs test/feishu-stage-registration.test.mjs test/feishu-origin-stage-migration.test.mjs test/feishu-source-manifest.test.mjs test/feishu-autocut-run-migration.test.mjs test/feishu-run-inputs.test.mjs test/feishu-controlled-context-client.test.mjs test/task-start-flow.test.mjs test/feishu-execution-coordinator.test.mjs test/artifact-upload-queue.test.mjs test/feishu-autocut-retry.test.mjs test/cli.test.mjs
npm run typecheck
npm run build:web
Pop-Location
Push-Location 'D:\codex\worktrees\feishu-autocut-bridge'
node --test test/workflow-config.test.mjs test/feishu-base-metadata.test.mjs test/feishu-event.test.mjs test/decide-event.test.mjs test/bridge.test.mjs test/state-store.test.mjs test/feishu-record-reader.test.mjs test/server.test.mjs test/taskboard-context-server.test.mjs
Pop-Location
Push-Location 'D:\codex\worktrees\feishu-autocut-autocut'
python -m pytest tests/test_source_manifest.py tests/test_review_document_intake.py tests/test_review_document_runner.py tests/test_review_job_compiler.py tests/test_revision_models.py tests/test_lite_revision.py tests/test_review_job_pipeline.py -q
Pop-Location
~~~

Expected: all listed tests pass, TypeScript reports no errors, and the Web build succeeds. Run the first Node commands from D:\codex\worktrees\feishu-autocut-taskboard, the Bridge command from D:\codex\worktrees\feishu-autocut-bridge, and the Python commands from D:\codex\worktrees\feishu-autocut-autocut; do not point tests at the installed Auto-Cut deployment.

Commit the verified documentation changes:

~~~powershell
git -C 'D:\codex\worktrees\feishu-autocut-taskboard' add README.md
git -C 'D:\codex\worktrees\feishu-autocut-taskboard' commit -m "docs: explain phased Auto-Cut handoff"
git -C 'D:\codex\worktrees\feishu-autocut-bridge' add README.md
git -C 'D:\codex\worktrees\feishu-autocut-bridge' commit -m "docs: explain phased Auto-Cut routing"
git -C 'D:\codex\worktrees\feishu-autocut-autocut' add README.md docs/source-manifest.md
git -C 'D:\codex\worktrees\feishu-autocut-autocut' commit -m "docs: document source manifest intake"
~~~

- [ ] **Step 4: Build an isolated Auto-Cut package candidate without installation**

From the verified clean Auto-Cut source worktree:

~~~powershell
$autoCutWorktree = 'D:\codex\worktrees\feishu-autocut-autocut'
$autoCutBuildRoot = 'D:\codex\worktrees\feishu-autocut-build'
$autoCutArchive = Join-Path $autoCutBuildRoot 'auto-cut-lite-1.6.5+codex.20260903020653-windows-x64.zip'
if (Test-Path -LiteralPath $autoCutBuildRoot) { throw "Build output already exists: $autoCutBuildRoot" }
python (Join-Path $autoCutWorktree 'scripts\release\build_lite_plugin.py') --repo-root $autoCutWorktree --output $autoCutArchive --json
if ($LASTEXITCODE -ne 0) { throw 'Auto-Cut Lite package build failed' }
~~~

Expected: the command succeeds with a privacy-checked ZIP and adjacent .zip.receipt.json tied to the exact clean source head. Read archive_path and receipt_path from its JSON output. Do not overwrite D:\codex\Auto-cut-lite or any registered production package during this step.

- [ ] **Step 5: Start isolated Taskboard and Bridge runtimes**

Use repository-supported isolated runtime descriptors, unused loopback ports, an isolated Taskboard data directory, an isolated Bridge state directory, and a separate browser/CDP profile. Register the clean Auto-Cut candidate or its source worktree as a test-only package with maxConcurrent 1. Do not stop or replace the coordinator-owned installed runtime, descriptor, Launcher, or user-data profile.

Expected: both test services report 127.0.0.1 listeners, the test package snapshot resolves, and the production Taskboard/Bridge remain unchanged.

- [ ] **Step 6: Demonstrate the successful real operation path**

In a dedicated test Base subject, configure one enabled stage against a real status field, one Docx field, one naming field, exact video/review anchors, and a safe test destination. Move a test record from another option into the configured option and capture:

1. Bridge event ID, before/after option IDs, subject/version/stage decision, and one registration response.
2. Taskboard task origin, delayed then running state, run/attempt, manifest digest, and package lease.
3. Auto-Cut user identity receipt, Docx revision, selected ordered sources, editable draft validation, exact package_zip, and archive_sha256.
4. driver_report artifact ID bound to the same task/run.
5. automatic task completion and exactly one upload row when enqueueMode is automatic.

The proof is the real product path and its durable records, not merely passing tests. Do not use FEI-10.

- [ ] **Step 7: Demonstrate one real fail-closed and retry path**

Use the same test subject with a missing anchor or ambiguous matching anchor. Trigger a fresh status edge and verify: the task becomes blocked, Auto-Cut produces no accepted ZIP, no artifact or upload row is created, and the UI shows the stable reason. Correct the test document (and, in a separate retry fixture, replace an empty/invalid current document-link or naming field while leaving the frozen stage configuration unchanged), click Retry Auto-Cut once, and verify a new run/attempt calls the controlled-context endpoint with the immutable subject version, refreshes the current document link and computed naming result, succeeds, and leaves the blocked run and its manifest visible.

Separately rely on the automated boundary test to prove that an ordinary task/description marker cannot receive automatic execution or artifact capability; do not forge requests against production data.

- [ ] **Step 8: Present the working demo for user confirmation**

Open the isolated Taskboard in the Codex App and show the stage configuration, successful run binding, blocked/retry evidence, and resulting upload row. Report changed files, commits, exact heads, commands/results, candidate package receipt, and known limitation that editing remains serialized per package.

Because the UI and external-boundary behavior are substantial, pause here for the user's functional and visual confirmation. Do not start Pro review before that confirmation.

- [ ] **Step 9: Open PRs and run required review after confirmation**

Push one coherent feature branch per repository and open linked PRs. For each stable PR head, provide ChatGPT web Pro only the public PR URL, exact SHA, and this instruction:

    Review implementation correctness and real bugs for the approved phased Feishu Auto-Cut source handoff. Do not recommend speculative guardrails, unrelated refactors, compatibility layers, style preferences, or scope expansion.

Wait for each complete review, fix actionable blockers in its owning branch, rerun the affected direct path, and decide whether a changed high-risk head needs another Pro review. Close temporary review tabs afterward.

- [ ] **Step 10: Record final handoff without merging or releasing**

Record in the Taskboard issue or implementation record: changed files, commits, exact head SHAs, PRs, CI states, direct success/failure evidence, review decision/result, Auto-Cut provenance, and remaining limitations. Move an implementation issue to in_review only after required review passes. Do not merge, release, mark done, resume FEI-10, install over production, or remove branches/worktrees without separate user authorization.
