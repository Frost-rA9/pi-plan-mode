/**
 * pi-plan-preview 测试：summarize / firstHeading（纯函数）。
 * 运行：node --experimental-strip-types test/preview.spec.ts
 */
import assert from "node:assert/strict";
import { summarize, firstHeading } from "../src/index.ts";

assert.equal(firstHeading("# 标题\n正文"), "标题");
assert.equal(firstHeading("## 子标题"), "子标题");
assert.equal(firstHeading("无标题正文"), undefined);

const s = summarize("## 计划\n- 步骤1\n- 步骤2\n- 步骤3\n正文说明");
assert.equal(s.title, "计划");
assert.deepEqual(s.bullets, ["步骤1", "步骤2", "步骤3"]);
assert.equal(s.steps, 3);
assert.equal(s.lines, 5);

// 空计划
assert.equal(summarize("").title, undefined);
assert.equal(summarize("").bullets.length, 0);

console.log("✅ preview: summarize / firstHeading");
