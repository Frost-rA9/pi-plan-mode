/**
 * pi-planbuild v4 · 运行时探针：折叠语义（fold 纯函数 + v3 blob 快照兼容）。
 * 运行：`npm run probe`。
 *
 * 说明：getBranch vs getEntries 的分支隔离（P1/P2）依赖真实 pi 会话，本探针聚焦
 * P3（fold 语义 + v2/v3 快照兼容）——两者均纯函数、可在本机断言。
 */
import assert from "node:assert/strict";
import { PB_ENTRY_TYPE, foldEvents, parsePbEvents, emptyState } from "../src/events.ts";

const tests: Array<[string, () => void]> = [];
function ok(name: string, fn: () => void): void {
  tests.push([name, fn]);
}

ok("fold 语义: whole-value last-wins（mode）+ grant 累积", () => {
  const s = foldEvents([
    { kind: "mode", value: "build" },
    { kind: "mode", value: "plan" },
    { kind: "grant", command: "npm test" },
  ]);
  assert.equal(s.mode, "plan");
  assert.equal(s.approveMemory.get("npm test"), true);
});

ok("空事件折叠 = emptyState", () => {
  assert.deepEqual(foldEvents([]), emptyState());
});

ok("v3 blob → snapshot 展开正确（mode/safety/planFile）", () => {
  const events = parsePbEvents([
    { type: "custom", customType: PB_ENTRY_TYPE, data: { mode: "plan", safetyMode: "verify", planFile: "/x.md" } },
  ]);
  assert.equal(events.length, 1);
  const s = foldEvents(events);
  assert.equal(s.mode, "plan");
  assert.equal(s.safetyMode, "verify");
  assert.equal(s.planFilePath, "/x.md");
});

ok("外来/未知条目静默忽略", () => {
  const events = parsePbEvents([
    { type: "custom", customType: "other", data: { kind: "mode", value: "plan" } },
    { type: "custom", customType: PB_ENTRY_TYPE, data: { kind: "unknown-kind" } },
  ] as never);
  assert.equal(events.length, 0);
});

let passed = 0;
for (const [name, fn] of tests) {
  fn();
  passed++;
  console.log(`  ✅ ${name}`);
}
console.log(`\n探针全部通过：${passed} 组。P1/P2（getBranch 分支隔离）需真实 pi 会话验证。`);
