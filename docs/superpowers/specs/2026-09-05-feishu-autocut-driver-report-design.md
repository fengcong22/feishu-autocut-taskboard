# Feishu Auto-Cut Driver Report Design

## Goal

Allow only server-registered Feishu Auto-Cut runs to report the exact accepted
Jianying ZIP produced by that run. Taskboard must bind the verified ZIP to the
originating task and Codex run without scanning a directory or selecting a file
by name or modification time.

## Existing Operation Path

The trusted task path already begins at `POST /api/local/feishu/tasks` in
`server/app.mjs`. The route authenticates the Feishu Bridge and persists a
server-owned `feishu_task_origins` record plus the subject and package snapshot.

`startClaimedTaskWithAi` then claims the task, creates its Codex thread and run,
and records the exact `task_id`, `thread_id`, `run_id`, and `claim_token` in
`task_ai_starts`. That active claim is the capability boundary for a report.

The existing `POST /api/local/tasks/:id/artifacts` route accepts a manually
selected ZIP. `server/artifact-service.mjs` streams it into private storage,
computes SHA-256, and validates ZIP structure, entry CRCs, and the Jianying
draft structure. `server/database.mjs` records the artifact and advances a
manual execution to `in_review` or an automatic execution to `done`; the
existing upload queue can then enqueue the verified artifact.

The missing link is a run-scoped report contract. `driver_report` is currently
only a disabled subject configuration value, `task_artifacts` has no `run_id`,
and a completed Codex run has no way to identify its exact ZIP to Taskboard.

## Chosen Approach

Use an active, run-scoped path report:

```text
taskctl artifact report --file <absolute path to this run's accepted ZIP>
```

`taskctl` reads exactly the supplied file and computes its SHA-256. It does not
enumerate the parent directory. It sends a JSON report containing the exact
path and computed hash to a private run-specific endpoint:

```text
POST /api/local/tasks/:taskId/runs/:runId/artifact-report
```

The report endpoint and a short-lived report token are supplied only to the
server-claimed Codex process as `CODEX_AUTOCUT_ARTIFACT_REPORT_URL` and
`CODEX_AUTOCUT_ARTIFACT_REPORT_TOKEN`. The token is not placed in the prompt or
command line. Normal Codex turns do not receive either value.

The alternative of streaming the entire ZIP over loopback was rejected because
the task and Taskboard share the trusted local filesystem, ZIPs may be large,
and the configured source root already provides a narrower filesystem boundary.
A run manifest was rejected because it adds polling, stale-manifest recovery,
and cleanup without improving the requested direct path.

## Trust And Ownership Checks

Taskboard rejects a report unless all of the following are true before it opens
the reported file:

1. The request came from loopback and identifies itself as `taskctl`.
2. The task has a server-owned Feishu origin whose immutable fields still match
   the task description marker and labels.
3. The task's creation-time subject snapshot has
   `upload.artifactSourceMode = driver_report` and an absolute
   `artifactSourcePath`.
4. The active `task_ai_starts` row matches the route task and run, the task's
   bound thread, and the supplied claim token.
5. The run belongs to that thread and the thread belongs to that task.
6. `realpath` for the file is inside `realpath` for the snapshotted
   `artifactSourcePath`; the path identifies a regular `.zip` file.

The report token expires when the run claim is settled. A description marker,
copied label, ordinary local request, wrong task, wrong run, or wrong token is
therefore insufficient to register an artifact.

## Artifact Verification And Persistence

After ownership checks, Taskboard opens only the reported file and passes its
stream and filename through the existing artifact service. The service writes
to Taskboard private storage and independently computes SHA-256 while applying
the existing ZIP and Jianying validation.

The independently computed hash must equal the report hash. On mismatch,
Taskboard removes the newly stored private copy and records no artifact.

`task_artifacts` gains nullable `run_id`; its `source_mode` constraint accepts
both `manual_select` and `driver_report`. A partial unique index permits at most
one artifact for a non-null `run_id`. Repeating the same run report with the
same path content and hash returns the existing artifact; reporting different
content for that run returns a conflict.

Manual artifacts keep `run_id = NULL` and retain their existing behavior.

## Completion Sequence

Driver reporting occurs before the Codex turn emits its terminal result:

```text
trusted task claim
  -> Codex/Auto-Cut creates and accepts one exact ZIP
  -> taskctl reports path and SHA-256 for the bound task/run
  -> Taskboard verifies and stores the ZIP while task remains in_progress
  -> Codex run reaches a terminal state
  -> Taskboard reconciles that exact run and artifact
```

For a `completed` run with a matching verified artifact:

- automatic execution moves the task to `done`;
- manual execution moves the task to `in_review`;
- automatic execution with `enqueueMode = automatic` enqueues that exact
  artifact through the existing upload queue.

A completed run without a verified report retains the current `in_progress`
behavior. A failed or interrupted run moves to `blocked`, even if it reported a
ZIP before failing. No upload is enqueued in either case.

The upload decision and artifact source configuration are read from the task's
creation-time subject version, not mutable current subject settings.

## Prompt And CLI Contract

The private Auto-Cut context tells the agent to call `taskctl artifact report`
only after its normal Auto-Cut validation accepts the exact ZIP. It explicitly
forbids directory scanning or substituting another ZIP. The prompt contains no
report token.

`taskctl artifact report` requires one `--file` argument. It requires the two
run-scoped environment variables, resolves the supplied file to an absolute
path, verifies that it is a regular `.zip`, streams it once to calculate
SHA-256, and submits the following request:

```text
Authorization: Bearer <CODEX_AUTOCUT_ARTIFACT_REPORT_TOKEN>
x-taskboard-client: taskctl
Content-Type: application/json

{"path":"<absolute ZIP path>","sha256":"<lowercase SHA-256>"}
```

Missing context or file errors fail without a request.

## Configuration UI

The subject settings enable `driver_report` as a ZIP source. Its source path is
required and remains the trusted root for reported files. `watch_directory`
remains disabled. `manual_select` continues to use the existing task-detail ZIP
picker and API.

## Direct Verification

This is high-risk work because it crosses process credentials, a local API
boundary, filesystem input, run lifecycle state, and persistent schema.

The direct successful verification will create a trusted automatic Feishu task
whose creation-time subject uses `driver_report`, run the report command for a
known valid ZIP, complete that same run, and observe:

- one verified artifact with the exact task and run IDs and matching SHA-256;
- task status `done` only after run completion;
- one upload queue item for that exact artifact when enqueue mode is automatic.

The direct rejection verification will use a normal or forged task and a
mismatched task/run/token or hash and observe no artifact, status change, or
upload. Focused automated coverage will also keep the existing manual-select
path passing.

## Documentation

`README.md` and `README.zh-CN.md` will describe the report command, run-scoped
binding and verification, automatic completion and enqueue sequence, the source
root requirement, and the explicit absence of directory scanning or newest-file
selection.

## Non-Goals

- Implementing `watch_directory`.
- Guessing ownership from ZIP names, timestamps, or directory order.
- Allowing reports after the associated run claim has settled.
- Changing upload transport or destination behavior.
- Adding compatibility paths for unregistered or legacy pseudo-Feishu tasks.
