import assert from "node:assert/strict";
import { test } from "node:test";

import {
  columnWidthPx,
  clearUnifiedWorkflowLayoutsForProject,
  normalizeUnifiedWorkflowLayout,
  readUnifiedWorkflowLayout,
  resetUnifiedWorkflowLayout,
  unifiedWorkflowLayoutStorageKey,
  unifiedWorkflowZipExpansionKey,
  writeUnifiedWorkflowLayout,
} from "../web/src/unifiedWorkflowLayout.mjs";

const PROJECT_A = "project-a";
const VIEW_A = "view-a";

function makeStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
    removeItem(key) {
      values.delete(String(key));
    },
    has(key) {
      return values.has(key);
    },
    raw(key) {
      return values.get(key) ?? null;
    },
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
  };
}

function withGlobalLocalStorage(storage, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    enumerable: false,
    value: storage,
    writable: false,
  });
  try {
    return callback();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
}

test("layout normalization clamps invalid dimensions", () => {
  assert.deepEqual(normalizeUnifiedWorkflowLayout({
    columnWidthPreset: "invalid",
    boardScrollLeft: -10,
    columnScrollTop: { in_progress: -4 },
  }, ["in_progress"]), {
    columnWidthPreset: "standard",
    cardDensity: "comfortable",
    boardScrollLeft: 0,
    columnScrollTop: { in_progress: 0 },
    zipExpansion: {},
  });
});

test("layout keys isolate projects and views", () => {
  assert.notEqual(
    unifiedWorkflowLayoutStorageKey(PROJECT_A, VIEW_A),
    unifiedWorkflowLayoutStorageKey(PROJECT_A, "view-b"),
  );
  assert.notEqual(
    unifiedWorkflowLayoutStorageKey(PROJECT_A, VIEW_A),
    unifiedWorkflowLayoutStorageKey("project-b", VIEW_A),
  );
  assert.equal(
    unifiedWorkflowLayoutStorageKey(PROJECT_A, VIEW_A),
    "taskboard.unified-board.layout.v1:project-a:view-a",
  );
});

test("layout normalization keeps valid settings and only active stages", () => {
  const expansionKey = unifiedWorkflowZipExpansionKey("task/1", "file:one.zip:2026-09-01");
  assert.equal(expansionKey, "zip:task%2F1:file%3Aone.zip%3A2026-09-01");
  assert.deepEqual(normalizeUnifiedWorkflowLayout({
    columnWidthPreset: "wide",
    cardDensity: "compact",
    boardScrollLeft: 127.5,
    columnScrollTop: {
      todo: 12,
      in_progress: 48,
      hidden: 99,
      __proto__: 3,
    },
    zipExpansion: {
      [expansionKey]: true,
      "zip:task-2:artifact-2": false,
      "task:task-3": true,
      "zip:task-4": "true",
      "zip:\u0000bad:artifact": true,
    },
  }, ["in_progress", "todo"]), {
    columnWidthPreset: "wide",
    cardDensity: "compact",
    boardScrollLeft: 127.5,
    columnScrollTop: { todo: 12, in_progress: 48 },
    zipExpansion: {
      [expansionKey]: true,
      "zip:task-2:artifact-2": false,
    },
  });
});

test("normalization returns safe defaults for malformed input and positions", () => {
  assert.deepEqual(normalizeUnifiedWorkflowLayout({
    cardDensity: "dense",
    boardScrollLeft: Number.NaN,
    columnScrollTop: {
      todo: Number.POSITIVE_INFINITY,
      queued: -2,
      in_progress: "40",
    },
    zipExpansion: null,
  }, ["todo", "queued", "in_progress"]), {
    columnWidthPreset: "standard",
    cardDensity: "comfortable",
    boardScrollLeft: 0,
    columnScrollTop: { todo: 0, queued: 0, in_progress: 0 },
    zipExpansion: {},
  });
  assert.deepEqual(normalizeUnifiedWorkflowLayout(null), {
    columnWidthPreset: "standard",
    cardDensity: "comfortable",
    boardScrollLeft: 0,
    columnScrollTop: {},
    zipExpansion: {},
  });
});

test("layout storage round-trips normalized values and resets by project/view", () => {
  const storage = makeStorage();
  withGlobalLocalStorage(storage, () => {
    const value = writeUnifiedWorkflowLayout(PROJECT_A, VIEW_A, {
      columnWidthPreset: "narrow",
      cardDensity: "compact",
      boardScrollLeft: -4,
      columnScrollTop: { todo: 9, hidden: 5 },
      zipExpansion: { "zip:task-1:artifact-1": true, unsafe: true },
    });
    assert.deepEqual(value, {
      columnWidthPreset: "narrow",
      cardDensity: "compact",
      boardScrollLeft: 0,
      columnScrollTop: { todo: 9 },
      zipExpansion: { "zip:task-1:artifact-1": true },
    });
    assert.deepEqual(readUnifiedWorkflowLayout(PROJECT_A, VIEW_A, ["todo"]), value);
    assert.equal(storage.has(unifiedWorkflowLayoutStorageKey(PROJECT_A, VIEW_A)), true);

    const defaults = resetUnifiedWorkflowLayout(PROJECT_A, VIEW_A);
    assert.deepEqual(defaults, {
      columnWidthPreset: "standard",
      cardDensity: "comfortable",
      boardScrollLeft: 0,
      columnScrollTop: {},
      zipExpansion: {},
    });
    assert.equal(storage.has(unifiedWorkflowLayoutStorageKey(PROJECT_A, VIEW_A)), false);
    assert.deepEqual(readUnifiedWorkflowLayout(PROJECT_A, VIEW_A), defaults);
  });
});

test("project cleanup removes only that project's saved workflow layouts", () => {
  const storage = makeStorage();
  const projectB = "project-b";
  const otherKey = "taskboard.unified-board.layout.v1:project-a-archive:view-a";
  withGlobalLocalStorage(storage, () => {
    storage.setItem(unifiedWorkflowLayoutStorageKey(PROJECT_A, "all"), "{}");
    storage.setItem(unifiedWorkflowLayoutStorageKey(PROJECT_A, "editing"), "{}");
    storage.setItem(unifiedWorkflowLayoutStorageKey(projectB, VIEW_A), "{}");
    storage.setItem(otherKey, "{}");

    clearUnifiedWorkflowLayoutsForProject(PROJECT_A);

    assert.equal(storage.has(unifiedWorkflowLayoutStorageKey(PROJECT_A, "all")), false);
    assert.equal(storage.has(unifiedWorkflowLayoutStorageKey(PROJECT_A, "editing")), false);
    assert.equal(storage.has(unifiedWorkflowLayoutStorageKey(projectB, VIEW_A)), true);
    assert.equal(storage.has(otherKey), true);
  });
});

test("malformed or unavailable localStorage never escapes the layout helpers", () => {
  const throwingStorage = {
    getItem() {
      throw new Error("storage disabled");
    },
    setItem() {
      throw new Error("storage disabled");
    },
    removeItem() {
      throw new Error("storage disabled");
    },
  };

  withGlobalLocalStorage(throwingStorage, () => {
    assert.deepEqual(readUnifiedWorkflowLayout(PROJECT_A, VIEW_A), {
      columnWidthPreset: "standard",
      cardDensity: "comfortable",
      boardScrollLeft: 0,
      columnScrollTop: {},
      zipExpansion: {},
    });
    assert.doesNotThrow(() => writeUnifiedWorkflowLayout(PROJECT_A, VIEW_A, {}));
    assert.doesNotThrow(() => resetUnifiedWorkflowLayout(PROJECT_A, VIEW_A));
  });

  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage unavailable");
      },
    });
    assert.doesNotThrow(() => readUnifiedWorkflowLayout(PROJECT_A, VIEW_A));
    assert.doesNotThrow(() => writeUnifiedWorkflowLayout(PROJECT_A, VIEW_A, {}));
    assert.doesNotThrow(() => resetUnifiedWorkflowLayout(PROJECT_A, VIEW_A));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
});

test("column width presets expose stable pixel values", () => {
  assert.equal(columnWidthPx("narrow"), 280);
  assert.equal(columnWidthPx("standard"), 340);
  assert.equal(columnWidthPx("wide"), 420);
  assert.equal(columnWidthPx("invalid"), 340);
});
