[English](README.md) | [简体中文](README.zh-CN.md)

# Codex Taskboard

A local-first issue board that runs in a browser and can be embedded in Codex through the standalone CDP launcher or its injection script. The same HTTP API powers the React UI and the `taskctl` CLI used by the bundled Codex Skill.

![Codex Taskboard product screenshot](docs/assets/codex-taskboard.png)

## Requirements

- Node.js 22.5 or newer

## Run locally

```bash
npm install
npm run build
npm start
```

Open <http://127.0.0.1:47823>. The SQLite database is stored at `.data/taskboard.sqlite`.

For development with live frontend reload:

```bash
npm run dev
```

The Vite UI runs at <http://127.0.0.1:5173> and proxies API requests to the local service.

## Use the CLI

Run it from the project:

```bash
npm run taskctl -- project create \
  --id my-project \
  --name "My project" \
  --workspace-path /absolute/path/to/repository

npm run taskctl -- issue create \
  --project my-project \
  --title "Implement the next slice" \
  --status todo \
  --priority high \
  --labels product,mvp
```

Use `npm link` if you want `taskctl` on your shell path. Set `CODEX_TASKBOARD_URL` to point the CLI at another local loopback service. Cloud deployments are configured through the loopback companion with `taskctl cloud login`.

## Install the Codex Skill

Copy or symlink `skills/manage-taskboard` into the Codex skills directory, then start a new Codex task:

```bash
ln -s /absolute/path/to/codex-taskboard/skills/manage-taskboard \
  ~/.codex/skills/manage-taskboard
```

The Skill teaches Codex to inspect an issue, move it to `in_progress`, use optimistic versions, verify the work, and then move it to `in_review`; it moves the issue to `done` only after the user explicitly confirms acceptance or asks to mark it complete.

## Embed in Codex

### Manual: use a dedicated CDP port

Keep the existing Codex window open. From the Taskboard repository, start a second Codex instance with a dedicated CDP port:

```bash
open -n -a /Applications/ChatGPT.app --args \
  --remote-debugging-port=9231 \
  --remote-allow-origins=http://127.0.0.1:9231
```

After the new Codex window appears, run the injector in another terminal:

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 \
npm run codex:inject -- --port 9231 --open
```

Keep the injector terminal running while using the embedded panel. The original Codex window remains unchanged, and the new window receives the Taskboard sidebar entry. If port `9231` is occupied, use another port in both commands.

### Recommended: launch an independent Taskboard window with one command

Keep existing Codex windows open and run:

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 npm run codex
```

This starts the local Taskboard service when needed, launches the official macOS Codex app with an independent profile and loopback-only port `9231`, waits for the main renderer and sidebar, injects a native-looking Taskboard entry after Plugins, and keeps watching both the service and replacement renderers. Existing Codex windows remain unchanged. Keep this command running while using the embedded panel. The launcher does not modify `ChatGPT.app` or its `app.asar`.

### macOS App: open and inject without a terminal

Build the local launcher once:

```bash
npm run app:codex
```

Then open `dist/macos/Codex Taskboard.app` from Finder. The App contains its own Node runtime, Taskboard service, built web UI, Skill, CLI wrapper, and injection script. It starts the service, launches the official Codex app, waits for the renderer, injects the sidebar entry, and opens the panel without showing a terminal window. The App can be copied away from this checkout; the target Mac only needs the official Codex app and does not need this repository, a system Node installation, or a separate Codex CLI installation. Taskboard data is stored in `~/Library/Application Support/Codex Taskboard`, and launcher output is written to `~/Library/Logs/Codex Taskboard/codex-taskboard-launcher.log`.

The local build uses ad-hoc code signing for direct verification. A public macOS download still needs Developer ID signing and Apple notarization.

Codex 26.715.52143 ships a renderer CSP that blocks arbitrary HTTP iframes. The launcher therefore enables CDP CSP bypass, reloads that renderer once, installs the document-start script, and waits until the Taskboard OOPIF is actually loaded. CDP is unauthenticated to other processes on the same machine, so only run trusted local code while the launcher is active.

To inject into a Codex instance that was already launched with CDP by another method, run:

```bash
npm run codex:inject -- --port 9229 --open
```

This command also stays resident so the injected tab can restart Taskboard after a service exit. Stop it with `Ctrl-C`.

The script adds a Taskboard entry to the Codex sidebar and renders the iframe across Codex's complete main workspace, including the contextual titlebar area so Taskboard's own header does not leave an empty strip. That full rectangular header is placed above Electron's draggable layer and marked `no-drag`; because the native contextual actions are suppressed while Taskboard is active, its own actions use their normal edge padding without an artificial right-side gap. The native sidebar stays mounted, while the previous page selection and contextual header are temporarily suppressed; choosing another Codex page restores them.

“在对话中打开” selects the corresponding native Codex project when one is available and opens an unsent native composer with an `e-taskboard` instruction and the issue's actual identifier. The installed Skill is selected implicitly from that instruction, so the composer does not add a `$manage-taskboard` mention. A conversation is attributed only after it actually processes the issue: `taskctl` reads Codex's `CODEX_THREAD_ID` and records that ID on the issue or comment mutation. Recorded IDs are clickable through Codex's native route bridge. Each issue can bind either one Git branch or one worktree; the options are scanned from the selected Codex project's repository instead of being typed by hand. The integration uses Codex's existing project, composer, and route markers; it does not patch React, replace `fetch`, load private chunks, or edit Codex data files.

To use a different UI origin, set `window.__CODEX_TASKBOARD_URL__` before the user script runs.

## Feishu Auto-Cut integration

The Feishu Bridge and Taskboard integration is local-only. The Bridge creates workflow tasks through `POST /api/local/feishu/tasks` with the `x-taskboard-client: feishu-bridge` header and the per-launch `x-feishu-bridge-secret` shared secret. `start-local.ps1` injects the same `CODEX_FEISHU_BRIDGE_SECRET` into both services. That route stores a server-owned Base/table/record provenance row alongside the task. A normal `POST /api/tasks` request that merely copies the Feishu description marker or the `feishu` label is not eligible to start Auto-Cut, upload artifacts, or appear in the Bridge waiting-task query.

A server-registered Feishu task may run its locally registered Auto-Cut package from a non-Git workspace. Taskboard supplies Codex's non-Git workspace option only after resolving the server-owned task provenance and trusted package snapshot; ordinary tasks, copied markers, browser input, and Feishu cells cannot request it.

If Codex exits before returning a native thread ID, moving the trusted task back to `todo` and starting it again detaches the failed local conversation while preserving that conversation in history. A task whose native Codex thread already started is never detached automatically, which prevents an accidental duplicate Auto-Cut run.

The Bridge uses these loopback routes for lifecycle reconciliation:

- `GET /api/local/feishu/tasks` — query trusted tasks by event or Base/table/record/trigger scope.
- `POST /api/local/feishu/tasks/:id/archive` — archive only a trusted task after an optimistic version check.
- `POST /api/local/tasks/:id/execute` — the single execution claim path used by manual start and drag-to-`in_progress`. Repeated requests for the same task and trigger reuse the existing reservation; a different trigger remains protected by the start-in-progress conflict.

Each Base/table subject has a deterministic isolated project id: `feishu-` plus the first 16 hexadecimal characters of `sha256(baseToken:tableId)`. The Bridge and Taskboard must use this same rule; existing legacy project ids are not rewritten automatically, and newly delivered tasks use the 16-character form.

Use the workflow panel to paste either a direct Feishu `/base/{base_token}` link or a knowledge-base `/wiki/{wiki_token}` link from an official `https://*.feishu.cn` domain. Taskboard passes the complete link to the loopback Bridge for read-only metadata. For Wiki links, the Bridge first confirms that the node is a bitable and resolves its real Base token while preserving the optional `table` selection; the Wiki token is never treated as a Base identity. Every discovered table remains a draft until it is explicitly shown and enabled, and display visibility remains independent from Bridge enablement. `/base/workspace/{token}` links are still unsupported. Wiki imports require the Feishu application used by the Bridge to have read access to the Wiki node.

Each subject draft independently stores its one trigger field/value, manual or automatic execution mode, package alias, concurrency limits, and upload policy. Enabling performs live metadata and local package validation before replacing the active Bridge snapshot. Exported shared configuration omits credentials, workspace paths, ZIP source paths, upload paths, runtime state, and task history. Import first shows live Bridge plus local binding diagnostics, lists the actual warning/error messages for confirmation, and always writes subjects as drafts.
Refreshing metadata for an already-enabled subject creates a new local draft and leaves the last validated Bridge snapshot active until that draft is explicitly enabled.

Automatic execution is an explicit server policy (`allowAutomaticExecution`) and remains off unless the local deployment enables it with `CODEX_TASKBOARD_ALLOW_AUTOMATIC_EXECUTION`. A successful Auto-Cut run remains `in_progress` until its Jianying ZIP is validated and SHA-256 hashed; that verified ZIP moves manual tasks to `in_review` and automatic tasks to `done`. Automatic upload configuration queues automatic tasks after ZIP verification and queues manual tasks after acceptance moves them to `done`; manual upload configuration leaves enqueueing to the completed-task UI. Upload jobs copy the verified artifact to a configured local or UNC/NAS destination with per-subject concurrency, manual retry, and conflict protection.

The current artifact source is `manual_select`: choose the complete ZIP from the task detail. `watch_directory` and `driver_report` remain reserved configuration values and are not enabled in the UI until their collectors are implemented.

### Unified Feishu subject workflow board

For a Feishu subject, the Base and subject selected in the sidebar are the only scope of the workflow board. Tasks, saved views, stage names, and descriptions from another Base or subject never enter the current page. On first entry, Taskboard creates only the protected `All stages` system view, which lists the available stages in their stable order. It cannot be edited or deleted, and Taskboard does not pre-create business views such as an editing or upload view.

To make a board for a particular workflow, choose `New view`, enter a name, select the required stages, arrange their order, and choose `Save`. You can then select that view from the workflow board and use `Manage views` to copy, edit, make default, or delete a custom view. Views and filters change only the current subject's display; they do not change a task's actual status or affect another subject. In that subject's stage-display settings, stage names and descriptions can be changed to explain when cards appear. Those labels are descriptive only: they do not change Auto-Cut, review, or upload execution rules.

Hidden stages do not lose work. The board keeps counts for tasks, verified ZIPs, and failed uploads in hidden stages. To find a hidden task, set `Search scope` to `All stages`; a result can temporarily reveal its stage without changing the saved view. ZIP details are folded by default and can be opened with a pointer or keyboard; failed-upload details open automatically so their retry state is visible. Upload columns are read-only, so dragging cannot change upload state; enqueue, the upload worker, and retry actions continue to drive those states. Ordinary tasks remain under the `Other tasks` tab instead of being mixed into the subject workflow.

Ordinary local projects keep their `node mode`; Feishu subjects use the unified workflow board and do not show the node-mode entry. From the project menu, archiving moves a local project to `Archived / history`, where it can be restored. Only an empty manually-created project can be deleted permanently, and that deletion cannot be undone. Removing a Base or subject from Taskboard archives its local history and workflow views only; it does not delete the remote Feishu Base, table, or records. Re-adding the same subject restores its local history.

Base cells provide only controlled values and package aliases. They never provide a workspace path, shell command, prompt, credential, or upload destination; those bindings stay in the local Taskboard/Bridge configuration.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_TASKBOARD_HOST` | `127.0.0.1` | HTTP bind address; only loopback is allowed |
| `CODEX_TASKBOARD_PORT` | `47823` | Local HTTP port |
| `CODEX_TASKBOARD_DATA_DIR` | `.data` | SQLite data directory |
| `CODEX_TASKBOARD_URL` | `http://127.0.0.1:47823` | CLI API origin |
| `CODEX_TASKBOARD_ALLOW_AUTOMATIC_EXECUTION` | unset (off) | Set to `1`, `true`, `yes`, or `on` only on an explicitly approved local deployment |

`npm start` exposes the taskboard only on the local machine. Task, comment, and attachment changes are broadcast to every open local client through server-sent events; reconnecting clients perform a full refresh so changes made while disconnected are not missed.

## Share through Cloudflare

For two trusted collaborators, the taskboard can run on Cloudflare with Worker Static Assets and API routes, D1 as the authoritative business database, and a private R2 bucket for attachments. The deployment uses HTTPS Basic Authentication with a shared password and refreshes open boards after a global revision changes.

Each device keeps its own project checkout mapping and continues to use a local companion for Codex, Git/worktree, Skill, and MCP capabilities. Cloud mode never falls back to or double-writes the local SQLite database.

See [Cloud collaboration](docs/cloud-collaboration.md) for owner deployment, existing GitHub installation setup, password rotation, local path mapping, and the one-time local-data migration flow.

## Verify

```bash
npm run check
```

This runs TypeScript checking, a production frontend build, and the server/CLI/injection test suite.
