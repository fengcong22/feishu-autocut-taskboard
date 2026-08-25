# Auto-Cut Codex Package Management and Launch Workflow

## Purpose

Taskboard needs a machine-local package manager for Auto-Cut workspaces that
are executed by Codex with GPT models. A package is not an executable binary.
It is a trusted Codex workspace such as `Auto-cut-copyA`, containing its own
instructions, skills, scripts, and editing workflow.

The package manager must let an operator register a package once, select it
from subject configuration, and use it for both manual and automatic task
starts. Automatic tasks remain visible in `待处理` for five seconds before
they start, then use a visible `排队中` stage when the package has no free
concurrency slot.

## Scope

This design covers:

- a global Auto-Cut Codex package management page in Taskboard;
- a dedicated machine-local package registry shared by Taskboard and Bridge;
- package-specific Codex model, reasoning effort, workspace, prompt, ZIP
  source directory, and concurrency settings;
- package draft, enable, disable, reference, and deletion behavior;
- selecting an enabled package from a Feishu subject configuration;
- persisted five-second automatic-start delay, manual immediate start,
  visible queueing, and per-package concurrency;
- globally editable board-stage display names with stable internal roles;
- immutable execution snapshots for existing tasks;
- manual ZIP association until the replacement Auto-Cut defines a safe
  automatic output contract;
- different completion behavior for manual and automatic subjects.

This work does not change Feishu records, expose Taskboard or Bridge beyond
`127.0.0.1`, or let Feishu cell values supply local paths, commands, Codex
arguments, models, or prompts.

## Existing Operation Path

The current direct execution path already proves that a registered package is
a Codex workspace:

1. Bridge registers a controlled Feishu task through Taskboard's dedicated
   local source route. A copied marker in an ordinary task does not grant
   execution permission.
2. `POST /api/tasks/:id/start-ai` in `server/app.mjs` accepts only a registered
   Feishu task that is still `todo`.
3. `startTaskWithAi` resolves the trusted `packageAlias` through
   `server/feishu-package-config.mjs` and validates the configured workspace.
4. `resolveAiChatContext` switches the Codex thread to that package workspace.
5. `startClaimedTaskWithAi` creates the Codex thread and submits the package's
   fixed prompt through `aiChat.startTurn`.
6. The existing resource scheduler already groups work by package alias and
   enforces a positive concurrency limit.

The new feature replaces the read-only package configuration with a managed
local registry and adds the agreed launch states. It does not replace Codex
with a shell command or standalone process launcher.

## Architecture

### Components

1. **Package management UI**

   A global Taskboard page lists packages and opens a right-side editor for
   the selected package. It does not belong to a Base or subject.

2. **Taskboard package API and registry store**

   Taskboard is the only writer. The server validates input and writes a
   versioned machine-local registry by atomic replacement. The browser never
   writes the registry file directly.

3. **Bridge package reader**

   Bridge reads the same registry as a local whitelist. It uses the alias to
   validate routing only. It does not start Codex and it does not accept paths
   or prompts from Feishu.

4. **Trusted task execution snapshot**

   When Taskboard registers a Bridge-created task, it copies the selected
   package's execution configuration into server-owned task data. The
   snapshot is not stored in the ordinary task description and cannot be
   forged by adding labels or comments.

5. **Persisted launch coordinator**

   The coordinator stores the automatic start deadline and queue state,
   requests a per-package scheduler lease, and creates the Codex thread only
   after a lease is available.

### Registry Location and Ownership

The launcher supplies one explicit absolute path, for example through
`CODEX_AUTOCUT_PACKAGES_PATH`. The local Bridge launcher can point both
processes to `config/autocut-packages.local.json` in the Bridge repository.
The file is Git-ignored and excluded from subject sharing and export.

This dedicated package catalog is a deliberate exception to the Bridge's
current rule that all real local configuration lives in
`config/bridge.local.json`. The implementation must update the Bridge
`AGENTS.md`, example configuration, and README together so the new ownership
rule is explicit: Bridge listener and routing configuration remains in
`bridge.local.json`; trusted Auto-Cut package definitions live only in the
dedicated catalog. No credentials move to the new file.

The registry is an address book, not a copy of any Auto-Cut workspace. Moving
to another computer requires registering the local workspace and output paths
on that computer. Imported subject configuration keeps only its package
alias; it remains unavailable until that alias exists locally.

### Package Record

Each package contains:

- `alias`: unique, stable routing identifier;
- `name`: editable display name;
- `workspacePath`: absolute Codex workspace directory;
- `model`: a model available from the local Codex catalog;
- `reasoningEffort`: an effort supported by the selected model;
- `prompt`: fixed package start instruction;
- `zipSourceDirectory`: optional absolute source directory for completed ZIPs;
- `maxConcurrent`: positive integer, default `1`;
- `state`: `draft`, `enabled`, or `disabled`;
- registry revision and package revision metadata.

The alias can be edited while a package is an unreferenced draft. After a
package is enabled or referenced, the alias is stable; changing the visible
name does not affect routing. A new routing alias is created as a new package
and subjects are reassigned explicitly.

## User Interface

### Navigation and List

The left navigation receives a global `Auto-Cut 包管理` entry. The main page
uses a compact operational table rather than large cards. Columns are:

- package name and alias;
- state;
- GPT model and reasoning effort;
- maximum concurrency;
- number of subject references;
- actions.

The primary action is `新增 Auto-Cut 包`. Selecting a row opens a right-side
editor. Familiar icon actions are used for edit, disable, and delete, with
tooltips where the icon is not self-explanatory.

### Editor

The editor exposes all package fields directly in Taskboard. Model and
reasoning effort use catalog-backed option controls. Concurrency uses a
positive numeric input. Workspace and ZIP source are text inputs for absolute
paths; the server, not the browser, verifies local accessibility.

`保存` persists a draft without making it selectable. `启用` performs the
full enable validation and, on success, makes the package available in subject
configuration. A disabled package remains visible and editable.

Selecting the subject-reference count displays the Base and table names that
use the package. Deletion is rejected while an enabled subject or unfinished
task references the package. The UI reports the references instead of
silently clearing them.

### Subject Configuration

The free-text package alias is replaced with a dropdown of locally enabled
packages. Existing subjects that refer to a disabled or missing alias show the
stored selection as unavailable and cannot enable automatic execution until
the local package is restored or replaced.

A disabled package remains a known trusted alias, so Bridge may still register
a controlled task for an already-enabled subject. Taskboard keeps that task in
`待处理` and does not launch it until the package is re-enabled or the subject
is assigned to another enabled package. A missing alias is not trusted and
continues to block subject enablement and execution.

### Board Stage Labels

The standard visible start stages are globally named:

- `todo` role: `待处理`;
- queued execution role: `排队中`;
- active execution role: `处理中`.

Display names and functional roles are separate. This slice includes a
separate global board-stage settings surface that lists each stable role and
its editable display name. Saving a name changes every Base and subject board.
Stage labels are global, not per Base or per subject, and are not edited inside
a package. This slice adds the required queue role and label editing;
arbitrary creation or deletion of functional roles remains separate
workflow-design work.

## Task Data and Version Rules

At controlled task registration, Taskboard stores:

- the trusted Feishu origin and subject identity;
- package alias and package revision;
- workspace path, model, reasoning effort, prompt, and ZIP source snapshot;
- automatic or manual execution mode;
- initial automatic-start deadline when applicable.

Editing a package does not silently alter an existing `待处理` or `排队中`
task. An unstarted task can explicitly apply the package's newest revision
through `更新为最新包配置`. A running task can never change revision.

Package enabled state and maximum concurrency are live operating controls,
not immutable task content:

- disabling a package pauses pending and queued starts but does not interrupt
  a running Codex task;
- re-enabling it makes eligible tasks schedulable again;
- lowering concurrency does not cancel running tasks, but no new task starts
  until usage falls below the new limit;
- increasing concurrency allows queued tasks to advance immediately.

Queue ordering is first-in, first-out within one package. Different packages
have independent concurrency groups. The package registry is the sole source
of the live concurrency limit; subject configuration and Feishu task metadata
cannot override it.

## Launch and Completion Flow

### Automatic Subject

1. A Feishu record changes from another value to the subject's single
   configured ready value.
2. Bridge filters, normalizes, deduplicates, and registers a controlled task.
3. The task appears in `待处理` with a persisted five-second deadline.
4. During the delay, `立即开始` skips the remaining time but still requests a
   concurrency slot.
5. If a slot is available, Taskboard claims the task and starts Codex. If not,
   the task moves to visible `排队中`.
6. Only after a lease is granted and the Codex run is created does the task
   move to `处理中`.
7. After Auto-Cut succeeds and a ZIP is associated, the task moves directly to
   `已完成剪辑`; automatic subjects do not use `待验收`.

### Manual Subject

1. The controlled task appears in `待处理` without an automatic deadline.
2. A user clicks start or drags it toward processing.
3. The same scheduler path places it in `排队中` or starts it in `处理中`.
4. After Auto-Cut succeeds and a ZIP is associated, it moves to `待验收`.
5. Manual confirmation moves it to `已完成剪辑`.

Drag-to-processing and the start button use the same server endpoint and
scheduler. The UI cannot bypass the trusted-origin check, package state, or
concurrency limit.

### ZIP Source and Upload Destination

The ZIP source directory answers "where does Taskboard obtain the completed
draft ZIP?" It is distinct from the later upload destination:

```text
Auto-Cut ZIP source directory -> task ZIP association -> upload destination
```

For the first implementation, `zipSourceDirectory` is optional and the user
can select the exact ZIP manually. The replacement Auto-Cut has not yet
defined its final output directory or filename contract.

Automatic ZIP association must not select the newest file in a shared folder,
because concurrent tasks can produce ambiguous results. A later automatic
contract must return or encode a trusted execution/task identifier in the ZIP
path or a machine-readable manifest. Until that contract exists, automatic
discovery is out of scope and manual selection is the supported path.

Uploading the associated ZIP to a local or NAS destination is a later feature.
This design preserves the separate `上传目标路径` concept but does not start
an upload worker.

## Validation and Failure Handling

Drafts may be incomplete. Enabling requires:

- a unique non-empty alias and name;
- an existing absolute workspace directory;
- an available model and supported reasoning effort;
- a non-empty fixed prompt;
- a positive integer concurrency value;
- an empty ZIP source or an accessible absolute directory.

Runtime behavior is fail-closed:

- a disabled package, missing workspace, or unavailable model leaves the task
  in `待处理` with a safe configuration error and does not start Codex;
- a restart restores persisted delay and queue state without creating a
  duplicate task or Codex run;
- failure before a Codex run exists releases the lease and returns the task to
  `待处理` with a retry action;
- failure after Codex started records the failure and requires an explicit
  retry, because partial media output may exist;
- a missing ZIP reports `等待选择 ZIP` and allows manual association;
- an unreadable registry prevents new starts and is never replaced with an
  empty configuration automatically.

Local paths, prompts, and Codex options stay in the registry and trusted
server-owned snapshot. They are not written to Feishu cells, normal task
descriptions, public logs, or shared subject exports.

## Verification Strategy

### Direct Product Path

Before using a real video, register a fake Auto-Cut/Codex workspace and prove:

1. create, save, enable, edit, and disable a package in Taskboard;
2. select the enabled package in one test subject;
3. simulate one ready event and observe `待处理`;
4. observe the five-second start or click `立即开始`;
5. saturate the package limit and observe `排队中`;
6. verify the fake Codex invocation receives the registered workspace, model,
   reasoning effort, and fixed prompt;
7. manually associate a fixture ZIP and observe the correct completion stage;
8. restart during delay or queueing and observe recovery.

After the replacement Auto-Cut is deployed, repeat the direct path once with
the approved test Base and one real test record. Use
`scripts/check-local.ps1 -RequireFeishu` only for that real long-connection
verification and do not repeatedly edit production records.

### Focused Automated Coverage

Changes to Bridge routing or configuration require the repository-mandated
README and focused test updates. Coverage is limited to the requested path:

- registry validation and API mutation;
- Bridge recognition of a known local alias without accepting cell-supplied
  execution fields;
- task snapshot immutability and explicit refresh;
- five-second deadline, immediate start, FIFO queueing, and per-package limits;
- restart recovery without duplicate Codex creation;
- subject reference preventing deletion;
- manual and automatic completion branch behavior.

The fake Codex runner captures invocation metadata and creates a fixture ZIP;
automated tests do not process real video.

## Rollout Order

1. Add the local registry store and read APIs without changing current task
   execution.
2. Add the global package manager and subject package dropdown.
3. Prove package registration and the current manual start path in Taskboard.
4. Add persisted delayed start and visible queue state.
5. Prove manual and automatic completion with a fixture ZIP.
6. Update the Bridge reader, `AGENTS.md`, example configuration, required
   tests, and README together.
7. Run one real end-to-end test after the replacement Auto-Cut is available.

## Non-goals

- No modification of the Auto-Cut editing instructions or subject-specific
  material rules in this slice.
- No automatic inference of subject requirements from arbitrary Feishu cell
  content.
- No automatic ZIP matching without an explicit output identity contract.
- No ZIP upload worker, NAS transfer, or Feishu status writeback.
- No LAN or public listener.
- No export of machine-local paths, prompts, models, or package settings.
- No interruption of an already running Codex/Auto-Cut task when a package is
  disabled or edited.
