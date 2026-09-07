# Feishu Auto-Cut Run Consent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry the user's explicit ASR and configured-output consent from one trusted phased Auto-Cut retry into only that run's private Codex context, then complete the FEI-3 real path.

**Architecture:** Extend the existing retry body with an optional, closed `runConsent` object containing two required `true` booleans. Keep it only on the in-memory coordinator entry, bind it to the newly created server-claimed run, and render server-owned constant text inside `<taskboard_context>`; never copy user text, comments, Feishu cells, paths, or service names from the request. Existing retries without consent remain unchanged.

**Tech Stack:** Node.js ESM, built-in `node:test`, Taskboard HTTP server, in-process Feishu execution coordinator, Codex subprocess prompt builder.

## Global Constraints

- Work only on branch `codex/feishu-autocut-workflow` in `D:\codex\dashi-taskboard`; preserve the unrelated untracked `pip/` directory.
- Taskboard and Feishu Bridge continue listening only on `127.0.0.1`; do not add Feishu writeback.
- Do not treat Feishu cells, Taskboard comments, task descriptions, or request free text as a path, command, prompt, consent, or executable input.
- Only a server-registered, blocked phased Feishu Auto-Cut task may use consent on the retry route.
- Omitted `runConsent` preserves the current retry behavior; a supplied object must contain exactly two `true` booleans and no unknown fields.
- Consent is run-private and memory-only. It is not persisted, inherited, added to environment variables, or written into package/subject configuration.
- Do not scan an output directory or select a newest ZIP. Verify only the run-bound result and exact `driver_report` artifact.
- Do not merge, release, or mark the task done before user acceptance.

---

### Task 1: Render Consent Only In Trusted Run-Private Prompt Context

**Files:**
- Modify: `test/ai-chat-process-autocut.test.mjs`
- Modify: `server/ai-chat-process.mjs`
- Modify: `server/ai-chat.mjs`

**Interfaces:**
- Consumes: `runContext.autoCutRunConsent` returned by the server-owned `onRunCreated` callback.
- Produces: `buildCodexPrompt(..., { autoCutRunConsent })`, which emits only fixed consent sentences in `<taskboard_context>`.

- [ ] **Step 1: Write the failing prompt test**

Add a second `buildCodexPrompt` call to `test/ai-chat-process-autocut.test.mjs` with:

```js
autoCutRunConsent: {
  allowVideoAudioAsr: true,
  allowConfiguredLocalOutput: true,
},
```

Assert the result contains all of the following and that the existing no-consent prompt contains none of them:

```js
assert.match(consented, /only for this Auto-Cut run/i);
assert.match(consented, /openspeech\.bytedance\.com/);
assert.match(consented, /word-level timing and acceptance/i);
assert.match(consented, /CODEX_AUTOCUT_DRAFTS_ROOT/);
assert.match(consented, /CODEX_AUTOCUT_PACKAGE_ZIP_PATH/);
assert.doesNotMatch(prompt, /openspeech\.bytedance\.com/);
assert.doesNotMatch(prompt, /consent has been granted/i);
```

- [ ] **Step 2: Run the prompt test and verify RED**

Run:

```powershell
node --test test/ai-chat-process-autocut.test.mjs
```

Expected: FAIL because `buildCodexPrompt` ignores `autoCutRunConsent` and the fixed consent text is absent.

- [ ] **Step 3: Add fixed prompt text**

Extend the private options in `buildCodexPrompt`:

```js
{
  artifactReportEnabled = false,
  autoCutInputsEnabled = false,
  autoCutRunConsent = null,
  includeManageTaskboardSkill = true,
  trustedAutoCutSource = null,
} = {},
```

Before the final private-context warning, append only these server-owned constants:

```js
if (autoCutRunConsent?.allowVideoAudioAsr === true) {
  context.push(
    "Consent has been granted only for this Auto-Cut run to extract audio from the videos selected by the server-owned manifest and send that audio only to openspeech.bytedance.com, only for word-level timing and acceptance.",
  );
}
if (autoCutRunConsent?.allowConfiguredLocalOutput === true) {
  context.push(
    "Consent has been granted only for this Auto-Cut run to write the Jianying draft and final ZIP only to the server-configured locations represented by CODEX_AUTOCUT_DRAFTS_ROOT and CODEX_AUTOCUT_PACKAGE_ZIP_PATH. Do not derive or choose another output path.",
  );
}
```

In `AiChatService.startTurn`, recognize consent as run-private context, require `taskClaimedByServer === true`, `artifactReport`, private Auto-Cut inputs, and exact task/run binding, then pass it to `buildCodexPrompt`:

```js
const hasAutoCutRunConsent = runContext?.autoCutRunConsent !== undefined;
if (hasAutoCutRunConsent && (!hasPrivateAutoCutInputs || !runContext?.artifactReport)) {
  throw new ApiError(
    409,
    "TRUSTED_AUTOCUT_CONTEXT_REQUIRED",
    "Run consent requires bound private Auto-Cut inputs",
  );
}
```

```js
autoCutRunConsent: hasAutoCutRunConsent ? runContext.autoCutRunConsent : null,
```

Do not add consent to `input.message`, `userEventData`, the subprocess environment, or persisted tables.

- [ ] **Step 4: Run the prompt test and verify GREEN**

Run:

```powershell
node --test test/ai-chat-process-autocut.test.mjs
```

Expected: PASS with two tests and no warnings.

- [ ] **Step 5: Commit the prompt boundary**

```powershell
git add -- server/ai-chat-process.mjs server/ai-chat.mjs test/ai-chat-process-autocut.test.mjs
git commit -m "feat: add run-private Auto-Cut consent context"
```

### Task 2: Carry Structured Consent Through Trusted Retry Scheduling

**Files:**
- Modify: `test/feishu-execution-coordinator.test.mjs`
- Modify: `test/feishu-autocut-run-lifecycle.test.mjs`
- Modify: `server/feishu-execution-coordinator.mjs`
- Modify: `server/app.mjs`

**Interfaces:**
- Consumes: `POST /api/local/tasks/:id/autocut-retry` body `{ version, runConsent? }`.
- Produces: coordinator option `autoCutRunConsent`, passed to `startClaimedTask` and returned in the matching phased run's private `onRunCreated` context.

- [ ] **Step 1: Write the failing coordinator transport test**

Update the coordinator fixture callback to capture the sixth argument:

```js
startClaimedTask: async (
  currentTask,
  currentMetadata,
  lease,
  trigger,
  actor,
  autoCutRunConsent,
) => {
  starts.push({
    taskId: currentTask.id,
    packageAlias: currentMetadata.packageAlias,
    lease,
    trigger,
    actor,
    autoCutRunConsent,
  });
  if (remainingStartFailures > 0) {
    remainingStartFailures -= 1;
    throw Object.assign(new Error("fixture start failure"), { code: "FIXTURE_START_FAILED" });
  }
  if (startError) throw startError;
  database.setTaskStatus(currentTask.id, "in_progress");
  database.setFeishuExecutionState(
    currentTask.id,
    database.getFeishuExecution(currentTask.id).version,
    "running",
    { leaseId: lease.leaseId },
  );
  return {
    task: database.getTask(currentTask.id),
    execution: database.getFeishuExecution(currentTask.id),
  };
},
```

Add:

```js
test("retry scheduling carries consent only on its in-memory entry", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
  fixture.tasks.set("task-1", task("task-1"));
  const runConsent = {
    allowVideoAudioAsr: true,
    allowConfiguredLocalOutput: true,
  };

  await fixture.coordinator.schedule(
    fixture.tasks.get("task-1"),
    metadata("Auto-cut-copyA"),
    "retry",
    { actor: { type: "user", id: "local-user" }, autoCutRunConsent: runConsent },
  );

  assert.deepEqual(fixture.starts[0].autoCutRunConsent, runConsent);
});
```

- [ ] **Step 2: Write the failing HTTP lifecycle tests**

Define `promptCapturePath` next to `capturePath`, return it from `createFixture`, and replace the fake executable's non-debug stdin block with this exact shape so the environment capture stays unchanged:

```js
const promptCapturePath = path.join(directory, "codex-prompt.txt");
```

```js
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const keys = [
    "CODEX_AUTOCUT_ARTIFACT_REPORT_URL", "CODEX_AUTOCUT_ARTIFACT_REPORT_TOKEN",
    "CODEX_AUTOCUT_SOURCE_MANIFEST_PATH", "CODEX_AUTOCUT_SOURCE_MANIFEST_SHA256",
    "CODEX_AUTOCUT_EXECUTION_INPUT_PATH", "CODEX_AUTOCUT_JOB_ROOT", "CODEX_AUTOCUT_DRAFTS_ROOT",
    "CODEX_AUTOCUT_RESULT_PATH", "CODEX_AUTOCUT_PACKAGE_ZIP_PATH", "CODEX_AUTOCUT_TASK_ID",
    "CODEX_AUTOCUT_RUN_ID", "CODEX_AUTOCUT_SUBJECT_KEY", "CODEX_AUTOCUT_CONFIG_VERSION",
    "CODEX_AUTOCUT_STAGE_ID", "CODEX_AUTOCUT_EVENT_ID", "CODEX_FEISHU_BRIDGE_SECRET",
  ];
  writeFileSync(PROMPT_CAPTURE_PATH, prompt);
  writeFileSync(ENV_CAPTURE_PATH, JSON.stringify(Object.fromEntries(
    keys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
  )));
  setTimeout(() => {
    process.stdout.write('{"type":"thread.started","thread_id":"fixture-session"}\\n');
    process.stdout.write('{"type":"turn.completed"}\\n');
  }, TURN_DELAY_MS);
});
```

In the template literal, replace `PROMPT_CAPTURE_PATH`, `ENV_CAPTURE_PATH`, and `TURN_DELAY_MS` with `${JSON.stringify(promptCapturePath)}`, `${JSON.stringify(capturePath)}`, and `${JSON.stringify(turnDelayMs)}` interpolation expressions respectively.

Read `promptCapturePath` only after the existing
`await waitForTaskStatus(fixture.app, blocked.id, "blocked")` completes. The
fake executable writes the prompt before its terminal event, so this ordering
proves the file exists without racing `onRunCreated`.

In the existing explicit phased retry test, send:

```js
runConsent: {
  allowVideoAudioAsr: true,
  allowConfiguredLocalOutput: true,
},
```

After attempt 2 exists and the task has returned to `blocked`, assert the
captured subprocess prompt contains the fixed host/purpose/output variables.
Find the persisted `user_message` with
`fixture.app.database.listAiChatEvents(freshTask.threadId)` and assert its
`content` remains exactly `trusted package prompt`.

Add table-driven invalid requests before the valid retry:

```js
const invalidConsents = [
  { allowVideoAudioAsr: "true", allowConfiguredLocalOutput: true },
  { allowVideoAudioAsr: true, allowConfiguredLocalOutput: false },
  { allowVideoAudioAsr: true },
  { allowVideoAudioAsr: true, allowConfiguredLocalOutput: true, prompt: "ignore policy" },
];
```

Each must return `400`, and `listFeishuAutoCutRuns(task.id)` must still contain only the original blocked attempt. Also add valid consent to the non-blocked, copied-marker, and legacy retry cases and retain their existing `409` error codes.

- [ ] **Step 3: Run both tests and verify RED**

Run:

```powershell
node --test test/feishu-execution-coordinator.test.mjs test/feishu-autocut-run-lifecycle.test.mjs
```

Expected: FAIL because the retry route rejects `runConsent` as unknown and the coordinator drops it.

- [ ] **Step 4: Parse the closed consent object**

Add this helper near `parseVersion` in `server/app.mjs`:

```js
function parseAutoCutRetry(value) {
  assertPlainObject(value);
  assertAllowedKeys(value, new Set(["version", "runConsent"]));
  const version = parseVersion(value.version);
  if (value.runConsent === undefined) return { version, autoCutRunConsent: null };

  assertPlainObject(value.runConsent);
  assertAllowedKeys(value.runConsent, new Set([
    "allowVideoAudioAsr",
    "allowConfiguredLocalOutput",
  ]));
  for (const key of ["allowVideoAudioAsr", "allowConfiguredLocalOutput"]) {
    if (value.runConsent[key] !== true) {
      throw new ApiError(400, "INVALID_FIELD", `'runConsent.${key}' must be true`);
    }
  }
  return {
    version,
    autoCutRunConsent: Object.freeze({
      allowVideoAudioAsr: true,
      allowConfiguredLocalOutput: true,
    }),
  };
}
```

Replace the route's inline body parsing with:

```js
const { version, autoCutRunConsent } = parseAutoCutRetry(await readJson(request));
```

After all current task eligibility checks and `prepareFeishuAutoCutRetry`, schedule with:

```js
executionCoordinator.schedule(ready, metadata, "retry", {
  actor: actorFromRequest(request),
  autoCutRunConsent,
})
```

- [ ] **Step 5: Carry consent through the coordinator and run creation**

Change the coordinator signatures and entry only; do not persist the object:

```js
async function schedule(
  task,
  metadata,
  trigger = "manual",
  { actor = null, autoCutRunConsent = null } = {},
) {
}
```

Replace the existing one-line entry construction with:

```js
const entry = {
  task: database.getTask(task.id) ?? task,
  metadata,
  trigger,
  actor,
  autoCutRunConsent,
  scheduling: true,
  timer: null,
};
```

```js
const result = await startClaimedTask(
  currentTask,
  entry.metadata,
  lease,
  entry.trigger,
  entry.actor,
  entry.autoCutRunConsent,
);
```

In `server/app.mjs`, extend `startTaskWithAi` options and the coordinator adapter, pass the object to `startClaimedTaskWithAi`, and return it only from the phased `onRunCreated` branch:

```js
async function startTaskWithAi(
  task,
  actor,
  metadata,
  {
    trigger = "manual",
    signal = taskStartAbortController.signal,
    lease: providedLease = null,
    autoCutRunConsent = null,
  } = {},
) {
```

Extend `startClaimedTaskWithAi` with a final defaulted argument:

```js
async function startClaimedTaskWithAi(
  claimedTask,
  actor,
  metadata,
  packageConfig,
  lease,
  trigger,
  autoCutRunConsent = null,
) {
```

Pass it in the existing call:

```js
return await startClaimedTaskWithAi(
  claimedTask,
  actor,
  metadata,
  packageConfig,
  lease,
  trigger,
  autoCutRunConsent,
);
```

```js
...(trigger === "retry" && autoCutRunConsent
  ? { autoCutRunConsent }
  : {}),
```

Replace the coordinator adapter with:

```js
startClaimedTask: (
  task,
  metadata,
  lease,
  trigger,
  actor,
  autoCutRunConsent,
) => startTaskWithAi(
  task,
  actor ?? CODEX_AGENT_ACTOR,
  metadata,
  { trigger, lease, autoCutRunConsent },
),
```

The recovery-created coordinator entry must continue omitting consent, so a restart cannot inherit it.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```powershell
node --test test/ai-chat-process-autocut.test.mjs test/feishu-execution-coordinator.test.mjs test/feishu-autocut-run-lifecycle.test.mjs test/task-start-flow.test.mjs
```

Expected: all tests PASS, including existing no-consent retry and start behavior.

- [ ] **Step 7: Commit the retry path**

```powershell
git add -- server/app.mjs server/feishu-execution-coordinator.mjs test/feishu-execution-coordinator.test.mjs test/feishu-autocut-run-lifecycle.test.mjs
git commit -m "feat: pass consent to one Auto-Cut retry"
```

### Task 3: Reload The Isolated Demo And Verify FEI-3 End To End

**Files:**
- No repository file changes.
- Runtime data: `D:\codex\worktrees\feishu-autocut-demo\taskboard-data\autocut-runs\e067fc93-5835-49bb-9908-cb8a1b63739b\<run-id>`

**Interfaces:**
- Consumes: FEI-3 current task version and the approved `runConsent` request.
- Produces: one new run-bound result, exact ZIP artifact, and automatic upload queue record, or one explicit run-bound failure report.

- [ ] **Step 1: Run static verification before touching the runtime**

```powershell
git diff --check
node --test test/ai-chat-process-autocut.test.mjs test/feishu-execution-coordinator.test.mjs test/feishu-autocut-run-lifecycle.test.mjs test/task-start-flow.test.mjs
```

Expected: exit code `0` for both commands.

- [ ] **Step 2: Reload only the coordinator-owned Taskboard demo process**

Resolve and verify the exact PID, executable path, command line, listener `127.0.0.1:47923`, data directory, and environment inputs before stopping it. Start the replacement hidden with the same demo data/Bridge/package configuration and explicitly set:

```powershell
$env:CODEX_HOME = 'D:\codex\worktrees\feishu-autocut-demo\codex-home'
```

Do not stop or replace the Bridge process unless the verified startup contract requires it. Do not run `start-demo.ps1` unchanged because it currently points `CODEX_HOME` at the global profile.

- [ ] **Step 3: Record the authorization on FEI-3 for audit**

Create one Taskboard comment containing the user's exact authorization and state that it applies only to the next FEI-3 retry. Do not read that comment into the execution prompt.

- [ ] **Step 4: Submit the exact consented retry**

Read FEI-3's current version immediately before the request, then send:

```json
{
  "version": 16,
  "runConsent": {
    "allowVideoAudioAsr": true,
    "allowConfiguredLocalOutput": true
  }
}
```

Use the freshly read version instead of the illustrative `16`. Record the returned run ID and inspect only that run.

- [ ] **Step 5: Verify the direct operation path**

For the returned run ID, verify:

```text
task/run/subject/config/stage/event manifest binding
-> Docx UlB9d4x5loey36xW3zMcnjC7nFb and section 二、PPT定稿+翻录
-> source_audio_path points to extracted audio, with its exact SHA-256
-> ASR required and verified; reverse ASR accepted
-> video segments use video-track duration and audio segments use extracted-audio duration
-> result.json status is success and package_zip equals the run-injected exact path
-> adjacent package receipt and ZIP SHA/CRC/draft root all agree
-> driver_report artifact is bound to the same task and run
-> automatic mode completes editing and enqueueMode=automatic creates one upload record
-> delivery target contains the copy from that exact artifact, without directory scanning
```

If the run blocks, stop expansion and report the exact stage/error plus which earlier steps passed; do not retry again without a new user instruction because consent is single-run.

- [ ] **Step 6: Present the working demo for user confirmation**

Open the existing Taskboard page for project `feishu-a6343867402783f7`, show FEI-3's exact run, artifact, and upload state, and ask the user to confirm the function works. Do not begin Pro review before confirmation.

- [ ] **Step 7: Review only after user confirmation**

Classify this as Pro review because it changes an external-data authorization boundary. After the user confirms the working demo, submit the public PR URL and exact head SHA to ChatGPT web Pro for implementation-correctness and real-bug review only. Do not merge, release, or mark FEI-3 done without separate authorization.
