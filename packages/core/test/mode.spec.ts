/**
 * pi-plan-mode 测试：shouldUsePowershellSandbox / classifyBash / scanPipeline /
 * foldEvents / parsePbEvents（纯函数 + 折叠）。
 * 运行：node --experimental-strip-types test/mode.spec.ts
 */
import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerModes, shouldUsePowershellSandbox, shouldInjectModeNotice, modeNoticeContent, primeNoticeBaseline } from "../src/modes.ts";
import { PlanbuildStore } from "../src/state.ts";
import { registerTools } from "../src/tools.ts";
import { buildPreviewMarkdown, PREVIEW_MAX_CHARS } from "../src/preview.ts";
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
assert.equal(emptyState().sandbox.podmanSocket, true);
// 旧键 dockerSocket（docker 时代）兼容映射为 podmanSocket。
assert.equal(
  foldEvents([{ kind: "sandbox", value: { mountHome: true, dockerSocket: false, extras: [] } as any }]).sandbox.podmanSocket,
  false,
);

/* -------------------- 模式切换 notice（修复：首回合前切换补基线） -------------------- */

// 判定：未建立基线（首回合）不注入；不同模式才注入；同模式防抖
assert.equal(shouldInjectModeNotice("plan", undefined), false);
assert.equal(shouldInjectModeNotice("build", "plan"), true);
assert.equal(shouldInjectModeNotice("plan", "plan"), false);
assert.equal(shouldInjectModeNotice("plan", "build"), true);

// 文案与 TUI 展示一致
assert.equal(modeNoticeContent("plan"), "用户已将模式切换到计划模式（只读规划）。");
assert.equal(modeNoticeContent("build"), "用户已将模式切换到构建模式（完整权限）。");

// 补基线：未对话切换 → 旧模式成为基线；已对话不覆盖
assert.equal(primeNoticeBaseline(undefined, "build"), "build"); // 场景 1：启动默认 build，未对话 /plan
assert.equal(primeNoticeBaseline(undefined, "plan"), "plan"); // 场景 2：恢复 plan，未对话 /build
assert.equal(primeNoticeBaseline("plan", "build"), "plan"); // 已对话后切换：基线不动

// —— 场景 1 全序列：启动默认 build → 未对话 /plan → 首回合注入 → 次回合防抖 ——
let n1: "plan" | "build" | undefined = undefined;
n1 = primeNoticeBaseline(n1, "build"); // /plan 切换时补基线
assert.equal(shouldInjectModeNotice("plan", n1), true); // 首回合注入 ✅（修复前为 false）
n1 = "plan"; // before_agent_start 写入
assert.equal(shouldInjectModeNotice("plan", n1), false); // 次回合防抖

// —— 场景 2 全序列：/resume 恢复 plan → 未对话 /build → 首回合注入 ——
let n2: "plan" | "build" | undefined = undefined;
n2 = primeNoticeBaseline(n2, "plan"); // /build 切换时补基线（oldMode=恢复的 plan）
assert.equal(shouldInjectModeNotice("build", n2), true); // 首回合注入 ✅

// —— 场景 3（T4）序列：启动默认 build → 未对话 /plan（基线=build）→ 首回合（plan）注入 →
//    回合中 plan_mode_complete 批准切 build → 当前回合即时 notice 并消费 → 后续 build 防抖 ——
let n3: "plan" | "build" | undefined = undefined;
n3 = primeNoticeBaseline(n3, "build"); // 启动默认 build，未对话 /plan
assert.equal(shouldInjectModeNotice("plan", n3), true); // 首回合（plan）注入：已切到 plan
n3 = "plan"; // before_agent_start 写入
n3 = primeNoticeBaseline(n3, "plan"); // 回合中批准 → enterBuildMode：基线不动
assert.equal(n3, "plan");
n3 = "build"; // 即时 mode-notice 已显示并消费
assert.equal(shouldInjectModeNotice("build", n3), false); // 后续 build 对话不重复

/* -------------------- 批准后的即时 notice（pi sendMessage seam） -------------------- */
{
  const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> | undefined }> = [];
  const persisted: Array<{ customType: string; data: Record<string, unknown> }> = [];
  const registeredTools = new Map<string, any>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  let activeTools = ["read", "bash", "edit", "write"];
  const fakePi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
    registerTool: (definition: { name: string }) => registeredTools.set(definition.name, definition),
    getActiveTools: () => activeTools,
    setActiveTools: (names: string[]) => {
      activeTools = names;
    },
    appendEntry: (customType: string, data: Record<string, unknown>) => persisted.push({ customType, data }),
    sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => sent.push({ message, options }),
  } as any;
  const store = PlanbuildStore.create(fakePi);
  store.state.mode = "plan";
  store.runtime.notifiedMode = "plan";
  const ctx = {
    cwd: process.cwd(),
    ui: { setStatus: () => undefined, select: async () => "批准并执行" },
  } as any;
  const modes = registerModes(fakePi, store);

  modes.enterBuildMode(ctx);
  modes.announceModeNotice();
  modes.announceModeNotice(); // 幂等：同一切换只发送一次

  assert.equal(store.state.mode, "build");
  assert.equal(store.runtime.notifiedMode, "build");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    message: {
      customType: `${PB_ENTRY_TYPE}:mode-notice`,
      content: modeNoticeContent("build"),
      display: true,
    },
    options: { deliverAs: "steer" },
  });
  assert.equal(
    persisted.filter((entry) => entry.customType === PB_ENTRY_TYPE && entry.data.kind === "mode").length,
    1,
  );

  const beforeAgentStart = handlers.get("before_agent_start");
  assert.ok(beforeAgentStart);
  const nextBuild = beforeAgentStart({ systemPrompt: "base" }, ctx) as { message?: unknown };
  assert.equal(nextBuild.message, undefined); // 即时 notice 已消费，下一次 build prompt 不重复
  assert.equal(sent.length, 1);

  /* 端到端覆盖批准分支：实际 tool execute 只追加一次 mode 事件并发送即时 notice。 */
  const planFile = join(tmpdir(), `pi-plan-mode-notice-${process.pid}.md`);
  store.state.mode = "plan";
  store.state.planFilePath = planFile;
  store.runtime.notifiedMode = "plan";
  store.runtime.toolsBeforePlanMode = ["read", "bash", "edit", "write"];
  sent.splice(0);
  persisted.splice(0);
  registeredTools.clear();
  registerTools(fakePi, store, modes);
  const completeTool = registeredTools.get("plan_mode_complete");
  assert.ok(completeTool);
  await completeTool.execute("call-1", { plan: "# Test plan\n\n1. Verify notice" }, undefined, undefined, ctx);
  assert.equal(store.state.mode, "build");
  assert.equal(sent.length, 1);
  assert.equal(
    persisted.filter((entry) => entry.customType === PB_ENTRY_TYPE && entry.data.kind === "mode").length,
    1,
  );
  await unlink(planFile).catch(() => undefined);
}

/* -------------------- 计划预览消息区条目（buildPreviewMarkdown 纯函数） -------------------- */

// 摘要优先
assert.equal(buildPreviewMarkdown("## 目标：计划", "原文..."), "## 目标：计划");
// 无预览能力 → 降级说明 + 原文（短文不截断）
assert.equal(buildPreviewMarkdown(undefined, "短计划"), "> 预览能力未启用，已截断原文（3 字符）。完整计划在工具结果/计划文件中。\n\n短计划");
// 无预览能力 + 超长 → 截断到 PREVIEW_MAX_CHARS + 省略号
{
  const long = "x".repeat(PREVIEW_MAX_CHARS + 100);
  const out = buildPreviewMarkdown(undefined, long);
  assert.ok(out.includes("…"));
  assert.ok(!out.includes("x".repeat(PREVIEW_MAX_CHARS + 1)));
  assert.ok(out.endsWith("…"));
}
assert.equal(modeNoticeContent("build"), "用户已将模式切换到构建模式（完整权限）。");

console.log("✅ mode: shouldUsePowershellSandbox / classifyBash / foldEvents / parsePbEvents / notice");
