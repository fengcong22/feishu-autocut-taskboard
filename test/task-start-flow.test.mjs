import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer as createTaskboardServerBase } from "../server/index.mjs";
import { subjectProjectId } from "../server/feishu-workflow-store.mjs";
import { createResourceScheduler } from "../server/resource-scheduler.mjs";

const FEISHU_SUBJECT_KEY = "bas_fixture:tbl_fixture";
const FEISHU_PROJECT_ID = subjectProjectId(FEISHU_SUBJECT_KEY);
const TEST_FEISHU_BRIDGE_SECRET = "fixture-feishu-bridge-secret-2026";
const createTaskboardServer = (options = {}) => createTaskboardServerBase({
  feishuBridgeSecret: TEST_FEISHU_BRIDGE_SECRET,
  ...options,
});

async function waitForTask(baseUrl, taskId, predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await request(baseUrl, `/api/tasks/${taskId}`);
    if (predicate(result.body.task)) return result.body.task;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for task '${taskId}'`);
}

async function waitForRun(baseUrl, threadId, predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await request(baseUrl, `/api/local/ai/threads/${threadId}`);
    const run = result.body.runs.at(-1);
    if (run && predicate(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for AI run on thread '${threadId}'`);
}

async function waitForTaskAiStartSettled(app, taskId, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!app.database.listTaskAiStarts().some((claim) => claim.taskId === taskId)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for task '${taskId}' AI start to settle`);
}

async function createFixture({
  packageWorkspacePath,
  packagePrompt = "trusted fixture prompt",
  catalogModels = [{
    slug: "fixture",
    default_reasoning_level: "low",
    supported_reasoning_levels: [{ effort: "low" }],
  }],
  failSkillDiscovery = false,
  turnDelayMs = 0,
  allowAutomaticExecution = false,
  feishuPackageStore,
  resourceScheduler,
} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-start-flow-"));
  const workspacePath = path.join(directory, "workspace");
  await mkdir(workspacePath);
  const workspace = await realpath(workspacePath);
  const codexExecutable = path.join(directory, "fake-codex.mjs");
  await writeFile(codexExecutable, `
const args = process.argv.slice(2);
if (args[0] === "debug") {
  process.stdout.write(${JSON.stringify(JSON.stringify({ models: catalogModels }))});
} else if (args[0] === "app-server") {
  if (${JSON.stringify(failSkillDiscovery)}) process.exit(1);
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id === 1) process.stdout.write('{"id":1,"result":{}}\\n');
      if (message.id === 2) process.stdout.write('{"id":2,"result":{"data":[]}}\\n');
    }
  });
} else {
  process.stdin.setEncoding("utf8");
  let prompt = "";
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => {
    process.stdout.write('{"type":"thread.started","thread_id":"fixture-session"}\\n');
    setTimeout(() => {
      process.stdout.write(prompt.includes("FAIL")
        ? '{"type":"turn.failed","error":{"message":"fixture failure"}}\\n'
        : '{"type":"turn.completed"}\\n');
    }, ${JSON.stringify(turnDelayMs)});
  });
}
`);
  await chmod(codexExecutable, 0o755);
  await writeFile(path.join(directory, "codex-state.json"), JSON.stringify({
    "local-projects": { "auto-cut-copy-a": { rootPaths: [workspace] } },
  }));
  const packagesPath = path.join(directory, "feishu-packages.json");
  await writeFile(packagesPath, JSON.stringify({
    packages: {
      "Auto-cut-copyA": {
        projectId: "auto-cut-copy-a",
        workspacePath: packageWorkspacePath ?? workspace,
        prompt: packagePrompt,
      },
    },
  }));
  await writeFile(path.join(directory, "AGENTS.md"), "fixture");
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable,
    codexStatePath: path.join(directory, "codex-state.json"),
    skillPath: path.join(directory, "AGENTS.md"),
    feishuPackagesPath: packagesPath,
    feishuPackageStore,
    resourceScheduler,
    allowAutomaticExecution,
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  app.database.createProject({
    id: FEISHU_PROJECT_ID,
    name: "Fixture subject",
    workspacePath: workspace,
  });
  return { app, baseUrl: `http://127.0.0.1:${address.port}`, directory, packagesPath, workspace };
}

async function request(baseUrl, pathname, options = {}) {
  const ordinary = options.ordinary === true;
  const rawFeishu = options.rawFeishu === true;
  const body = options.body;
  const isFeishuCreate = !ordinary
    && !rawFeishu
    && pathname === "/api/tasks"
    && options.method === "POST"
    && body && typeof body === "object"
    && typeof body.description === "string"
    && body.description.includes("feishu-codex-task");
  const requestPath = isFeishuCreate ? "/api/local/feishu/tasks" : pathname;
  const subjectKey = isFeishuCreate
    ? JSON.parse(Buffer.from(
      body.description.match(/feishu-codex-task:v1:([A-Za-z0-9_-]+)/u)[1],
      "base64url",
    ).toString("utf8")).subjectKey
    : null;
  const requestBody = isFeishuCreate
    ? {
      ...body,
      projectId: subjectProjectId(subjectKey),
      status: body.status === "blocked" ? "blocked" : "todo",
    }
    : body;
  const requestedStatus = isFeishuCreate && body.status !== undefined
    ? body.status
    : null;
  const response = await fetch(`${baseUrl}${requestPath}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(isFeishuCreate
        ? {
          "x-taskboard-client": "feishu-bridge",
          "x-feishu-bridge-secret": TEST_FEISHU_BRIDGE_SECRET,
        }
        : {}),
      ...options.headers,
    },
    body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
  });
  const text = await response.text();
  const result = { response, body: text ? JSON.parse(text) : undefined };
  if (
    isFeishuCreate
    && result.body?.task
    && requestedStatus
    && !["todo", "blocked"].includes(requestedStatus)
  ) {
    const moved = await request(baseUrl, `/api/tasks/${encodeURIComponent(result.body.task.id)}`, {
      method: "PATCH",
      body: { version: result.body.task.version, status: requestedStatus },
    });
    if (moved.body?.task) result.body.task = moved.body.task;
  }
  return result;
}

function feishuOrigin() {
  return {
    version: 1,
    source: "feishu-base",
    eventId: "fixture-event",
    baseToken: "bas_fixture",
    tableId: "tbl_fixture",
    subjectKey: FEISHU_SUBJECT_KEY,
    recordId: "rec_fixture",
    triggerField: "video-progress",
    triggerValue: "ready-to-edit",
    mode: "manual",
    packageAlias: "Auto-cut-copyA",
  };
}

function feishuDescription() {
  const metadata = {
    ...feishuOrigin(),
    prompt: "tampered description prompt",
  };
  const encoded = Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
  return `<!-- feishu-codex-task:v1:${encoded} -->\n\nfixture prompt`;
}

function feishuDescriptionWith(overrides = {}) {
  const metadata = {
    ...feishuOrigin(),
    ...overrides,
  };
  const encoded = Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
  return `<!-- feishu-codex-task:v1:${encoded} -->\n\nfixture prompt`;
}

function automaticFeishuDescription() {
  const metadata = {
    version: 1,
    source: "feishu-base",
    eventId: "fixture-auto-event",
    baseToken: "bas_fixture",
    tableId: "tbl_fixture",
    subjectKey: FEISHU_SUBJECT_KEY,
    recordId: "rec_fixture_auto",
    triggerField: "video-progress",
    triggerValue: "ready-to-edit",
    mode: "automatic",
    executionMode: "automatic",
    packageAlias: "Auto-cut-copyA",
  };
  const encoded = Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
  return `<!-- feishu-codex-task:v1:${encoded} -->\n\nfixture prompt`;
}

test("manual start creates and runs a task-linked local Codex thread", async () => {
  const fixture = await createFixture();
  try {
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: { id: "auto-cut-copy-a", name: "Auto-cut-copyA", workspacePath: fixture.workspace },
    });
    assert.equal(project.response.status, 201);
    const task = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "auto-cut-copy-a",
        title: "Ready Demo",
        description: feishuDescription(),
        status: "todo",
        priority: "high",
        labels: ["feishu"],
      },
    });
    assert.equal(task.response.status, 201);
    const started = await request(fixture.baseUrl, `/api/tasks/${task.body.task.id}/start-ai`, {
      method: "POST",
      body: {},
    });
    assert.equal(started.response.status, 202);
    assert.equal(typeof started.body.thread.id, "string");
    assert.equal(typeof started.body.run.id, "string");
    assert.equal(started.body.task.status, "in_progress");
    assert.equal(started.body.task.threadId, started.body.thread.id);

    await waitForRun(
      fixture.baseUrl,
      started.body.thread.id,
      (current) => current.status === "completed",
    );
    await waitForTaskAiStartSettled(fixture.app, task.body.task.id);
    const completedTask = fixture.app.database.getTask(task.body.task.id);
    assert.equal(completedTask.status, "in_progress");
    assert.equal(fixture.app.database.getFeishuExecution(task.body.task.id), null);

    const snapshot = await request(
      fixture.baseUrl,
      `/api/local/ai/threads/${started.body.thread.id}`,
    );
    assert.equal(snapshot.response.status, 200);
    assert.equal(snapshot.body.events[0].content, "trusted fixture prompt");
    const activities = await request(
      fixture.baseUrl,
      `/api/tasks/${task.body.task.id}/activities`,
    );
    assert.equal(activities.response.status, 200);
    assert.equal(activities.body.activities.some((activity) => Object.hasOwn(activity, "rowid")), false);

    const blocked = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "local",
        title: "Blocked",
        description: "blocked package",
        status: "blocked",
        priority: "high",
        labels: ["feishu"],
      },
    });
    const blockedStart = await request(
      fixture.baseUrl,
      `/api/tasks/${blocked.body.task.id}/start-ai`,
      { method: "POST", body: {} },
    );
    assert.equal(blockedStart.response.status, 409);
    assert.equal(blockedStart.body.error.code, "TASK_NOT_STARTABLE");
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("manual start resolves a trusted package independently from the subject project", async () => {
  const fixture = await createFixture();
  try {
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: { id: "wrong-project", name: "Wrong project", workspacePath: null },
    });
    assert.equal(project.response.status, 201);
    const task = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "wrong-project",
        title: "Forged task",
        description: feishuDescription(),
        status: "todo",
        priority: "high",
        labels: ["feishu"],
      },
    });
    const started = await request(fixture.baseUrl, `/api/tasks/${task.body.task.id}/start-ai`, {
      method: "POST",
      body: {},
    });
    assert.equal(started.response.status, 202);
    assert.equal(started.body.task.projectId, FEISHU_PROJECT_ID);
    assert.equal(started.body.thread.origin.projectId, FEISHU_PROJECT_ID);
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("manual start rejects a ready task that already has a conversation", async () => {
  const fixture = await createFixture();
  try {
    const actor = { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };
    fixture.app.database.createProject({
      id: "auto-cut-copy-a",
      name: "Auto-cut-copyA",
      workspacePath: fixture.workspace,
    });
    const task = fixture.app.database.createTask({
      projectId: "auto-cut-copy-a",
      title: "Existing conversation",
      description: feishuDescription(),
      status: "todo",
      priority: "high",
      labels: ["feishu"],
      feishuOrigin: feishuOrigin(),
      actor,
      assignee: actor,
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    const thread = await fixture.app.aiChat.createThread({
      projectId: task.projectId,
      issueId: task.id,
      title: "Existing conversation",
      sandbox: "workspace-write",
    });
    const linked = fixture.app.database.updateTask(
      task.id,
      task.version,
      {},
      thread.id,
      actor,
    );

    const started = await request(fixture.baseUrl, `/api/tasks/${task.id}/start-ai`, {
      method: "POST",
      body: {},
    });
    assert.equal(started.response.status, 409);
    const current = fixture.app.database.getTask(task.id);
    assert.equal(current.status, "todo");
    assert.equal(current.threadId, linked.threadId);
    assert.deepEqual(fixture.app.database.listTaskAiStarts(), []);
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("failed Codex runs move the linked task to blocked", async () => {
  const fixture = await createFixture({ packagePrompt: "FAIL" });
  try {
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: { id: "auto-cut-copy-a", name: "Auto-cut-copyA", workspacePath: fixture.workspace },
    });
    assert.equal(project.response.status, 201);
    const task = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "auto-cut-copy-a",
        title: "Failing Demo",
        description: feishuDescription(),
        status: "todo",
        priority: "high",
        labels: ["feishu"],
      },
    });
    const started = await request(fixture.baseUrl, `/api/tasks/${task.body.task.id}/start-ai`, {
      method: "POST",
      body: {},
    });
    assert.equal(started.response.status, 202);
    const failedTask = await waitForTask(
      fixture.baseUrl,
      task.body.task.id,
      (current) => current.status === "blocked",
    );
    assert.equal(failedTask.status, "blocked");
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("manual status changes during a run are preserved and clear the AI start claim", async () => {
  const fixture = await createFixture({ turnDelayMs: 200 });
  try {
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: { id: "auto-cut-copy-a", name: "Auto-cut-copyA", workspacePath: fixture.workspace },
    });
    assert.equal(project.response.status, 201);
    const task = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "auto-cut-copy-a",
        title: "Manual run status",
        description: feishuDescription(),
        status: "todo",
        priority: "high",
        labels: ["feishu"],
      },
    });
    const started = await request(fixture.baseUrl, `/api/tasks/${task.body.task.id}/start-ai`, {
      method: "POST",
      body: {},
    });
    assert.equal(started.response.status, 202);
    const moved = await request(fixture.baseUrl, `/api/tasks/${task.body.task.id}`, {
      method: "PATCH",
      body: {
        version: started.body.task.version,
        status: "blocked",
        threadId: started.body.thread.id,
      },
    });
    assert.equal(moved.response.status, 200);

    await waitForRun(
      fixture.baseUrl,
      started.body.thread.id,
      (run) => run.status === "completed",
    );
    assert.equal(fixture.app.database.getTask(task.body.task.id).status, "blocked");
    assert.deepEqual(fixture.app.database.listTaskAiStarts(), []);
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("concurrent manual starts claim the task once and create one AI thread", async () => {
  const fixture = await createFixture();
  try {
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: { id: "auto-cut-copy-a", name: "Auto-cut-copyA", workspacePath: fixture.workspace },
    });
    assert.equal(project.response.status, 201);
    const task = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "auto-cut-copy-a",
        title: "Concurrent demo",
        description: feishuDescription(),
        status: "todo",
        priority: "high",
        labels: ["feishu"],
      },
    });

    const [first, second] = await Promise.all([
      request(fixture.baseUrl, `/api/tasks/${task.body.task.id}/start-ai`, {
        method: "POST",
        body: {},
      }),
      request(fixture.baseUrl, `/api/tasks/${task.body.task.id}/start-ai`, {
        method: "POST",
        body: {},
      }),
    ]);
    assert.deepEqual(
      [first.response.status, second.response.status].sort((left, right) => left - right),
      [202, 409],
    );

    const threads = await request(fixture.baseUrl, "/api/local/ai/threads");
    assert.equal(threads.response.status, 200);
    assert.equal(threads.body.threads.length, 1);
    assert.equal(threads.body.threads[0].origin.issueId, task.body.task.id);
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("unavailable trusted workspace leaves the task ready and creates no thread", async () => {
  const fixture = await createFixture();
  try {
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: { id: "auto-cut-copy-a", name: "Auto-cut-copyA", workspacePath: fixture.workspace },
    });
    assert.equal(project.response.status, 201);
    const task = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "auto-cut-copy-a",
        title: "Missing workspace demo",
        description: feishuDescription(),
        status: "todo",
        priority: "high",
        labels: ["feishu"],
      },
    });
    await rename(fixture.workspace, `${fixture.workspace}-unavailable`);

    const started = await request(
      fixture.baseUrl,
      `/api/tasks/${task.body.task.id}/start-ai`,
      { method: "POST", body: {} },
    );
    assert.equal(started.response.status, 409);
    assert.equal(started.body.error.code, "PACKAGE_WORKSPACE_UNAVAILABLE");

    const current = await request(fixture.baseUrl, `/api/tasks/${task.body.task.id}`);
    assert.equal(current.body.task.status, "todo");
    assert.equal(current.body.task.threadId, null);
    const threads = await request(fixture.baseUrl, "/api/local/ai/threads");
    assert.equal(threads.body.threads.length, 0);
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("thread creation failure releases the claimed task back to ready", async () => {
  const fixture = await createFixture({ failSkillDiscovery: true });
  try {
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: { id: "auto-cut-copy-a", name: "Auto-cut-copyA", workspacePath: fixture.workspace },
    });
    assert.equal(project.response.status, 201);
    const task = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "auto-cut-copy-a",
        title: "Catalog failure demo",
        description: feishuDescription(),
        status: "todo",
        priority: "high",
        labels: ["feishu"],
      },
    });

    const started = await request(
      fixture.baseUrl,
      `/api/tasks/${task.body.task.id}/start-ai`,
      { method: "POST", body: {} },
    );
    assert.equal(started.response.status, 500);

    const current = await request(fixture.baseUrl, `/api/tasks/${task.body.task.id}`);
    assert.equal(current.body.task.status, "todo");
    assert.equal(current.body.task.threadId, null);
    const threads = await request(fixture.baseUrl, "/api/local/ai/threads");
    assert.equal(threads.body.threads.length, 0);
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("concurrent task edits during startup release the claim without losing the edit", async () => {
  const fixture = await createFixture();
  try {
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: { id: "auto-cut-copy-a", name: "Auto-cut-copyA", workspacePath: fixture.workspace },
    });
    assert.equal(project.response.status, 201);
    const task = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "auto-cut-copy-a",
        title: "Concurrent edit demo",
        description: feishuDescription(),
        status: "todo",
        priority: "high",
        labels: ["feishu"],
      },
    });

    let enteredResolve;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    let continueResolve;
    const proceed = new Promise((resolve) => { continueResolve = resolve; });
    const originalCreateThread = fixture.app.aiChat.createThread.bind(fixture.app.aiChat);
    fixture.app.aiChat.createThread = async (...args) => {
      enteredResolve();
      await proceed;
      return originalCreateThread(...args);
    };

    const startPromise = request(fixture.baseUrl, `/api/tasks/${task.body.task.id}/start-ai`, {
      method: "POST",
      body: {},
    });
    await entered;
    const claimed = await request(fixture.baseUrl, `/api/tasks/${task.body.task.id}`);
    assert.equal(claimed.body.task.status, "in_progress");
    assert.equal(typeof claimed.body.task.threadId, "string");
    const edited = await request(fixture.baseUrl, `/api/tasks/${task.body.task.id}`, {
      method: "PATCH",
      body: {
        version: claimed.body.task.version,
        title: "Edited while starting",
        threadId: claimed.body.task.threadId,
      },
    });
    assert.equal(edited.response.status, 200);
    continueResolve();

    const started = await startPromise;
    assert.equal(started.response.status, 409);
    const current = await request(fixture.baseUrl, `/api/tasks/${task.body.task.id}`);
    assert.equal(current.body.task.status, "todo");
    assert.equal(current.body.task.title, "Edited while starting");
    assert.equal(current.body.task.threadId, null);
    const threads = await request(fixture.baseUrl, "/api/local/ai/threads");
    assert.equal(threads.body.threads.length, 0);
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("startup failure does not release a task that was rebound to another thread", async () => {
  const fixture = await createFixture();
  try {
    const actor = { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: { id: "auto-cut-copy-a", name: "Auto-cut-copyA", workspacePath: fixture.workspace },
    });
    assert.equal(project.response.status, 201);
    const task = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "auto-cut-copy-a",
        title: "Rebound startup demo",
        description: feishuDescription(),
        status: "todo",
        priority: "high",
        labels: ["feishu"],
      },
    });
    const competingThread = await fixture.app.aiChat.createThread({
      projectId: task.body.task.projectId,
      issueId: task.body.task.id,
      title: "Competing thread",
      sandbox: "workspace-write",
    });
    const originalCreateThread = fixture.app.aiChat.createThread.bind(fixture.app.aiChat);
    let failedThreadId;
    fixture.app.aiChat.createThread = async (...args) => {
      const failedThread = await originalCreateThread(...args);
      failedThreadId = failedThread.id;
      const claimed = fixture.app.database.getTask(task.body.task.id);
      fixture.app.database.updateTask(
        claimed.id,
        claimed.version,
        { title: "Rebound while starting" },
        competingThread.id,
        actor,
      );
      return failedThread;
    };

    const started = await request(fixture.baseUrl, `/api/tasks/${task.body.task.id}/start-ai`, {
      method: "POST",
      body: {},
    });
    assert.equal(started.response.status, 409);

    const current = fixture.app.database.getTask(task.body.task.id);
    assert.equal(current.status, "in_progress");
    assert.equal(current.threadId, competingThread.id);
    assert.equal(current.title, "Rebound while starting");
    assert.equal(fixture.app.database.getAiChatThread(failedThreadId), null);
    assert.equal(fixture.app.database.getAiChatThread(competingThread.id)?.id, competingThread.id);
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("restarting after an unbound AI start claim returns the task to ready", async () => {
  const fixture = await createFixture();
  try {
    const actor = { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };
    fixture.app.database.createProject({
      id: "auto-cut-copy-a",
      name: "Auto-cut-copyA",
      workspacePath: fixture.workspace,
    });
    const task = fixture.app.database.createTask({
      projectId: "auto-cut-copy-a",
      title: "Abandoned claim",
      description: feishuDescription(),
      status: "todo",
      priority: "high",
      labels: ["feishu"],
      feishuOrigin: feishuOrigin(),
      actor,
      assignee: actor,
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    fixture.app.database.claimTaskForAiStart(task.id, task.version, actor);

    await fixture.app.close();
    fixture.app = createTaskboardServer({
      dataDirectory: fixture.directory,
      codexExecutable: path.join(fixture.directory, "fake-codex.mjs"),
      codexStatePath: path.join(fixture.directory, "codex-state.json"),
      skillPath: path.join(fixture.directory, "AGENTS.md"),
      feishuPackagesPath: fixture.packagesPath,
    });

    const recovered = fixture.app.database.getTask(task.id);
    assert.equal(recovered.status, "todo");
    assert.equal(recovered.threadId, null);
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("an old AI start token cannot release a newer start claim", async () => {
  const fixture = await createFixture();
  try {
    const actor = { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };
    fixture.app.database.createProject({
      id: "auto-cut-copy-a",
      name: "Auto-cut-copyA",
      workspacePath: fixture.workspace,
    });
    const task = fixture.app.database.createTask({
      projectId: "auto-cut-copy-a",
      title: "Token ownership",
      description: feishuDescription(),
      status: "todo",
      priority: "high",
      labels: ["feishu"],
      feishuOrigin: feishuOrigin(),
      actor,
      assignee: actor,
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    const first = fixture.app.database.claimTaskForAiStart(task.id, task.version, actor);
    const ready = fixture.app.database.releaseTaskFromAiStart(task.id, first.claimToken, actor);
    const second = fixture.app.database.claimTaskForAiStart(task.id, ready.version, actor);

    assert.throws(
      () => fixture.app.database.releaseTaskFromAiStart(task.id, first.claimToken, actor),
      (error) => error?.code === "TASK_START_STATE_CHANGED",
    );
    const current = fixture.app.database.getTask(task.id);
    assert.equal(current.status, "in_progress");
    assert.equal(current.threadId, null);
    assert.equal(fixture.app.database.listTaskAiStarts()[0].claimToken, second.claimToken);
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("restarting after thread binding but before a run returns the task to ready", async () => {
  const fixture = await createFixture();
  try {
    const actor = { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };
    fixture.app.database.createProject({
      id: "auto-cut-copy-a",
      name: "Auto-cut-copyA",
      workspacePath: fixture.workspace,
    });
    const task = fixture.app.database.createTask({
      projectId: "auto-cut-copy-a",
      title: "Abandoned bound claim",
      description: feishuDescription(),
      status: "todo",
      priority: "high",
      labels: ["feishu"],
      feishuOrigin: feishuOrigin(),
      actor,
      assignee: actor,
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    const threadId = randomUUID();
    const claimed = fixture.app.database.claimTaskForAiStart(task.id, task.version, actor);
    fixture.app.database.bindTaskAiStart(
      task.id,
      claimed.claimToken,
      claimed.version,
      threadId,
      actor,
    );
    const thread = await fixture.app.aiChat.createThread({
      id: threadId,
      projectId: task.projectId,
      issueId: task.id,
      title: "Abandoned bound thread",
      sandbox: "workspace-write",
    });
    assert.equal(thread.id, threadId);

    await fixture.app.close();
    fixture.app = createTaskboardServer({
      dataDirectory: fixture.directory,
      codexExecutable: path.join(fixture.directory, "fake-codex.mjs"),
      codexStatePath: path.join(fixture.directory, "codex-state.json"),
      skillPath: path.join(fixture.directory, "AGENTS.md"),
      feishuPackagesPath: fixture.packagesPath,
    });

    const recovered = fixture.app.database.getTask(task.id);
    assert.equal(recovered.status, "todo");
    assert.equal(recovered.threadId, null);
    assert.equal(fixture.app.database.getAiChatThread(thread.id), null);
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

for (const edit of [
  { name: "Feishu label", changes: { labels: [] } },
  { name: "Feishu metadata", changes: { description: "metadata removed" } },
]) {
  test(`startup recovery releases a claimed task whose ${edit.name} was removed`, async () => {
    const fixture = await createFixture();
    try {
      const actor = { type: "user", id: "local-user", name: "鏈湴鐢ㄦ埛", avatarUrl: null };
      fixture.app.database.createProject({
        id: "auto-cut-copy-a",
        name: "Auto-cut-copyA",
        workspacePath: fixture.workspace,
      });
      const task = fixture.app.database.createTask({
        projectId: "auto-cut-copy-a",
        title: "Edited claim metadata",
        description: feishuDescription(),
        status: "todo",
        priority: "high",
        labels: ["feishu"],
        feishuOrigin: feishuOrigin(),
        actor,
        assignee: actor,
        workflowId: null,
        developmentContext: null,
        startDate: null,
        dueDate: null,
        recurrence: null,
      });
      const threadId = randomUUID();
      const claimed = fixture.app.database.claimTaskForAiStart(task.id, task.version, actor);
      const linked = fixture.app.database.bindTaskAiStart(
        task.id,
        claimed.claimToken,
        claimed.version,
        threadId,
        actor,
      );
      const thread = await fixture.app.aiChat.createThread({
        id: threadId,
        projectId: task.projectId,
        issueId: task.id,
        title: "Edited claim thread",
        sandbox: "workspace-write",
      });
      fixture.app.database.updateTask(linked.id, linked.version, edit.changes, thread.id, actor);

      await fixture.app.close();
      fixture.app = createTaskboardServer({
        dataDirectory: fixture.directory,
        codexExecutable: path.join(fixture.directory, "fake-codex.mjs"),
        codexStatePath: path.join(fixture.directory, "codex-state.json"),
        skillPath: path.join(fixture.directory, "AGENTS.md"),
        feishuPackagesPath: fixture.packagesPath,
      });

      const recovered = fixture.app.database.getTask(task.id);
      assert.equal(recovered.status, "todo");
      assert.equal(recovered.threadId, null);
      assert.deepEqual(fixture.app.database.listTaskAiStarts(), []);
      assert.notEqual(fixture.app.database.getAiChatThread(thread.id), null);
    } finally {
      await fixture.app.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
}

test("startup recovery releases a claim bound to a thread owned by another task", async () => {
  const fixture = await createFixture();
  try {
    const actor = { type: "user", id: "local-user", name: "鏈湴鐢ㄦ埛", avatarUrl: null };
    fixture.app.database.createProject({
      id: "auto-cut-copy-a",
      name: "Auto-cut-copyA",
      workspacePath: fixture.workspace,
    });
    const createTask = (title) => fixture.app.database.createTask({
      projectId: "auto-cut-copy-a",
      title,
      description: feishuDescription(),
      status: "todo",
      priority: "high",
      labels: ["feishu"],
      feishuOrigin: feishuOrigin(),
      actor,
      assignee: actor,
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    const claimedTask = createTask("Claimed task");
    const otherTask = createTask("Other task");
    const thread = await fixture.app.aiChat.createThread({
      projectId: claimedTask.projectId,
      issueId: otherTask.id,
      title: "Other task thread",
      sandbox: "workspace-write",
    });
    const claimed = fixture.app.database.claimTaskForAiStart(
      claimedTask.id,
      claimedTask.version,
      actor,
    );
    fixture.app.database.bindTaskAiStart(
      claimed.id,
      claimed.claimToken,
      claimed.version,
      thread.id,
      actor,
    );

    await fixture.app.close();
    fixture.app = createTaskboardServer({
      dataDirectory: fixture.directory,
      codexExecutable: path.join(fixture.directory, "fake-codex.mjs"),
      codexStatePath: path.join(fixture.directory, "codex-state.json"),
      skillPath: path.join(fixture.directory, "AGENTS.md"),
      feishuPackagesPath: fixture.packagesPath,
    });

    const recovered = fixture.app.database.getTask(claimedTask.id);
    assert.equal(recovered.status, "todo");
    assert.equal(recovered.threadId, null);
    assert.deepEqual(fixture.app.database.listTaskAiStarts(), []);
    assert.notEqual(fixture.app.database.getAiChatThread(thread.id), null);
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("startup recovery ignores runs that started before the current claim", async () => {
  const fixture = await createFixture();
  try {
    const actor = { type: "user", id: "local-user", name: "鏈湴鐢ㄦ埛", avatarUrl: null };
    fixture.app.database.createProject({
      id: "auto-cut-copy-a",
      name: "Auto-cut-copyA",
      workspacePath: fixture.workspace,
    });
    const task = fixture.app.database.createTask({
      projectId: "auto-cut-copy-a",
      title: "Historical run",
      description: feishuDescription(),
      status: "todo",
      priority: "high",
      labels: ["feishu"],
      feishuOrigin: feishuOrigin(),
      actor,
      assignee: actor,
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    const thread = await fixture.app.aiChat.createThread({
      projectId: task.projectId,
      issueId: task.id,
      title: "Historical run thread",
      sandbox: "workspace-write",
    });
    fixture.app.database.createAiChatRun({
      id: "historical-run",
      threadId: thread.id,
      status: "completed",
      exitCode: 0,
      startedAt: "2000-01-01T00:00:00.000Z",
      finishedAt: "2000-01-01T00:00:01.000Z",
    });
    const claimed = fixture.app.database.claimTaskForAiStart(task.id, task.version, actor);
    fixture.app.database.bindTaskAiStart(
      claimed.id,
      claimed.claimToken,
      claimed.version,
      thread.id,
      actor,
    );

    await fixture.app.close();
    fixture.app = createTaskboardServer({
      dataDirectory: fixture.directory,
      codexExecutable: path.join(fixture.directory, "fake-codex.mjs"),
      codexStatePath: path.join(fixture.directory, "codex-state.json"),
      skillPath: path.join(fixture.directory, "AGENTS.md"),
      feishuPackagesPath: fixture.packagesPath,
    });

    const recovered = fixture.app.database.getTask(task.id);
    assert.equal(recovered.status, "todo");
    assert.equal(recovered.threadId, null);
    assert.deepEqual(fixture.app.database.listTaskAiStarts(), []);
    assert.notEqual(fixture.app.database.getAiChatThread(thread.id), null);
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("startup does not infer ownership for an unclaimed terminal Feishu run", async () => {
  const fixture = await createFixture();
  try {
    const actor = { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };
    fixture.app.database.createProject({
      id: "auto-cut-copy-a",
      name: "Auto-cut-copyA",
      workspacePath: fixture.workspace,
    });
    const task = fixture.app.database.createTask({
      projectId: "auto-cut-copy-a",
      title: "Unclaimed terminal run",
      description: feishuDescription(),
      status: "in_progress",
      priority: "high",
      labels: ["feishu"],
      feishuOrigin: feishuOrigin(),
      actor,
      assignee: actor,
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    const thread = await fixture.app.aiChat.createThread({
      projectId: task.projectId,
      issueId: task.id,
      title: "Unclaimed terminal thread",
      sandbox: "workspace-write",
    });
    const linked = fixture.app.database.updateTask(
      task.id,
      task.version,
      {},
      thread.id,
      actor,
    );
    fixture.app.database.createAiChatRun({
      id: "unclaimed-terminal-run",
      threadId: thread.id,
      status: "completed",
      exitCode: 0,
      startedAt: "2099-01-01T00:00:00.000Z",
      finishedAt: "2099-01-01T00:00:01.000Z",
    });

    await fixture.app.close();
    fixture.app = createTaskboardServer({
      dataDirectory: fixture.directory,
      codexExecutable: path.join(fixture.directory, "fake-codex.mjs"),
      codexStatePath: path.join(fixture.directory, "codex-state.json"),
      skillPath: path.join(fixture.directory, "AGENTS.md"),
      feishuPackagesPath: fixture.packagesPath,
    });

    const recovered = fixture.app.database.getTask(task.id);
    assert.equal(recovered.status, linked.status);
    assert.equal(recovered.threadId, thread.id);
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a terminal run does not update the task after its AI start claim is removed", async () => {
  const fixture = await createFixture({ turnDelayMs: 400 });
  try {
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: { id: "auto-cut-copy-a", name: "Auto-cut-copyA", workspacePath: fixture.workspace },
    });
    assert.equal(project.response.status, 201);
    const task = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "auto-cut-copy-a",
        title: "Removed claim",
        description: feishuDescription(),
        status: "todo",
        priority: "high",
        labels: ["feishu"],
      },
    });
    const started = await request(fixture.baseUrl, `/api/tasks/${task.body.task.id}/start-ai`, {
      method: "POST",
      body: {},
    });
    assert.equal(started.response.status, 202);
    const [claim] = fixture.app.database.listTaskAiStarts();
    fixture.app.database.deleteTaskAiStartClaim(claim.taskId, claim.claimToken);

    const run = await waitForRun(
      fixture.baseUrl,
      started.body.thread.id,
      (current) => current.status === "completed",
    );
    assert.equal(run.status, "completed");
    assert.equal(fixture.app.database.getTask(task.body.task.id).status, "in_progress");
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("same-timestamp manual status changes win over terminal recovery", async () => {
  const fixture = await createFixture();
  try {
    const actor = { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };
    fixture.app.database.createProject({
      id: "auto-cut-copy-a",
      name: "Auto-cut-copyA",
      workspacePath: fixture.workspace,
    });
    const task = fixture.app.database.createTask({
      projectId: "auto-cut-copy-a",
      title: "Same timestamp status",
      description: feishuDescription(),
      status: "todo",
      priority: "high",
      labels: ["feishu"],
      feishuOrigin: feishuOrigin(),
      actor,
      assignee: actor,
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    const thread = await fixture.app.aiChat.createThread({
      projectId: task.projectId,
      issueId: task.id,
      title: "Same timestamp thread",
      sandbox: "workspace-write",
    });
    const claimed = fixture.app.database.claimTaskForAiStart(task.id, task.version, actor);
    const linked = fixture.app.database.bindTaskAiStart(
      claimed.id,
      claimed.claimToken,
      claimed.version,
      thread.id,
      actor,
    );
    const timestamp = "2099-01-01T00:00:00.000Z";
    const run = fixture.app.database.createAiChatRun({
      id: "same-timestamp-run",
      threadId: thread.id,
      status: "completed",
      exitCode: 0,
      startedAt: timestamp,
      finishedAt: timestamp,
    });
    fixture.app.database.bindTaskAiStartRun(task.id, claimed.claimToken, thread.id, run.id);
    fixture.app.database.updateTask(linked.id, linked.version, { status: "blocked" }, thread.id, actor);
    fixture.app.database.updateTask(linked.id, linked.version + 1, { status: "in_progress" }, thread.id, actor);
    const [claim] = fixture.app.database.listTaskAiStarts();
    fixture.app.database.database.prepare(`
      UPDATE task_activities SET created_at = ?
      WHERE task_id = ? AND rowid > ?
    `).run(timestamp, task.id, claim.claimedActivityRowid);

    await fixture.app.close();
    fixture.app = createTaskboardServer({
      dataDirectory: fixture.directory,
      codexExecutable: path.join(fixture.directory, "fake-codex.mjs"),
      codexStatePath: path.join(fixture.directory, "codex-state.json"),
      skillPath: path.join(fixture.directory, "AGENTS.md"),
      feishuPackagesPath: fixture.packagesPath,
    });

    assert.equal(fixture.app.database.getTask(task.id).status, "in_progress");
    assert.deepEqual(fixture.app.database.listTaskAiStarts(), []);
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("restarting Taskboard blocks a Feishu task whose Codex run was interrupted", async () => {
  const fixture = await createFixture();
  try {
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: { id: "auto-cut-copy-a", name: "Auto-cut-copyA", workspacePath: fixture.workspace },
    });
    assert.equal(project.response.status, 201);
    const task = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "auto-cut-copy-a",
        title: "Restart recovery demo",
        description: feishuDescription(),
        status: "todo",
        priority: "high",
        labels: ["feishu"],
      },
    });
    const thread = await fixture.app.aiChat.createThread({
      projectId: FEISHU_PROJECT_ID,
      issueId: task.body.task.id,
      title: "Recovery thread",
      sandbox: "workspace-write",
    });
    const claimed = fixture.app.database.claimTaskForAiStart(
      task.body.task.id,
      task.body.task.version,
      { type: "user", id: "local-user", name: "本地用户", avatarUrl: null },
    );
    fixture.app.database.bindTaskAiStart(
      claimed.id,
      claimed.claimToken,
      claimed.version,
      thread.id,
      { type: "user", id: "local-user", name: "本地用户", avatarUrl: null },
    );
    const run = fixture.app.database.createAiChatRun({
      id: "restart-run",
      threadId: thread.id,
      status: "running",
    });
    fixture.app.database.bindTaskAiStartRun(task.body.task.id, claimed.claimToken, thread.id, run.id);

    // Simulate a process crash: close the HTTP/database resources without
    // letting AiChatService convert the still-running run to `interrupted`.
    fixture.app.aiChat.close = async () => {};
    await fixture.app.close();
    // The old database connection is closed by the simulated crash; reopen it
    // through the next server instance below.  The persisted run must still
    // be non-terminal at this boundary.
    fixture.app = createTaskboardServer({
      dataDirectory: fixture.directory,
      codexExecutable: path.join(fixture.directory, "fake-codex.mjs"),
      codexStatePath: path.join(fixture.directory, "codex-state.json"),
      skillPath: path.join(fixture.directory, "AGENTS.md"),
      feishuPackagesPath: fixture.packagesPath,
    });
    const restartedTask = fixture.app.database.getTask(task.body.task.id);
    assert.equal(restartedTask.status, "blocked");
    assert.equal(restartedTask.threadId, thread.id);
    assert.match(
      fixture.app.database.listTaskActivities(task.body.task.id).at(-1).changes[0].after,
      /blocked/,
    );
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("restarting Taskboard keeps a completed Feishu run processing until its ZIP is verified", async () => {
  const fixture = await createFixture();
  try {
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: { id: "auto-cut-copy-a", name: "Auto-cut-copyA", workspacePath: fixture.workspace },
    });
    const task = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "auto-cut-copy-a",
        title: "Completed recovery demo",
        description: feishuDescription(),
        status: "todo",
        priority: "high",
        labels: ["feishu"],
      },
    });
    const thread = await fixture.app.aiChat.createThread({
      projectId: FEISHU_PROJECT_ID,
      issueId: task.body.task.id,
      title: "Completed recovery thread",
      sandbox: "workspace-write",
    });
    const actor = { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };
    const claimed = fixture.app.database.claimTaskForAiStart(task.body.task.id, task.body.task.version, actor);
    fixture.app.database.bindTaskAiStart(claimed.id, claimed.claimToken, claimed.version, thread.id, actor);
    const run = fixture.app.database.createAiChatRun({
      id: "completed-restart-run",
      threadId: thread.id,
      status: "completed",
      exitCode: 0,
      finishedAt: new Date().toISOString(),
    });
    fixture.app.database.bindTaskAiStartRun(
      task.body.task.id,
      claimed.claimToken,
      thread.id,
      run.id,
    );

    await fixture.app.close();
    fixture.app = createTaskboardServer({
      dataDirectory: fixture.directory,
      codexExecutable: path.join(fixture.directory, "fake-codex.mjs"),
      codexStatePath: path.join(fixture.directory, "codex-state.json"),
      skillPath: path.join(fixture.directory, "AGENTS.md"),
      feishuPackagesPath: fixture.packagesPath,
    });
    const recovered = fixture.app.database.getTask(task.body.task.id);
    assert.equal(recovered.status, "in_progress");
    assert.equal(recovered.threadId, thread.id);
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("upgrading a legacy AI start claim preserves its completed run for recovery", async () => {
  const fixture = await createFixture();
  try {
    const actor = { type: "user", id: "local-user", name: "Local user", avatarUrl: null };
    fixture.app.database.createProject({
      id: "auto-cut-copy-a",
      name: "Auto-cut-copyA",
      workspacePath: fixture.workspace,
    });
    const task = fixture.app.database.createTask({
      projectId: "auto-cut-copy-a",
      title: "Legacy completed recovery",
      description: feishuDescription(),
      status: "todo",
      priority: "high",
      labels: ["feishu"],
      feishuOrigin: feishuOrigin(),
      actor,
      assignee: actor,
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    const thread = await fixture.app.aiChat.createThread({
      projectId: task.projectId,
      issueId: task.id,
      title: "Legacy completed thread",
      sandbox: "workspace-write",
    });
    const claimed = fixture.app.database.claimTaskForAiStart(task.id, task.version, actor);
    fixture.app.database.bindTaskAiStart(
      claimed.id,
      claimed.claimToken,
      claimed.version,
      thread.id,
      actor,
    );
    fixture.app.database.createAiChatRun({
      id: "legacy-completed-run",
      threadId: thread.id,
      status: "completed",
      exitCode: 0,
      finishedAt: new Date().toISOString(),
    });
    fixture.app.database.database.exec(`
      DROP INDEX task_ai_starts_run;
      CREATE TABLE task_ai_starts_legacy (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        claim_token TEXT NOT NULL UNIQUE,
        thread_id TEXT UNIQUE,
        claimed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO task_ai_starts_legacy (task_id, claim_token, thread_id, claimed_at, updated_at)
      SELECT task_id, claim_token, thread_id, claimed_at, updated_at FROM task_ai_starts;
      DROP TABLE task_ai_starts;
      ALTER TABLE task_ai_starts_legacy RENAME TO task_ai_starts;
    `);

    await fixture.app.close();
    fixture.app = createTaskboardServer({
      dataDirectory: fixture.directory,
      codexExecutable: path.join(fixture.directory, "fake-codex.mjs"),
      codexStatePath: path.join(fixture.directory, "codex-state.json"),
      skillPath: path.join(fixture.directory, "AGENTS.md"),
      feishuPackagesPath: fixture.packagesPath,
    });

    const recovered = fixture.app.database.getTask(task.id);
    assert.equal(recovered.status, "in_progress");
    assert.equal(recovered.threadId, thread.id);
    assert.deepEqual(fixture.app.database.listTaskAiStarts(), []);
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("upgrading a legacy AI start claim preserves a newer manual status change", async () => {
  const fixture = await createFixture();
  try {
    const actor = { type: "user", id: "local-user", name: "Local user", avatarUrl: null };
    fixture.app.database.createProject({
      id: "auto-cut-copy-a",
      name: "Auto-cut-copyA",
      workspacePath: fixture.workspace,
    });
    const task = fixture.app.database.createTask({
      projectId: "auto-cut-copy-a",
      title: "Legacy manual status wins",
      description: feishuDescription(),
      status: "todo",
      priority: "high",
      labels: ["feishu"],
      feishuOrigin: feishuOrigin(),
      actor,
      assignee: actor,
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    const thread = await fixture.app.aiChat.createThread({
      projectId: task.projectId,
      issueId: task.id,
      title: "Legacy manual status thread",
      sandbox: "workspace-write",
    });
    const claimed = fixture.app.database.claimTaskForAiStart(task.id, task.version, actor);
    const linked = fixture.app.database.bindTaskAiStart(
      claimed.id,
      claimed.claimToken,
      claimed.version,
      thread.id,
      actor,
    );
    fixture.app.database.createAiChatRun({
      id: "legacy-manual-status-run",
      threadId: thread.id,
      status: "completed",
      exitCode: 0,
      finishedAt: new Date().toISOString(),
    });
    fixture.app.database.updateTask(
      linked.id,
      linked.version,
      { status: "blocked" },
      thread.id,
      actor,
    );
    fixture.app.database.database.exec(`
      DROP INDEX task_ai_starts_run;
      CREATE TABLE task_ai_starts_legacy (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        claim_token TEXT NOT NULL UNIQUE,
        thread_id TEXT UNIQUE,
        claimed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO task_ai_starts_legacy (task_id, claim_token, thread_id, claimed_at, updated_at)
      SELECT task_id, claim_token, thread_id, claimed_at, updated_at FROM task_ai_starts;
      DROP TABLE task_ai_starts;
      ALTER TABLE task_ai_starts_legacy RENAME TO task_ai_starts;
    `);

    await fixture.app.close();
    fixture.app = createTaskboardServer({
      dataDirectory: fixture.directory,
      codexExecutable: path.join(fixture.directory, "fake-codex.mjs"),
      codexStatePath: path.join(fixture.directory, "codex-state.json"),
      skillPath: path.join(fixture.directory, "AGENTS.md"),
      feishuPackagesPath: fixture.packagesPath,
    });

    const recovered = fixture.app.database.getTask(task.id);
    assert.equal(recovered.status, "blocked");
    assert.equal(recovered.threadId, thread.id);
    assert.deepEqual(fixture.app.database.listTaskAiStarts(), []);
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("startup recovery does not overwrite a newer manual task status change", async () => {
  const fixture = await createFixture();
  try {
    const actor = { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };
    fixture.app.database.createProject({
      id: "auto-cut-copy-a",
      name: "Auto-cut-copyA",
      workspacePath: fixture.workspace,
    });
    const task = fixture.app.database.createTask({
      projectId: "auto-cut-copy-a",
      title: "Manual status wins",
      description: feishuDescription(),
      status: "todo",
      priority: "high",
      labels: ["feishu"],
      feishuOrigin: feishuOrigin(),
      actor,
      assignee: actor,
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    const thread = await fixture.app.aiChat.createThread({
      projectId: task.projectId,
      issueId: task.id,
      title: "Manual status thread",
      sandbox: "workspace-write",
    });
    const claimed = fixture.app.database.claimTaskForAiStart(task.id, task.version, actor);
    const linked = fixture.app.database.bindTaskAiStart(
      claimed.id,
      claimed.claimToken,
      claimed.version,
      thread.id,
      actor,
    );
    const run = fixture.app.database.createAiChatRun({
      id: "manual-status-run",
      threadId: thread.id,
      status: "completed",
      exitCode: 0,
      finishedAt: "2000-01-01T00:00:00.000Z",
    });
    fixture.app.database.bindTaskAiStartRun(task.id, claimed.claimToken, thread.id, run.id);
    fixture.app.database.updateTask(linked.id, linked.version, { status: "in_review" }, thread.id, actor);
    const manuallyMoved = fixture.app.database.updateTask(
      linked.id,
      linked.version + 1,
      { status: "in_progress" },
      thread.id,
      actor,
    );

    await fixture.app.close();
    fixture.app = createTaskboardServer({
      dataDirectory: fixture.directory,
      codexExecutable: path.join(fixture.directory, "fake-codex.mjs"),
      codexStatePath: path.join(fixture.directory, "codex-state.json"),
      skillPath: path.join(fixture.directory, "AGENTS.md"),
      feishuPackagesPath: fixture.packagesPath,
    });
    assert.equal(fixture.app.database.getTask(task.id).status, manuallyMoved.status);
    assert.deepEqual(fixture.app.database.listTaskAiStarts(), []);
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("startup recovery still reconciles after a newer title-only edit", async () => {
  const fixture = await createFixture();
  try {
    const actor = { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };
    fixture.app.database.createProject({
      id: "auto-cut-copy-a",
      name: "Auto-cut-copyA",
      workspacePath: fixture.workspace,
    });
    const task = fixture.app.database.createTask({
      projectId: "auto-cut-copy-a",
      title: "Title edit recovery",
      description: feishuDescription(),
      status: "todo",
      priority: "high",
      labels: ["feishu"],
      feishuOrigin: feishuOrigin(),
      actor,
      assignee: actor,
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    const thread = await fixture.app.aiChat.createThread({
      projectId: task.projectId,
      issueId: task.id,
      title: "Title edit thread",
      sandbox: "workspace-write",
    });
    const claimed = fixture.app.database.claimTaskForAiStart(task.id, task.version, actor);
    const linked = fixture.app.database.bindTaskAiStart(
      claimed.id,
      claimed.claimToken,
      claimed.version,
      thread.id,
      actor,
    );
    const run = fixture.app.database.createAiChatRun({
      id: "title-edit-run",
      threadId: thread.id,
      status: "completed",
      exitCode: 0,
      finishedAt: "2000-01-01T00:00:00.000Z",
    });
    fixture.app.database.bindTaskAiStartRun(task.id, claimed.claimToken, thread.id, run.id);
    fixture.app.database.updateTask(
      linked.id,
      linked.version,
      { title: "Edited after completion" },
      thread.id,
      actor,
    );

    await fixture.app.close();
    fixture.app = createTaskboardServer({
      dataDirectory: fixture.directory,
      codexExecutable: path.join(fixture.directory, "fake-codex.mjs"),
      codexStatePath: path.join(fixture.directory, "codex-state.json"),
      skillPath: path.join(fixture.directory, "AGENTS.md"),
      feishuPackagesPath: fixture.packagesPath,
    });
    const recovered = fixture.app.database.getTask(task.id);
    assert.equal(recovered.status, "in_progress");
    assert.equal(recovered.title, "Edited after completion");
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("start route rejects unknown execution fields before task metadata checks", async () => {
  const fixture = await createFixture();
  try {
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: { id: "auto-cut-copy-a", name: "Auto-cut-copyA", workspacePath: fixture.workspace },
    });
    assert.equal(project.response.status, 201);
    const task = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "auto-cut-copy-a",
        title: "Demo",
        description: "fixture",
        status: "todo",
        priority: "high",
        labels: ["feishu"],
      },
    });
    const result = await request(fixture.baseUrl, `/api/tasks/${task.body.task.id}/start-ai`, {
      method: "POST",
      body: { workspacePath: "C:\\evil", command: "rm -rf" },
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.error.code, "UNKNOWN_FIELD");
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("ordinary tasks cannot gain Feishu execution by copying the marker", async () => {
  const fixture = await createFixture();
  try {
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: { id: "auto-cut-copy-a", name: "Auto-cut-copyA", workspacePath: fixture.workspace },
    });
    assert.equal(project.response.status, 201);
    const forged = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "auto-cut-copy-a",
        title: "Forged marker",
        description: feishuDescription(),
        status: "todo",
        priority: "high",
        labels: ["feishu"],
      },
      ordinary: true,
    });
    assert.equal(forged.response.status, 201);

    const start = await request(
      fixture.baseUrl,
      `/api/tasks/${forged.body.task.id}/start-ai`,
      { method: "POST", body: {} },
    );
    assert.equal(start.response.status, 409);
    assert.equal(start.body.error.code, "TASK_NOT_STARTABLE");

    const execute = await request(
      fixture.baseUrl,
      `/api/local/tasks/${forged.body.task.id}/execute`,
      { method: "POST", body: { trigger: "manual" } },
    );
    assert.equal(execute.response.status, 409);
    assert.equal(execute.body.error.code, "TASK_NOT_STARTABLE");

    const move = await request(
      fixture.baseUrl,
      `/api/tasks/${forged.body.task.id}/move`,
      {
        method: "POST",
        body: { version: forged.body.task.version, status: "in_progress", sortOrder: 0 },
      },
    );
    assert.equal(move.response.status, 409);
    assert.equal(move.body.error.code, "TASK_NOT_STARTABLE");
    assert.equal(fixture.app.database.getTask(forged.body.task.id).status, "todo");
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("the unified execution endpoint starts a Feishu task and drag-to-processing uses the same path", async () => {
  const fixture = await createFixture({ turnDelayMs: 120 });
  try {
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: { id: "auto-cut-copy-a", name: "Auto-cut-copyA", workspacePath: fixture.workspace },
    });
    assert.equal(project.response.status, 201);
    const task = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "auto-cut-copy-a",
        title: "Unified execution",
        description: feishuDescription(),
        status: "todo",
        priority: "high",
        labels: ["feishu"],
      },
    });
    const started = await request(fixture.baseUrl, `/api/local/tasks/${task.body.task.id}/execute`, {
      method: "POST",
      body: { trigger: "manual" },
    });
    assert.equal(started.response.status, 202);
    assert.equal(started.body.task.status, "in_progress");
    assert.equal(typeof started.body.thread.id, "string");

    const secondTask = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "auto-cut-copy-a",
        title: "Drag execution",
        description: feishuDescription(),
        status: "todo",
        priority: "high",
        labels: ["feishu"],
      },
    });
    const moved = await request(fixture.baseUrl, `/api/tasks/${secondTask.body.task.id}/move`, {
      method: "POST",
      body: { version: secondTask.body.task.version, status: "in_progress", sortOrder: 0 },
    });
    assert.equal(moved.response.status, 202);
    assert.equal(moved.body.task.status, "queued");
    assert.equal(moved.body.execution.state, "queued");
    const invalidQueuedMove = await request(fixture.baseUrl, `/api/tasks/${secondTask.body.task.id}/move`, {
      method: "POST",
      body: { version: moved.body.task.version, status: "in_progress" },
    });
    assert.equal(invalidQueuedMove.response.status, 409);
    assert.equal(invalidQueuedMove.body.error.code, "TASK_EXECUTION_PENDING");
    await waitForTask(fixture.baseUrl, secondTask.body.task.id, (current) => current.status === "in_progress");
    await waitForTaskAiStartSettled(fixture.app, secondTask.body.task.id);
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("automatic execution requests remain explicitly disabled until the policy is enabled", async () => {
  const fixture = await createFixture();
  try {
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: { id: "auto-cut-copy-a", name: "Auto-cut-copyA", workspacePath: fixture.workspace },
    });
    assert.equal(project.response.status, 201);
    const task = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "auto-cut-copy-a",
        title: "Automatic execution",
        description: feishuDescription(),
        status: "todo",
        priority: "high",
        labels: ["feishu"],
      },
    });
    const result = await request(fixture.baseUrl, `/api/local/tasks/${task.body.task.id}/execute`, {
      method: "POST",
      body: { trigger: "automatic" },
    });
    assert.equal(result.response.status, 409);
    assert.equal(result.body.error.code, "AUTOMATIC_EXECUTION_DISABLED");
    assert.equal(fixture.app.database.getTask(task.body.task.id).status, "todo");
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("enabled automatic policy keeps a successful task processing until its ZIP is verified", async () => {
  const fixture = await createFixture({ allowAutomaticExecution: true });
  try {
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: { id: "auto-cut-copy-a", name: "Auto-cut-copyA", workspacePath: fixture.workspace },
    });
    assert.equal(project.response.status, 201);
    const created = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "auto-cut-copy-a",
        title: "Automatic task",
        description: automaticFeishuDescription(),
        status: "todo",
        priority: "high",
        labels: ["feishu", "automatic"],
      },
    });
    await waitForTask(
      fixture.baseUrl,
      created.body.task.id,
      (current) => current.status === "in_progress",
      8_000,
    );
    await waitForTaskAiStartSettled(fixture.app, created.body.task.id);
    assert.equal(fixture.app.database.getTask(created.body.task.id).status, "in_progress");
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("task execution uses the live package concurrency limit after a snapshot is captured", async () => {
  const packageRecord = {
    alias: "Auto-cut-copyA",
    name: "Auto-cut-copyA",
    projectId: "auto-cut-copy-a",
    workspacePath: null,
    model: null,
    reasoningEffort: null,
    prompt: "trusted fixture prompt",
    zipSourceDirectory: null,
    maxConcurrent: 1,
    state: "enabled",
    revision: 1,
  };
  const packageStore = {
    async get() { return { ...packageRecord }; },
    async read() { return { [packageRecord.alias]: { ...packageRecord } }; },
    async list() { return [{ ...packageRecord }]; },
  };
  const scheduler = createResourceScheduler();
  const requests = [];
  const resourceScheduler = {
    request(input) { requests.push({ ...input }); return scheduler.request(input); },
    release(value) { return scheduler.release(value); },
    cancel(value) { return scheduler.cancel(value); },
    snapshot() { return scheduler.snapshot(); },
    setConcurrencyLimit(name, limit) { return scheduler.setConcurrencyLimit(name, limit); },
  };
  const fixture = await createFixture({ feishuPackageStore: packageStore, resourceScheduler });
  packageRecord.workspacePath = fixture.workspace;
  try {
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: { id: "auto-cut-copy-a", name: "Auto-cut-copyA", workspacePath: fixture.workspace },
    });
    assert.equal(project.response.status, 201);
    const created = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "auto-cut-copy-a",
        title: "Live concurrency limit",
        description: feishuDescription(),
        status: "todo",
        priority: "high",
        labels: ["feishu"],
      },
    });
    packageRecord.maxConcurrent = 2;
    const started = await request(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {
      method: "POST",
      body: {},
    });
    assert.equal(started.response.status, 202);
    assert.ok(requests.length > 0, JSON.stringify(started.body));
    assert.equal(requests.at(-1).maxConcurrent, 2);
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("task execution uses the captured package workspace and prompt after live edits", async () => {
  let currentPackage = {
    alias: "Auto-cut-copyA",
    name: "Auto-cut-copyA",
    projectId: "auto-cut-copy-a",
    workspacePath: null,
    model: "fixture",
    reasoningEffort: "low",
    prompt: "original package prompt",
    zipSourceDirectory: null,
    maxConcurrent: 1,
    state: "enabled",
    revision: 1,
  };
  const packageStore = {
    async get(alias) {
      return alias === currentPackage.alias ? { ...currentPackage } : null;
    },
    async read() {
      return { [currentPackage.alias]: { ...currentPackage } };
    },
    async list() {
      return [{ ...currentPackage }];
    },
  };
  const fixture = await createFixture({
    feishuPackageStore: packageStore,
    packagePrompt: currentPackage.prompt,
  });
  const editedWorkspace = await mkdtemp(path.join(fixture.directory, "edited-package-workspace-"));
  currentPackage.workspacePath = fixture.workspace;
  try {
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: { id: "auto-cut-copy-a", name: "Auto-cut-copyA", workspacePath: fixture.workspace },
    });
    assert.equal(project.response.status, 201);
    const created = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "auto-cut-copy-a",
        title: "Snapshot package settings",
        description: feishuDescription(),
        status: "todo",
        priority: "high",
        labels: ["feishu"],
      },
    });
    assert.equal(created.response.status, 201);
    assert.deepEqual(fixture.app.database.getFeishuTaskPackageSnapshot(created.body.task.id), {
      packageAlias: "Auto-cut-copyA",
      packageRevision: 1,
      name: "Auto-cut-copyA",
      projectId: "auto-cut-copy-a",
      workspacePath: fixture.workspace,
      model: "fixture",
      reasoningEffort: "low",
      prompt: "original package prompt",
      maxConcurrent: 1,
    });

    currentPackage = {
      ...currentPackage,
      workspacePath: editedWorkspace,
      model: "edited-model",
      reasoningEffort: "high",
      prompt: "edited package prompt",
      revision: 2,
    };
    const started = await request(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {
      method: "POST",
      body: {},
    });
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    assert.equal(started.body.thread.origin.workspacePath, fixture.workspace);
    assert.equal(started.body.thread.model, "fixture");
    assert.equal(started.body.thread.reasoningEffort, "low");
    const snapshot = await request(
      fixture.baseUrl,
      `/api/local/ai/threads/${encodeURIComponent(started.body.thread.id)}`,
    );
    assert.equal(snapshot.response.status, 200);
    assert.equal(snapshot.body.events[0].content, "original package prompt");
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("different Auto-Cut packages keep their own Codex settings", async () => {
  const packages = {
    "Auto-cut-A": {
      alias: "Auto-cut-A",
      name: "Auto-cut-A",
      projectId: "auto-cut-a",
      workspacePath: null,
      model: "fixture",
      reasoningEffort: "low",
      prompt: "package A prompt",
      maxConcurrent: 1,
      state: "enabled",
      revision: 1,
    },
    "Auto-cut-B": {
      alias: "Auto-cut-B",
      name: "Auto-cut-B",
      projectId: "auto-cut-b",
      workspacePath: null,
      model: "fixture-two",
      reasoningEffort: "high",
      prompt: "package B prompt",
      maxConcurrent: 1,
      state: "enabled",
      revision: 1,
    },
  };
  const packageStore = {
    async get(alias) { return packages[alias] ? { ...packages[alias] } : null; },
    async read() {
      return Object.fromEntries(Object.entries(packages).map(([alias, record]) => [alias, { ...record }]));
    },
    async list() { return Object.values(packages).map((record) => ({ ...record })); },
  };
  const fixture = await createFixture({
    feishuPackageStore: packageStore,
    catalogModels: [
      { slug: "fixture", default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }] },
      { slug: "fixture-two", default_reasoning_level: "high", supported_reasoning_levels: [{ effort: "high" }] },
    ],
  });
  const packageBWorkspace = await mkdtemp(path.join(fixture.directory, "package-b-workspace-"));
  packages["Auto-cut-A"].workspacePath = fixture.workspace;
  packages["Auto-cut-B"].workspacePath = packageBWorkspace;
  try {
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: { id: "auto-cut-copy-a", name: "Fixture subject", workspacePath: fixture.workspace },
    });
    assert.equal(project.response.status, 201);
    const first = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "auto-cut-copy-a",
        title: "Package A task",
        description: feishuDescriptionWith({ eventId: "fixture-package-a", packageAlias: "Auto-cut-A" }),
        status: "todo",
        priority: "high",
        labels: ["feishu"],
      },
    });
    const second = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "auto-cut-copy-a",
        title: "Package B task",
        description: feishuDescriptionWith({ eventId: "fixture-package-b", packageAlias: "Auto-cut-B" }),
        status: "todo",
        priority: "high",
        labels: ["feishu"],
      },
    });
    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 201);

    const startedA = await request(fixture.baseUrl, `/api/tasks/${first.body.task.id}/start-ai`, {
      method: "POST",
      body: {},
    });
    const startedB = await request(fixture.baseUrl, `/api/tasks/${second.body.task.id}/start-ai`, {
      method: "POST",
      body: {},
    });
    assert.equal(startedA.response.status, 202, JSON.stringify(startedA.body));
    assert.equal(startedB.response.status, 202, JSON.stringify(startedB.body));
    assert.equal(startedA.body.thread.origin.workspacePath, fixture.workspace);
    assert.equal(startedA.body.thread.model, "fixture");
    assert.equal(startedA.body.thread.reasoningEffort, "low");
    assert.equal(startedB.body.thread.origin.workspacePath, packageBWorkspace);
    assert.equal(startedB.body.thread.model, "fixture-two");
    assert.equal(startedB.body.thread.reasoningEffort, "high");

    const [snapshotA, snapshotB] = await Promise.all([
      request(fixture.baseUrl, `/api/local/ai/threads/${encodeURIComponent(startedA.body.thread.id)}`),
      request(fixture.baseUrl, `/api/local/ai/threads/${encodeURIComponent(startedB.body.thread.id)}`),
    ]);
    assert.equal(snapshotA.body.events[0].content, "package A prompt");
    assert.equal(snapshotB.body.events[0].content, "package B prompt");
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("an unavailable snapshotted model returns a safe package error", async () => {
  const packageRecord = {
    alias: "Auto-cut-retired",
    name: "Auto-cut-retired",
    projectId: "auto-cut-retired",
    workspacePath: null,
    model: "retired-model",
    reasoningEffort: "high",
    prompt: "retired package prompt",
    maxConcurrent: 1,
    state: "enabled",
    revision: 1,
  };
  const packageStore = {
    async get(alias) { return alias === packageRecord.alias ? { ...packageRecord } : null; },
    async read() { return { [packageRecord.alias]: { ...packageRecord } }; },
    async list() { return [{ ...packageRecord }]; },
  };
  const fixture = await createFixture({ feishuPackageStore: packageStore });
  packageRecord.workspacePath = fixture.workspace;
  try {
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: { id: "auto-cut-copy-a", name: "Fixture subject", workspacePath: fixture.workspace },
    });
    assert.equal(project.response.status, 201);
    const created = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "auto-cut-copy-a",
        title: "Retired model task",
        description: feishuDescriptionWith({ eventId: "fixture-retired-model", packageAlias: "Auto-cut-retired" }),
        status: "todo",
        priority: "high",
        labels: ["feishu"],
      },
    });
    const started = await request(fixture.baseUrl, `/api/tasks/${created.body.task.id}/start-ai`, {
      method: "POST",
      body: {},
    });
    assert.equal(started.response.status, 409);
    assert.equal(started.body.error.code, "PACKAGE_MODEL_UNAVAILABLE");
  } finally {
    await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("server shutdown cancels a pending automatic delay before closing its database", async () => {
  let releasePackageRead;
  let fixture;
  const packageReadGate = new Promise((resolve) => {
    releasePackageRead = resolve;
  });
  fixture = await createFixture({
    allowAutomaticExecution: true,
    feishuPackageStore: {
      async read() {
        await packageReadGate;
        return {
          "Auto-cut-copyA": {
            projectId: "auto-cut-copy-a",
            projectName: "Auto-cut-copyA",
            workspacePath: fixture.workspace,
            prompt: "trusted fixture prompt",
          },
        };
      },
    },
  });
  let closed = false;
  try {
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: { id: "auto-cut-copy-a", name: "Auto-cut-copyA", workspacePath: fixture.workspace },
    });
    assert.equal(project.response.status, 201);
    const created = await request(fixture.baseUrl, "/api/tasks", {
      method: "POST",
      body: {
        projectId: "auto-cut-copy-a",
        title: "Pending automatic task",
        description: automaticFeishuDescription(),
        status: "todo",
        priority: "high",
        labels: ["feishu", "automatic"],
      },
    });
    assert.equal(created.response.status, 201);

    const closePromise = fixture.app.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(closed, true);

    releasePackageRead();
    await closePromise;
  } finally {
    releasePackageRead();
    if (!closed) await fixture.app.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
