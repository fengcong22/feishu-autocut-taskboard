# Feishu Base Left Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the existing Feishu Base and visible-subject catalog in Taskboard's left navigation while preserving the current subject-to-project board path.

**Architecture:** Add a focused `FeishuBaseNavigator` presentation component that owns only Base expansion and URL input state. `App.tsx` continues to own catalog persistence, subject selection, project switching, and configuration mode. The existing full `FeishuWorkflowPanel` remains the settings surface; its compact copy above the board is removed.

**Tech Stack:** React 18, TypeScript, Vite, CSS, Node.js `node:test` source-contract tests.

## Global Constraints

- Keep Bridge routing, Auto-Cut execution, ZIP handling, upload behavior, and Feishu records unchanged.
- Reuse `GET /api/local/feishu/workflow/catalog` and the existing Base preview request.
- Selecting a subject must continue through `changeProject(subject.projectId, "issues")`.
- A Base heading only expands or collapses in this slice; it does not aggregate child-project tasks.
- Only subjects with `displayEnabled === true` appear in the normal navigation tree.
- Do not revert or rewrite unrelated uncommitted work in the Taskboard worktree.

---

### Task 1: Left Base Navigator

**Files:**
- Create: `web/src/components/FeishuBaseNavigator.tsx`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `catalog: FeishuBaseCatalog[]`, `selectedSubjectKey: string | null`, `busy: boolean`, `onAddBase(url: string)`, `onSelectSubject(subjectKey: string)`, and `onOpenConfiguration()`.
- Produces: `FeishuBaseNavigator`, a vertical navigation section with collapsible Base rows and visible subject rows.

- [ ] **Step 1: Add the focused component**

```tsx
export interface FeishuBaseNavigatorProps {
  catalog: FeishuBaseCatalog[];
  selectedSubjectKey: string | null;
  busy?: boolean;
  onAddBase: (url: string) => Promise<void> | void;
  onSelectSubject: (subjectKey: string) => void;
  onOpenConfiguration: () => void;
  onError?: (message: string) => void;
}
```

Initialize expanded Base tokens from Bases that contain the selected subject, otherwise expand the first Base. Toggle membership from a button with `aria-expanded`; render only `base.subjects.filter((subject) => subject.displayEnabled)`.

- [ ] **Step 2: Wire the component to the existing operation path**

Import `FeishuBaseNavigator` in `App.tsx`. Render it in `.app-nav` below ordinary navigation. Route its handlers as follows:

```tsx
onAddBase={async (url) => {
  const base = await addFeishuBaseAndRefreshProjects(url);
  setFeishuCatalog((current) => [
    ...current.filter((item) => item.baseToken !== base.baseToken),
    base,
  ]);
}}
onSelectSubject={(subjectKey) => {
  const subject = feishuCatalog
    .flatMap((base) => base.subjects)
    .find((item) => item.subjectKey === subjectKey);
  if (!subject) return;
  setSelectedFeishuSubjectKey(subjectKey);
  changeProject(subject.projectId, "issues");
}}
onOpenConfiguration={() => selectBoardView("workflow")}
```

Use the existing App-level error setter for rejected add requests.

- [ ] **Step 3: Remove the duplicate central navigator**

Delete the `selectedProjectIsFeishuSubject && boardView !== "workflow"` compact `FeishuWorkflowPanel` render branch. Keep the full `FeishuWorkflowPanel` inside `boardView === "workflow"` unchanged.

- [ ] **Step 4: Run TypeScript validation**

Run: `npm run typecheck`

Expected: exit code 0 with no TypeScript errors.

### Task 2: Navigation Styling and Direct Verification

**Files:**
- Modify: `web/src/styles.css`
- Modify: `test/feishu-workflow-ui.test.mjs`

**Interfaces:**
- Consumes: class names emitted by `FeishuBaseNavigator`.
- Produces: a stable vertical tree that fits the existing 220px navigation column without changing board dimensions.

- [ ] **Step 1: Add scoped navigation styles**

Add styles for `.feishu-base-nav`, `.feishu-base-nav-header`, `.feishu-base-nav-add`, `.feishu-base-nav-tree`, `.feishu-base-nav-row`, and `.feishu-subject-nav-item`. Use existing CSS variables, 5px control radii, fixed 28px row heights, ellipsis for long names, and a rotated chevron for expanded Bases. Do not introduce a new palette or nested cards.

- [ ] **Step 2: Update the focused source contract**

Add assertions that:

```js
assert.match(navigator, /FeishuBaseNavigator/);
assert.match(navigator, /aria-expanded/);
assert.match(navigator, /displayEnabled/);
assert.match(app, /<FeishuBaseNavigator/);
assert.doesNotMatch(app, /<FeishuWorkflowPanel[\s\S]*?compact=\{true\}/);
```

This records the user-confirmed direct UI path after implementation, consistent with the repository rule that protection follows the working path.

- [ ] **Step 3: Run focused verification**

Run: `node --test test/feishu-workflow-ui.test.mjs test/board-views.test.mjs`

Expected: all focused tests pass.

- [ ] **Step 4: Build the web application**

Run: `npm run build:web`

Expected: Vite production build completes successfully.

- [ ] **Step 5: Inspect the running UI**

Start or reuse the loopback services, open `http://127.0.0.1:47823/`, and verify:

1. Base names appear in the left navigation.
2. Base rows expand and collapse without changing the central task board.
3. A visible subject opens its existing project board.
4. The former horizontal navigator no longer appears above the board.
5. The configuration action opens the existing full settings surface.
6. Long Base and subject names remain contained at desktop and narrow widths.
