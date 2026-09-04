import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(
  new URL("../web/src/App.tsx", import.meta.url),
  "utf8",
);
const aiChatSource = await readFile(
  new URL("../web/src/components/AiChat.tsx", import.meta.url),
  "utf8",
);
const stylesSource = await readFile(
  new URL("../web/src/styles.css", import.meta.url),
  "utf8",
);

test("polls Codex sessions by the AiChat codex thread id", () => {
  const mappingBlock = appSource.match(
    /const taskCodexThreadIds = useMemo\([\s\S]*?\n  \), \[aiThreads\]\);/,
  )?.[0] ?? "";
  assert.match(
    mappingBlock,
    /aiThreads[\s\S]*?codexThreadId/,
    "Taskboard must map each task to the Codex session id exposed by AiChat",
  );
  const trackedBlock = appSource.match(
    /const trackedCodexThreadIds = useMemo\([\s\S]*?const trackedCodexThreadIdsKey/,
  )?.[0] ?? "";
  assert.match(
    trackedBlock,
    /taskCodexThreadIds\.get\(task\.id\)/,
    "Taskboard progress polling must use the mapped Codex session id",
  );
  assert.doesNotMatch(
    trackedBlock,
    /task\.threadId/,
    "Taskboard internal conversation ids must not be sent to the Codex session endpoint",
  );
});

test("AI chat launcher reflects panel state and renders outside board stacking contexts", () => {
  assert.match(aiChatSource, /aria-expanded=\{panelOpen\}/);
  assert.match(aiChatSource, /return createPortal\([\s\S]*?ai-chat-root/);
});

test("processing conversation shortcut remains clickable above the card detail overlay", () => {
  const processingShortcut = stylesSource.match(
    /\.task-processing-open\s*\{[\s\S]*?\n\}/,
  )?.[0] ?? "";
  assert.match(
    processingShortcut,
    /pointer-events:\s*auto/,
    "The execution conversation shortcut must opt back into pointer events",
  );
});

test("drag execution registers the returned local AI thread for progress tracking", () => {
  assert.match(
    appSource,
    /const execution = task\.status === "todo"[\s\S]*?executeTaskWithCodex\(task, "move"\)/,
    "Drag-to-processing must retain the execution response",
  );
  assert.match(
    appSource,
    /if \(execution\?\.thread\)[\s\S]*?setAiThreads\(/,
    "Drag-to-processing must publish the returned AI thread to the card presentation",
  );
});
