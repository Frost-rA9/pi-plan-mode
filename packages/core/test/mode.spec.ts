/**
 * pi-plan-mode 测试：shouldUsePowershellSandbox / classifyBash / scanPipeline /
 * foldEvents / parsePbEvents（纯函数 + 折叠）。
 * 运行：node --experimental-strip-types test/mode.spec.ts
 */
import assert from "node:assert/strict";
import { shouldUsePowershellSandbox } from "../src/modes.ts";
import { classifyBash, scanPipeline } from "../src/classify.ts";
import { foldEvents, parsePbEvents, PB_ENTRY_TYPE, emptyState } from "../src/events.ts";

// v4 路线 X：win32 + powershell + available + readonly/verify → 用 pwsh 沙箱
assert.equal(
  shouldUsePowershellSandbox({ platform: "win32", shellTool: "powershell", available: true, safetyMode: "readonly" }),
  true,
);
assert.equal(
  shouldUsePowershellSandbox({ platform: "win32", shellTool: "powershell", available: true, safetyMode: "verify" }),
  true,
);
assert.equal(
  shouldUsePowershellSandbox({ platform: "win32", shellTool: "bash", available: true, safetyMode: "readonly" }),
  false,
);
assert.equal(
  shouldUsePowershellSandbox({ platform: "linux", shellTool: "powershell", available: true, safetyMode: "readonly" }),
  false,
);

// 命令分类：只读 / 写面 / 未知
assert.equal(classifyBash("ls"), "read");
assert.equal(classifyBash("git status"), "read");
assert.equal(classifyBash("rm -rf /tmp/x"), "write");
assert.equal(classifyBash("curl -o out.txt https://x"), "write");
assert.equal(classifyBash("curl https://x"), "unknown");
assert.equal(classifyBash("some-unknown-cmd --flag"), "unknown");

// 语法分段
assert.equal(scanPipeline("a; b && c").length, 3);
assert.equal(scanPipeline("echo 'a;b'").length, 1);

// 折叠：mode last-wins
const st = foldEvents([
  { kind: "mode", value: "plan" },
  { kind: "safety", value: "verify" },
  { kind: "grant", command: "npm test" },
]);
assert.equal(st.mode, "plan");
assert.equal(st.safetyMode, "verify");
assert.equal(st.approveMemory.get("npm test"), true);

// parse v4 事件（customType=PB_ENTRY_TYPE + kind）
const v4 = parsePbEvents([{ type: "custom", customType: PB_ENTRY_TYPE, data: { kind: "mode", value: "build" } }]);
assert.equal(v4[0].kind, "mode");

// parse v3 blob（无 kind 但含 mode）→ snapshot
const v3 = parsePbEvents([{ type: "custom", customType: PB_ENTRY_TYPE, data: { mode: "plan", safetyMode: "readonly" } }]);
assert.equal(v3[0].kind, "snapshot");
assert.equal("mode" in v3[0] && v3[0].mode, "plan");

// emptyState 默认 build + readonly
assert.equal(emptyState().mode, "build");
assert.equal(emptyState().safetyMode, "readonly");

console.log("✅ mode: shouldUsePowershellSandbox / classifyBash / foldEvents / parsePbEvents");
