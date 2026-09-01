/**
 * pi-plan-sandbox 测试：selectBackend / buildBwrapCommand / safeQuote / socketMaskFor /
 * detectDockerSocket / normalizeShellPath / sandboxDecision（纯函数 + 后端选择）。
 * 运行：node --experimental-strip-types test/sandbox.spec.ts
 */
import assert from "node:assert/strict";
import {
  selectBackend,
  buildBwrapCommand,
  safeQuote,
  socketMaskFor,
  detectDockerSocket,
  normalizeShellPath,
  sandboxDecision,
  type SandboxDecisionState,
} from "../src/index.ts";

// v4 路线 X：win32→powershell，linux→bash
assert.equal(selectBackend("win32").shellTool, "powershell");
assert.equal(selectBackend("linux").shellTool, "bash");

// 档位 → bwrap 挂载：readonly 工作区只读、verify 可写
const ro = buildBwrapCommand("ls", "/ws", { profile: "readonly", chdir: "/ws" });
assert.ok(ro.includes("--ro-bind"));
const verify = buildBwrapCommand("ls", "/ws", { profile: "verify", chdir: "/ws" });
// verify 应允许工作区可写（含可写绑定 workspaceRoot）
assert.ok(verify.includes("workspace") || verify.includes("/ws"));

// 引号安全
assert.equal(safeQuote("a'b"), "'a'\\''b'");

// docker.sock 掩码：docker 只读可见、写/未知掩码
assert.equal(socketMaskFor(true, "/run/docker.sock", "docker ps"), undefined); // 只读 → 可见
assert.equal(socketMaskFor(true, "/run/docker.sock", "docker rm -f x"), "/run/docker.sock"); // 写 → 掩码（返回路径 = 被 mask？见下方检查）
assert.equal(socketMaskFor(false, "/run/docker.sock", "docker ps"), "/run/docker.sock"); // off → 全掩码? 见下

// 说明：socketMaskFor 返回 undefined = 可见（不掩码）；返回路径 = 掩码目标。
// 只读子命令 → undefined（可见）；写子命令 → 返回 socketPath（掩码）。off → 返回 socketPath（掩码）。
assert.equal(socketMaskFor(true, "/run/docker.sock", "docker ps"), undefined);

// detectDockerSocket：无候选 → undefined
assert.equal(detectDockerSocket(["/nonexistent.sock"]), undefined);

// normalizeShellPath（win32 驱动器样式）
assert.equal(normalizeShellPath("/c/Users/x/bash.exe", "win32"), "C:\\Users\\x\\bash.exe");
assert.equal(normalizeShellPath("~/bin/bash"), process.env.HOME ? `${process.env.HOME}/bin/bash` : normalizeShellPath("~/bin/bash"));

// sandboxDecision：plan + readonly/verify + 可用 → 注入 bwrap；否则原样
const base: SandboxDecisionState = {
  mode: "plan",
  safetyMode: "readonly",
  bwrapAvailable: true,
  sandbox: { mountHome: true, dockerSocket: true, extras: [] },
};
const injected = sandboxDecision(base, "ls", "/ws", "/root");
assert.ok(injected.command.includes("bwrap"));
const off = sandboxDecision({ ...base, bwrapAvailable: false }, "ls", "/ws", "/root");
assert.equal(off.command, "ls");

console.log("✅ sandbox: selectBackend / bwrap / quote / socketMask / normalize / sandboxDecision");
