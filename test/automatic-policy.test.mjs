import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveAutomaticExecution } from "../server/app.mjs";

test("automatic execution policy is opt-in and accepts explicit environment values", () => {
  assert.equal(resolveAutomaticExecution(undefined), false);
  assert.equal(resolveAutomaticExecution(""), false);
  assert.equal(resolveAutomaticExecution("0"), false);
  assert.equal(resolveAutomaticExecution("1"), true);
  assert.equal(resolveAutomaticExecution("true"), true);
  assert.equal(resolveAutomaticExecution("yes"), true);
  assert.equal(resolveAutomaticExecution("on"), true);
  assert.equal(resolveAutomaticExecution("unexpected"), false);
  assert.equal(resolveAutomaticExecution(true), true);
  assert.equal(resolveAutomaticExecution(false), false);
});
