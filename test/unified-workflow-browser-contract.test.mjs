import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("READMEs explain configurable subject workflow boards and protected history", async () => {
  const [zh, en] = await Promise.all([
    readFile(new URL("../README.zh-CN.md", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
  ]);

  assert.match(zh, /全部流程/);
  assert.match(zh, /新建视图/);
  assert.match(zh, /隐藏流程.*计数|计数.*隐藏流程/);
  assert.match(zh, /搜索范围.*全部流程|全部流程.*搜索范围/);
  assert.match(zh, /ZIP.*折叠/);
  assert.match(zh, /上传列.*只读|只读.*上传列/);
  assert.match(zh, /节点模式/);
  assert.match(zh, /已归档.*恢复|恢复.*已归档/);
  assert.match(zh, /空.*手动创建.*项目|手动创建.*项目.*为空/);
  assert.match(zh, /移除.*不.*删除.*远程/);

  assert.match(en, /All stages/);
  assert.match(en, /New view/);
  assert.match(en, /hidden stages.*counts|counts.*hidden stages/i);
  assert.match(en, /Search scope.*All stages|All stages.*Search scope/i);
  assert.match(en, /ZIP.*folded|folded.*ZIP/i);
  assert.match(en, /Upload columns are read-only|read-only upload columns/i);
  assert.match(en, /node mode/i);
  assert.match(en, /archived.*restore|restore.*archived/i);
  assert.match(en, /empty manually-created project/i);
  assert.match(en, /remov.*does not delete.*remote/i);
});
