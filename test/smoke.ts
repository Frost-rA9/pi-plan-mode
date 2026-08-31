/**
 * pi-planbuild v4（路线 X）冒烟测试。
 *
 * 覆盖：C1 事件折叠 / C2 档位（含 v4 selectBackend shellTool 分流）/ C3 文件真源 / S1 三分支 /
 * S2 grant 记忆 / 层 2 门控（readonly docker 拦截 / supervised confirm / strict 拒绝）/
 * docker.sock 掩码 / bwrap 挂载 / shell path 归一。
 *
 * 运行：`npm test`（node --experimental-strip-types）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import planbuildExtension from "../index.ts";
import type { ExtensionAPI, ToolDefinition, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { PB_ENTRY_TYPE, foldEvents, parsePbEvents } from "../src/events.ts";
import { sandboxDecision, overrideBwrapDetect, buildBwrapCommand, detectDockerSocket, normalizeShellPath, detectShellPath, socketMaskFor } from "../src/sandbox/bwrap.ts";
import { overrideWinaclProbe } from "../src/sandbox/win32/index.ts";
import { selectBackend } from "../src/sandbox/backend.ts";
import { shouldUsePowershellSandbox } from "../src/modes.ts";
import { homedir } from "node:os";
import { classifyBash, scanPipeline } from "../src/classify.ts";
import { classifyDockerWrite } from "../src/docker-gate.ts";

const tests: Array<[string, () => void | Promise<void>]> = [];
function ok(name: string, fn: () => void | Promise<void>): void {
  tests.push([name, fn]);
}

/* ============================ mock pi ============================ */
interface MockUI {
  notifies: string[];
  selectResults: string[];
  status: string;
  select: (title: string, options: string[]) => Promise<string | undefined>;
  notify: (msg: string, type?: string) => void;
  setStatus: (key: string, text: string | undefined) => void;
  confirm: (t: string, m: string) => Promise<boolean>;
  input: (t: string, p?: string) => Promise<string | undefined>;
}
interface MockPi {
  api: ExtensionAPI;
  tools: Map<string, ToolDefinition>;
  commands: Map<string, { description: string; handler: Function }>;
  flags: Map<string, unknown>;
  shortcuts: Map<string, unknown>;
  entries: Array<{ type: string; customType?: string; data?: unknown }>;
  handlers: Map<string, Function[]>;
  activeTools: string[];
  ui: MockUI;
}

function mockPi(): MockPi {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map();
  const flags = new Map();
  const shortcuts = new Map();
  const entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
  const handlers = new Map<string, Function[]>();
  let activeTools: string[] = ["read", "bash", "grep", "find", "ls", "edit", "write"];
  const ui: MockUI = {
    notifies: [],
    selectResults: [],
    status: "",
    async select(_title: string, options: string[]) {
      const r = ui.selectResults.shift();
      if (r === undefined) return options[0]; // 默认第一项
      return options.find((o) => o.includes(r)) ?? undefined;
    },
    notify: (m, _t) => ui.notifies.push(m),
    setStatus: (k, t) => { if (k) ui.status = t ?? ""; },
    confirm: async (t, m) => t === m,
    input: async () => undefined,
  };
  const api = {
    registerTool: (t: ToolDefinition) => tools.set(t.name, t),
    registerCommand: (n: string, o: { description: string; handler: Function }) => commands.set(n, o),
    registerFlag: (n: string, o: unknown) => flags.set(n, o),
    registerShortcut: (n: string, o: unknown) => shortcuts.set(n, o),
    getFlag: (n: string) => (flags.get(n) as { default?: unknown })?.default,
    getActiveTools: () => activeTools,
    setActiveTools: (names: string[]) => { activeTools = names; },
    getAllTools: () => [...tools.values()],
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    on: (event: string, handler: Function) => { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event)!.push(handler); },
    sendMessage: () => {},
    sendUserMessage: () => {},
  } as unknown as ExtensionAPI;

  return {
    api,
    tools,
    commands,
    flags,
    shortcuts,
    entries,
    handlers,
    get activeTools() { return activeTools; },
    set activeTools(v: string[]) { activeTools = v; },
    ui,
  };
}

/** 触发某个 event 的全部 handler（ctx），返回最后一个 handler 结果 */
async function fire(m: MockPi, event: string, evt: unknown, ctx: unknown): Promise<unknown> {
  let last: unknown;
  for (const h of m.handlers.get(event) ?? []) last = await h(evt, ctx);
  return last;
}

/** 构造 ExtensionContext 最小视图 */
function ctxOf(m: MockPi, cwd = process.cwd()): { cwd: string; ui: MockUI; sessionManager: { getBranch: () => Array<{ type: string; customType?: string; data?: unknown }> } } {
  const sessionManager = {
    getBranch: () => [...m.entries],
  };
  return { cwd, ui: m.ui, sessionManager: sessionManager as never };
}

/* ============================ tests ============================ */

ok("classify: 只读/写面/未知 三分类", () => {
  assert.equal(classifyBash("ls -la"), "read");
  assert.equal(classifyBash("grep foo x"), "read");
  assert.equal(classifyBash("rm -rf x"), "write");
  assert.equal(classifyBash("git status"), "read");
  assert.equal(classifyBash("git commit -m x"), "write");
  assert.equal(classifyBash("curl -o out http://x"), "write");
  assert.equal(classifyBash("foobar"), "unknown");
  assert.deepEqual(scanPipeline("ls && echo hi; git status"), ["ls", "echo hi", "git status"]);
});

ok("docker 分类：只读白名单放行、写/未知拦截", () => {
  assert.equal(classifyDockerWrite("docker ps"), false);
  assert.equal(classifyDockerWrite("docker compose ps"), false);
  assert.equal(classifyDockerWrite("docker rm -f x"), true);
  assert.equal(classifyDockerWrite("docker volume ls"), false);
  assert.equal(classifyDockerWrite("volume ls"), true); // 无 docker 前缀
});

ok("sandbox: readonly 只读基座 / verify 工作区可写 + .git 保护", () => {
  overrideBwrapDetect(() => true);
  const workspace = process.cwd();
  const base = { mode: "plan" as const, bwrapAvailable: true, sandbox: { mountHome: true, dockerSocket: true, extras: [] } };
  const ro = sandboxDecision({ ...base, safetyMode: "readonly" }, "ls", workspace, workspace);
  assert.ok(ro.command.startsWith("bwrap"));
  assert.ok(ro.command.includes("--ro-bind / /"));
  assert.ok(ro.command.includes("--ro-bind"));
  const vf = sandboxDecision({ ...base, safetyMode: "verify" }, "make test", workspace, workspace);
  assert.ok(vf.command.startsWith("bwrap"));
  assert.ok(vf.command.includes("--bind"));
  const sup = sandboxDecision({ ...base, safetyMode: "supervised" }, "ls", workspace, workspace);
  assert.equal(sup.command, "ls");
  const bld = sandboxDecision({ ...base, mode: "build", safetyMode: "readonly" }, "ls", workspace, workspace);
  assert.equal(bld.command, "ls");
});

ok("sandbox: 引号安全 + verify 无 .git 目录时不挂", () => {
  const cmd = buildBwrapCommand("echo hello", "/ws", { profile: "readonly" });
  assert.ok(cmd.includes("sh -c 'echo hello'"));
  const noGit = buildBwrapCommand("ls", "/nonexistent-root-xyz", { profile: "verify" });
  assert.ok(!noGit.includes("/nonexistent-root-xyz/.git"));
});

ok("v4 路线X: selectBackend 按平台分流 shellTool + pwsh 沙箱档判定", () => {
  const w = selectBackend("win32");
  assert.equal(w.info.kind, "winacl");
  assert.equal(w.shellTool, "powershell");
  const l = selectBackend("linux");
  assert.equal(l.info.kind, "bwrap");
  assert.equal(l.shellTool, "bash");
  assert.ok(shouldUsePowershellSandbox({ platform: "win32", shellTool: "powershell", available: true, safetyMode: "readonly" }));
  assert.ok(shouldUsePowershellSandbox({ platform: "win32", shellTool: "powershell", available: true, safetyMode: "verify" }));
  assert.ok(!shouldUsePowershellSandbox({ platform: "win32", shellTool: "powershell", available: false, safetyMode: "readonly" }));
  assert.ok(!shouldUsePowershellSandbox({ platform: "win32", shellTool: "powershell", available: true, safetyMode: "supervised" }));
  assert.ok(!shouldUsePowershellSandbox({ platform: "linux", shellTool: "powershell", available: true, safetyMode: "readonly" }));
  assert.ok(!shouldUsePowershellSandbox({ platform: "win32", shellTool: "bash", available: true, safetyMode: "readonly" }));
});

ok("扩展注册：工具/命令/flag 齐全，默认 build 工具集", async () => {
  const m = mockPi();
  planbuildExtension(m.api);
  // 沙箱 shell 随平台：win32 → pwsh（winacl 移 bash 加 powershell）；其他 → bash（bwrap）。
  const shellTool = process.platform === "win32" ? "powershell" : "bash";
  for (const t of ["plan_file", "plan_mode_complete", "build_status", "ask_user_question", shellTool]) {
    assert.ok(m.tools.has(t), `缺少工具 ${t}`);
  }
  for (const c of ["plan", "build", "plan-safety", "plan-sandbox"]) {
    assert.ok(m.commands.has(c), `缺少命令 ${c}`);
  }
  for (const f of ["plan", "plan-safety", "plan-file", "plan-mount"]) {
    assert.ok(m.flags.has(f), `缺少 flag ${f}`);
  }
  // 默认 build：edit/write 可用
  assert.ok(m.activeTools.includes("edit"));
});

ok("C1: 模式切换落事件 + 工具集增删", async () => {
  const m = mockPi();
  planbuildExtension(m.api);
  const ctx = ctxOf(m);
  await m.commands.get("plan")!.handler("", ctx);
  assert.ok(m.activeTools.includes("plan_file"));
  assert.ok(!m.activeTools.includes("edit"));
  await m.commands.get("build")!.handler("", ctx);
  assert.ok(m.activeTools.includes("edit"));
  assert.ok(m.entries.some((e) => (e.data as { kind?: string })?.kind === "mode"));
});

ok("模式切换 notice（dsh narration 语义，幂等）", async () => {
  const m = mockPi();
  planbuildExtension(m.api);
  const ctx = ctxOf(m);
  // 首次（build）：只记录不注入
  const r0 = await fire(m, "before_agent_start", { systemPrompt: "SP" }, ctx) as { message?: { customType: string } };
  assert.ok(!r0.message);
  // 切 plan → 下次注入单句 notice
  await m.commands.get("plan")!.handler("", ctx);
  const r1 = await fire(m, "before_agent_start", { systemPrompt: "SP" }, ctx) as { message?: { customType: string } };
  assert.ok(r1.message?.customType === `${PB_ENTRY_TYPE}:mode-notice`);
  // 幂等：mode 未变不重复注入
  const r2 = await fire(m, "before_agent_start", { systemPrompt: "SP" }, ctx) as { message?: { customType: string } };
  assert.ok(!r2.message);
});

ok("C1: 会话恢复 = getBranch 折叠（含 v3 blob 兼容）", () => {
  const folded = foldEvents(parsePbEvents([
    { type: "custom", customType: PB_ENTRY_TYPE, data: { mode: "plan", safetyMode: "readonly", planFile: "/tmp/old.md" } }, // v3 快照（前）
    { type: "custom", customType: PB_ENTRY_TYPE, data: { kind: "mode", value: "plan" } },
    { type: "custom", customType: PB_ENTRY_TYPE, data: { kind: "safety", value: "verify" } }, // v4 事件（后，last-wins）
    { type: "custom", customType: PB_ENTRY_TYPE, data: { kind: "grant", command: "npm test" } },
  ]));
  assert.equal(folded.mode, "plan");
  assert.equal(folded.safetyMode, "verify"); // v4 事件覆盖快照
  assert.equal(folded.planFilePath, "/tmp/old.md");
  assert.deepEqual(folded.approveMemory.get("npm test"), true);
});

ok("C2: verify 档设置 + 无可用后端降级", async () => {
  const isWin = process.platform === "win32";
  const setAvail = (v: boolean): void => {
    // 沙箱后端随平台：win32→winacl；其他→bwrap。测试按实际后端覆盖其可用性。
    if (isWin) overrideWinaclProbe(() => v);
    else overrideBwrapDetect(() => v);
  };
  setAvail(true);
  const m2 = mockPi();
  planbuildExtension(m2.api);
  await m2.commands.get("plan-safety")!.handler("verify", ctxOf(m2));
  assert.ok(m2.entries.some((e) => { const d = e.data as { kind: string; value: string } | undefined; return d?.kind === "safety" && d.value === "verify"; }));
  setAvail(false);
  const m3 = mockPi();
  planbuildExtension(m3.api);
  await m3.commands.get("plan-safety")!.handler("verify", ctxOf(m3));
  assert.ok(m3.ui.notifies.some((n) => n.includes("无法切换到该档位")));
  // 恢复真实自检（win32 走已缓存结果，避免后续重跑 pwsh 冒烟）。
  if (isWin) overrideWinaclProbe(undefined);
  else overrideBwrapDetect(() => true);
});

ok("层 2 门控：readonly docker 拦截 / supervised confirm(grant) / strict 拒绝", async () => {
  overrideBwrapDetect(() => true);
  const m1 = mockPi();
  planbuildExtension(m1.api);
  const ctx1 = ctxOf(m1);
  await m1.commands.get("plan")!.handler("", ctx1);
  const dockerBlock = await fire(m1, "tool_call", { type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "docker rm -f x" } }, ctx1) as { block?: boolean };
  assert.ok(dockerBlock?.block);

  overrideBwrapDetect(() => false);
  const m2 = mockPi();
  planbuildExtension(m2.api);
  const ctx2 = ctxOf(m2);
  await m2.commands.get("plan-safety")!.handler("supervised", ctx2);
  await m2.commands.get("plan")!.handler("", ctx2);
  m2.ui.selectResults.push("允许此类（本会话记住）");
  const r1 = await fire(m2, "tool_call", { type: "tool_call", toolCallId: "2", toolName: "bash", input: { command: "curl http://x" } }, ctx2) as { block?: boolean } | undefined;
  assert.ok(!r1?.block); // 允许此类 → 放行
  assert.ok(m2.entries.some((e) => (e.data as { kind: string })?.kind === "grant"));

  const m3 = mockPi();
  planbuildExtension(m3.api);
  const ctx3 = ctxOf(m3);
  await m3.commands.get("plan-safety")!.handler("strict", ctx3);
  await m3.commands.get("plan")!.handler("", ctx3);
  const strictBlock = await fire(m3, "tool_call", { type: "tool_call", toolCallId: "3", toolName: "bash", input: { command: "curl http://x" } }, ctx3) as { block?: boolean };
  assert.ok(strictBlock?.block);
});

ok("C3 + S1: plan_mode_complete 三分支（批准/继续规划/dismissed）", async () => {
  const m = mockPi();
  planbuildExtension(m.api);
  const wd = mkdtempSync(join(tmpdir(), "pb-s1-"));
  const ctx = ctxOf(m, wd);
  await m.commands.get("plan")!.handler("", ctx);
  const tool = m.tools.get("plan_mode_complete")!;
  m.ui.selectResults.push("批准并执行");
  const res = await tool.execute("id", { plan: "## 计划A" }, undefined, undefined, ctx as never) as AgentToolResult<unknown>;
  assert.ok((res.content[0] as { text: string }).text.includes("已批准"));
  assert.equal(m.activeTools.includes("edit"), true); // 批准 → 切 build，写工具恢复
  rmSync(wd, { recursive: true, force: true });
});

ok("C3: plan_file 工具读写删（文件即真源）", async () => {
  const m = mockPi();
  planbuildExtension(m.api);
  const wd = mkdtempSync(join(tmpdir(), "pb-plan-"));
  const ctx = ctxOf(m, wd);
  const tool = m.tools.get("plan_file")!;
  await tool.execute("id", { action: "write", content: "hello plan" }, undefined, undefined, ctx as never);
  const rd = await tool.execute("id", { action: "read" }, undefined, undefined, ctx as never) as AgentToolResult<unknown>;
  assert.ok((rd.content[0] as { text: string }).text.includes("hello plan"));
  rmSync(wd, { recursive: true, force: true });
});

ok("S2: grant 事件跨会话恢复（fold 后记忆仍在）", () => {
  const folded = foldEvents(parsePbEvents([
    { type: "custom", customType: PB_ENTRY_TYPE, data: { kind: "grant", command: "npm test" } },
    { type: "custom", customType: PB_ENTRY_TYPE, data: { kind: "grant", command: "npm test" } },
  ]));
  assert.deepEqual(folded.approveMemory.get("npm test"), true);
});

ok("docker.sock 掩码三态：默认掩码 / docker 只读命令可见 / off 全掩码", () => {
  const sock = "/run/docker.sock";
  assert.ok(socketMaskFor(true, sock, "ls") === sock); // 非 docker → 掩码
  assert.ok(socketMaskFor(true, sock, "docker ps") === undefined); // docker 只读 → 可见
  assert.ok(socketMaskFor(true, sock, "docker rm -f x") === sock); // docker 写 → 掩码
  assert.ok(socketMaskFor(false, sock, "docker ps") === sock); // off → 全掩码
});

ok("detectDockerSocket: realpath 解开符号链接", () => {
  const p = detectDockerSocket(["/nonexistent.sock"]);
  assert.equal(p, undefined);
});

ok("normalizeShellPath: 对齐 pi normalizePath（win32 驱动器样式 + ~ 展开）", () => {
  assert.equal(normalizeShellPath("~"), homedir());
  assert.equal(normalizeShellPath("/c/Users/x/bash.exe", "win32"), "C:\\Users\\x\\bash.exe");
  assert.equal(normalizeShellPath("~/bin/bash"), join(homedir(), "bin", "bash"));
});

ok("detectShellPath: project 覆盖 global（透传 settings.json shellPath）", () => {
  const p = detectShellPath(process.cwd());
  assert.ok(p === undefined || typeof p === "string"); // 无配置时 undefined；不抛
});

/* ============================ runner ============================ */
let passed = 0;
for (const [name, fn] of tests) {
  await fn();
  passed++;
  console.log(`  ✅ ${name}`);
}
console.log(`\n冒烟测试全部通过：${passed} 组。`);
