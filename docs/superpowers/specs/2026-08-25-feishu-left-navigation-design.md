# Feishu Base Left Navigation

## Scope

This first UI slice moves the existing Feishu Base and subject catalog from
the top of the workspace into the Taskboard's left navigation. It keeps the
current subject-level project model and does not change Bridge routing,
Auto-Cut execution, upload behavior, or Feishu data.

## User Flow

1. Open Taskboard.
2. In the left navigation, open the `Feishu Bases` section.
3. Paste a Base or Wiki URL through the add control. The existing local
   preview endpoint reads its Base and table metadata.
4. Expand a Base to see the subjects selected for display.
5. Select a subject to open its existing task board in the central workspace.
6. Use the configuration action to open the existing full configuration
   surface for adding hidden subjects, editing a draft, and enabling it.

## Layout

- The left navigation has a dedicated `Feishu Bases` section below ordinary
  navigation and above connection controls.
- Each Base is a collapsible tree node. Expansion is local UI state and does
  not change any Feishu configuration.
- Only `displayEnabled` subjects appear in the normal tree. The configuration
  surface retains the distinction between visible and hidden subjects.
- The selected subject has the same active treatment as existing navigation
  items.
- A compact action opens configuration rather than embedding a second copy of
  the catalog above the board.
- On narrow screens, the existing responsive navigation behavior remains in
  control; this slice does not introduce a new mobile drawer.

## Data and Boundaries

- Catalog source: `GET /api/local/feishu/workflow/catalog` through
  `listFeishuWorkflowCatalog`.
- Adding a Base continues to use the existing preview route and refreshes the
  catalog and project list before a subject is selected.
- Selecting a subject continues to call `changeProject(subject.projectId,
  "issues")`, so task retrieval and mutations remain scoped to that subject.
- The Base node is navigation and expansion only in this slice. A Base-wide
  aggregate board needs a separate task-query model because the current API
  returns tasks by one subject project at a time.
- Local removal of a Base and configurable workflow stages are explicitly
  deferred; neither exists in the current persisted API and should be designed
  as separate slices rather than simulated in the navigation.

## Verification

- Existing Feishu workflow UI tests will cover the preserved add, select,
  configuration, and visibility hooks.
- Add focused source-level coverage for the left navigation placement,
  collapsible Base tree, and removal of the duplicate compact panel from the
  central board.
- Run the focused tests, TypeScript check, and production web build.
- Manually inspect the local Taskboard at desktop and narrow widths.

## Non-goals

- No real Auto-Cut invocation.
- No automatic ZIP discovery or upload execution changes.
- No writes to Feishu records.
- No change to loopback-only networking.
