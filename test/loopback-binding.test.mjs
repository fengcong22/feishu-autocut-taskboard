import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  assertLoopbackListenAddress,
  createTaskboardServer,
  resolveHost,
} from "../server/index.mjs";

const fixtures = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    const { app, directory } = fixtures.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Taskboard defaults to the loopback bind address", () => {
  assert.equal(resolveHost(), "127.0.0.1");
  assert.equal(resolveHost("127.0.0.1"), "127.0.0.1");
});

test("Taskboard host resolution rejects wildcard and non-loopback addresses", () => {
  for (const value of ["0.0.0.0", "::", "::1", "localhost", "192.168.1.20"]) {
    assert.throws(
      () => resolveHost(value),
      /127\.0\.0\.1/,
      `expected ${value} to be rejected`,
    );
  }
});

test("Taskboard rejects an inherited listener whose bound address is not 127.0.0.1", () => {
  assert.throws(
    () => assertLoopbackListenAddress({ address: "0.0.0.0", family: "IPv4", port: 47823 }),
    /127\.0\.0\.1/,
  );
  assert.throws(
    () => assertLoopbackListenAddress({ address: "::1", family: "IPv6", port: 47823 }),
    /127\.0\.0\.1/,
  );
  assert.deepEqual(
    assertLoopbackListenAddress({ address: "127.0.0.1", family: "IPv4", port: 47823 }),
    { address: "127.0.0.1", family: "IPv4", port: 47823 },
  );
});

test("Taskboard listen rejects a non-loopback host before opening a socket", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-loopback-binding-"));
  const app = createTaskboardServer({ dataDirectory: directory });
  fixtures.push({ app, directory });

  await assert.rejects(
    app.listen({ host: "0.0.0.0", port: 0 }),
    /127\.0\.0\.1/,
  );
  assert.equal(app.server.listening, false);
});
