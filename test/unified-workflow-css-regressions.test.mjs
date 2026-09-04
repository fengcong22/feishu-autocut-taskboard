import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const boardSource = () => readFile(
  new URL("../web/src/components/UnifiedWorkflowBoard.tsx", import.meta.url),
  "utf8",
);
const stylesSource = () => readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

test("upload loading banner does not share its layout class with card status labels", async () => {
  const [board, styles] = await Promise.all([boardSource(), stylesSource()]);

  assert.match(board, /className=\{`unified-workflow-upload-banner\$\{uploadError/);
  assert.match(board, /<span className="unified-workflow-upload-status">\{status\}<\/span>/);
  assert.match(styles, /\.unified-workflow-upload-banner\s*\{/);
  assert.match(styles, /\.unified-workflow-upload-banner\.is-error\s*\{/);
});

test("mobile workflow grid creates one column per rendered stage", async () => {
  const styles = await stylesSource();
  const mobileStyles = styles.slice(styles.lastIndexOf("@media (max-width: 719px)"));

  assert.match(mobileStyles, /\.unified-workflow-board-grid\s*\{[\s\S]*?grid-template-columns:\s*none;/);
  assert.match(mobileStyles, /\.unified-workflow-board-grid\s*\{[\s\S]*?grid-auto-flow:\s*column;/);
  assert.doesNotMatch(mobileStyles, /repeat\(9\s*,/);
});

test("upload rows keep metadata and actions on explicit grid rows", async () => {
  const styles = await stylesSource();

  assert.match(styles, /\.unified-workflow-upload-row\s*\{[\s\S]*?grid-template-columns:\s*14px minmax\(0, 1fr\) auto auto auto;/);
  assert.match(styles, /\.unified-workflow-upload-row > svg\s*\{[\s\S]*?grid-row:\s*1;/);
  assert.match(styles, /\.unified-workflow-upload-filename\s*\{[\s\S]*?grid-row:\s*1;/);
  assert.match(styles, /\.unified-workflow-upload-status\s*\{[\s\S]*?grid-row:\s*1;/);
  assert.match(styles, /\.unified-workflow-upload-row time\s*\{[\s\S]*?grid-row:\s*1;/);
  assert.match(styles, /\.unified-workflow-upload-retry\s*\{[\s\S]*?grid-row:\s*1;/);
  assert.match(styles, /\.unified-workflow-upload-error\s*\{[\s\S]*?grid-row:\s*2;/);
  assert.match(styles, /\.unified-workflow-upload-target\s*\{[\s\S]*?grid-row:\s*2;/);
});

test("workflow view manager keeps many saved views in a compact scrollable list", async () => {
  const styles = await stylesSource();
  const narrowStyles = styles.slice(styles.lastIndexOf("@media (max-width: 900px)"));

  assert.match(styles, /\.unified-view-manager\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(styles, /\.unified-view-manager-list\s*\{[\s\S]*?max-height:/);
  assert.match(styles, /\.unified-view-manager-list\s*\{[\s\S]*?overflow-y:\s*auto;/);
  assert.match(styles, /\.unified-view-manager-item\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto;/);
  assert.match(narrowStyles, /\.unified-view-manager-item\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/);
});

test("workflow view controls retain visible keyboard focus and scroll on short screens", async () => {
  const styles = await stylesSource();
  const shortViewport = styles.slice(styles.indexOf("@media (max-height:"));

  assert.match(
    styles,
    /\.unified-view-controls-toolbar > select:focus-visible,[\s\S]*?\.unified-search-scope > select:focus-visible,[\s\S]*?\.unified-view-editor > label input:focus-visible\s*\{[^}]*border-color:[^}]*box-shadow:/,
  );
  assert.match(shortViewport, /\.unified-view-editor\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto;/);
});

test("unified board uses a dynamic stage count and synchronized column width variable", async () => {
  const styles = await stylesSource();
  assert.doesNotMatch(styles, /\.unified-workflow-board-grid\s*\{[^}]*repeat\(8\s*,/s);
  assert.match(styles, /\.unified-workflow-board-grid\s*\{[^}]*--unified-stage-count|grid-template-columns:\s*repeat\(var\(--unified-stage-count/s);
  assert.match(styles, /--unified-column-width/);
  assert.match(styles, /\.unified-workflow-column-list\s*\{[\s\S]*?overflow-y:\s*auto;/);
  assert.match(styles, /\.unified-workflow-board-scroll\s*\{[\s\S]*?overflow-x:\s*auto;/);
  assert.match(styles, /unified-workflow-board\.is-panning|cursor:\s*grab/);
});
