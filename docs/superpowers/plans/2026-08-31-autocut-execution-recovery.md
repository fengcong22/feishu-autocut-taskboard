# Auto-Cut execution recovery and drag idempotency

## Scope

Repair the reported failure when a Feishu task is dragged into `处理中` more
than once, while preserving the existing execution safeguards for genuinely
different tasks and execution rounds. Re-verify the earlier recovery fixes for
failed/interrupted Codex runs and trusted Auto-Cut packages that live outside a
Git workspace.

## Implementation

1. Add a coordinator regression test for concurrent/repeated scheduling of the
   same task and assert that the existing durable execution is returned and the
   task is started only once.
2. Make `createFeishuExecutionCoordinator.schedule()` idempotent for the same
   task and matching execution trigger while the existing reservation is active.
   Keep conflict behavior for a genuinely different trigger or execution state.
3. Add a synchronous `useRef` drag submission guard in `App.tsx`, keyed by task
   id, and release it after the move settles so one drop cannot issue duplicate
   start requests.
4. Add/retain focused tests covering the UI guard and the existing terminal
   recovery behavior that moves failed/interrupted trusted runs to `blocked` and
   clears their execution reservation.

## Verification

- `node --test test/feishu-execution-coordinator.test.mjs test/task-move-ui.test.mjs test/task-start-flow.test.mjs`
- `npm test`
- `npm run build --if-present`
- `./scripts/check-local.ps1`

After code changes, restart the local Taskboard/Bridge using the repository
scripts before manually retrying a real drag operation.
