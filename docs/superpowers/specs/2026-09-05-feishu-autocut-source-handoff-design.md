# Feishu Auto-Cut Source Handoff Design

## Goal

Extend the trusted Feishu Auto-Cut path so an automatic run receives the exact
video and complete editing opinions from the task's current Feishu record,
without putting a temporary document URL in package or global configuration.
The existing run-scoped `driver_report` contract remains the only artifact
registration path.

## Proven Operation Path

The current path is:

`POST /api/local/feishu/tasks` (Bridge authentication in `server/app.mjs`)
-> `feishu_task_origins` and the creation-time package snapshot
-> `startTaskWithAi` / `startClaimedTaskWithAi` claim the task and bind a
task/thread
-> `AiChatService.startTurn` creates the run and invokes `onRunCreated`
(`server/ai-chat.mjs`)
-> the host-side source broker reads the exact Base/table/record with the
authorized Feishu user identity, fetches the record's unique docx link, parses
the document and downloads its exact media tokens into a run-private directory
-> the broker writes canonical `snapshot.json`, `project.json`, and a manifest
-> the `workspace-write` Auto-Cut process receives only those local paths and
creates/accepts a ZIP
-> `taskctl artifact report --file <that exact ZIP>` calls the existing
run-scoped report route
-> Taskboard verifies task/thread/run/token, source-root containment, ZIP
structure, and SHA-256, then the existing run reconciliation moves an automatic
task to `done` and enqueues the same verified artifact when
`enqueueMode=automatic`.

The observable result is a task-bound, run-bound verified artifact and (for
automatic enqueue) one upload queue item. A missing or ambiguous source fails
before Auto-Cut starts and rolls back the run, thread, claim, and lease.

## Scope and Trust Boundary

Only a server-registered Feishu task that still passes the immutable origin and
package-snapshot checks qualifies. The broker is called only for an automatic
execution using the `driver_report` source mode. Manual execution continues to
use its current prompt and manual ZIP picker/API behavior. Ordinary local tasks,
copied description markers, labels, browser input, and forged requests cannot
invoke the broker or obtain an artifact-report capability.

The Bridge retains its application identity for event listening and task
registration. The Taskboard host invokes the configured native `lark-cli`
executable with `--as user` for read-only Base, Docs, and media operations. No
OAuth token, CLI profile, Bridge secret, Taskboard secret, document URL, or raw
provider response is passed to Auto-Cut, put in package registry configuration,
or returned through the task API. Auto-Cut receives only run-private local
paths, selected source/opinion data, and hashes.

## Source Resolution

The broker receives only server-owned origin fields (`baseToken`, `tableId`,
`recordId`) plus the created `taskId` and `runId`. It reads the exact record and
requires the configured source-document cell (the current table's `集合文档`
field) to contain exactly one HTTPS Feishu `/docx/` URL after strict Markdown
link parsing. A missing cell, multiple links, a non-Docx link, a record-id
mismatch, a provider error, or a non-user identity is a hard failure.

The broker fetches that URL with `docs +fetch --doc-format xml --detail full`
and parses the returned multi-top-level XML as a DTD-disabled fragment. It
never treats a local directory, filename, timestamp, or document URL supplied by
the task description as a source of truth.

The document parser keeps the complete review checkbox text and relevant color
spans. It resolves the video and opinion section structurally:

1. Enumerate `<source>` media and headings in document order.
2. Select the single video resource that belongs to the document's declared
   source-video structure and has one corresponding complete `剪辑意见` section.
   If there is no unique pairing, fail with `AUTOCUT_SOURCE_AMBIGUOUS`.
3. Use the exact `剪辑意见` heading's section until the next heading of equal
   or higher level. Exclude empty `视频初审` and `视频终审` sections.
4. Preserve the selected media token/name only as metadata; never infer task
   ownership from a filename.

For the current task, this deterministic parse selects the one complete pair
whose video is `从二月革命到十月革命-录屏-4.3.mp4`. The name is an observed
document value, not a matching key.

The selected media is downloaded with the user identity into a directory unique
to the task/run. The broker independently records byte size and SHA-256 for the
video and every selected visual asset. It writes a manifest containing the
task/run IDs, document identity/revision/content hash, selected roles, relative
paths, and hashes. The manifest and canonical JSON files are never reused across
runs.

## Auto-Cut Contract

The broker uses the maintained Auto-Cut `review-document-run` JSON mode:

- `snapshot_json` and `project_json` are both required;
- `doc_url` is omitted, so Auto-Cut performs no Feishu authentication or fetch;
- `project.workflow_mode` is `lite` and `lite_cut_layout` is `split_gap`;
- `project.source_video` is the run-private downloaded video;
- `snapshot.review_items` contains the complete, code-point-preserving opinion
  text and only the selected local visual asset paths.

The prompt contains one local manifest path and the existing exact-artifact
report instruction. It contains no document URL, media token, Base token, user
credential, or report token. The report token remains environment-only and
short-lived as in the existing `driver_report` design.

The final ZIP path is read from the successful runner JSON
(`data.package_zip` / `data.output_artifacts.package_zip`). The broker reports
that exact path and independently calculated SHA-256. It never scans the output
directory, chooses a newest ZIP, or substitutes a placeholder filename.

## Lifecycle and Failure Handling

The source files live below the existing AI turn temporary directory. The
directory is removed on run completion, failure, interruption, or startup
rollback using the current `AiChatService` cleanup path. A host crash may leave
the same kind of operating-system temporary residue as existing attachment
handling; recovery does not scan or adopt those files.

The native CLI is invoked through an absolute configured executable and an argv
array with shell execution disabled. Each response must have exit code zero,
`ok: true`, and `identity: "user"`. Any malformed response or provider error
fails closed. The broker does not call login/config commands and does not switch
to bot identity.

## Testing and Documentation

Focused tests will cover:

- exact Base/table/record/task/run arguments and user identity;
- strict unique Docx-link parsing and structural video/opinion selection;
- argv-only native CLI invocation and secret-free Auto-Cut prompt/environment;
- run-private JSON/media paths and cleanup;
- broker failure rollback before Codex starts;
- successful automatic completion, exact artifact hash/binding, and automatic
  upload enqueue;
- unchanged manual-select behavior and rejection of ordinary/forged tasks.

`README.md` will document the host-user identity split, the temporary
task-specific source rule, local JSON handoff, exact ZIP reporting, and the
fact that directory scanning and newest-file inference are unsupported.

## Risk and Direct Verification

This is high-risk work because it crosses a native process boundary, user
credentials, external Feishu APIs, run-scoped filesystem state, and persistent
Taskboard completion/upload state. Direct verification will use one fresh trusted
automatic task and the actual current record/document shape, then confirm the
exact selected video/opinion snapshot, successful Auto-Cut run, one verified
artifact bound to the same task/run and SHA, `done` status, and one queued upload.
A focused rejection run will confirm that an ambiguous or ordinary source does
not start Auto-Cut or register an artifact.

## Non-Goals

- Storing the temporary document URL in package/global configuration.
- Giving Auto-Cut the Feishu user token or asking it to run `lark-cli`.
- Supporting directory watching or newest-ZIP discovery.
- Changing manual mode, upload transport, or the existing artifact report API.
- Choosing among multiple videos by filename, byte size, or modification time.
