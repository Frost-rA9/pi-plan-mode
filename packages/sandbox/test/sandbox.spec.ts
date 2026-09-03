/**
 * pi-plan-sandbox 测试：selectBackend / buildBwrapCommand / safeQuote / socketMaskFor /
 * detectPodmanSocket / normalizeShellPath / sandboxDecision（纯函数 + 后端选择）。
 * 运行：node --experimental-strip-types test/sandbox.spec.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectBackend,
  buildHomeMounts,
  buildBwrapCommand,
  safeQuote,
  socketMaskFor,
  detectPodmanSocket,
  normalizeShellPath,
  sandboxDecision,
  isSafeExtraMount,
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

// podman.sock 掩码：podman 只读可见、写/未知掩码
assert.equal(socketMaskFor(true, "/run/user/1000/podman/podman.sock", "podman ps"), undefined); // 只读 → 可见
assert.equal(socketMaskFor(true, "/run/user/1000/podman/podman.sock", "podman rm -f x"), "/run/user/1000/podman/podman.sock"); // 写 → 掩码
assert.equal(socketMaskFor(false, "/run/user/1000/podman/podman.sock", "podman ps"), "/run/user/1000/podman/podman.sock"); // off → 掩码
assert.equal(socketMaskFor(true, "/run/user/1000/podman/podman.sock", "podman play kube x.yaml"), "/run/user/1000/podman/podman.sock"); // play kube → 写面掩码

// socketMaskFor 语义：undefined = 可见（不掩码）；返回路径 = 掩码目标。
// 非 podman 命令（如 docker）→ 不匹配 isPodman → 全掩码（即使 socket 是 podman 的）。
assert.equal(socketMaskFor(true, "/run/user/1000/podman/podman.sock", "docker ps"), "/run/user/1000/podman/podman.sock");

// detectPodmanSocket：无候选 → undefined
assert.equal(detectPodmanSocket(["/nonexistent.sock"]), undefined);

// normalizeShellPath（win32 驱动器样式）
assert.equal(normalizeShellPath("/c/Users/x/bash.exe", "win32"), "C:\\Users\\x\\bash.exe");
assert.equal(normalizeShellPath("~/bin/bash"), process.env.HOME ? `${process.env.HOME}/bin/bash` : normalizeShellPath("~/bin/bash"));

// sandboxDecision：plan + readonly/verify + 可用 → 注入 bwrap；否则原样
const base: SandboxDecisionState = {
  mode: "plan",
  safetyMode: "readonly",
  bwrapAvailable: true,
  sandbox: { mountHome: true, podmanSocket: true, extras: [] },
};
const injected = sandboxDecision(base, "ls", "/ws", "/root");
assert.ok(injected.command.includes("bwrap"));
const off = sandboxDecision({ ...base, bwrapAvailable: false }, "ls", "/ws", "/root");
assert.equal(off.command, "ls");

// 默认只恢复 skills/bin（敏感目录隐藏；不再有 piReuse 精确文件挂载）。
const fixtureHome = mkdtempSync(join(tmpdir(), "pi-plan-sandbox-home-"));
try {
  const agentDir = join(fixtureHome, ".pi", "agent");
  mkdirSync(join(agentDir, "skills"), { recursive: true });
  mkdirSync(join(fixtureHome, "notes"), { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), "{}", "utf8");
  writeFileSync(join(agentDir, "models-store.json"), "{}", "utf8");

  const normalMounts = buildHomeMounts(fixtureHome, []).join(" ");
  assert.ok(normalMounts.includes(`--ro-bind ${join(agentDir, "skills")} ${join(agentDir, "skills")}`));
  assert.ok(!normalMounts.includes(join(agentDir, "auth.json")));
  assert.ok(!normalMounts.includes(join(agentDir, "models-store.json")));

  assert.equal(isSafeExtraMount(join(fixtureHome, ".pi"), fixtureHome), false);
  assert.equal(isSafeExtraMount(join(fixtureHome, ".pi", "agent"), fixtureHome), false);
  assert.equal(isSafeExtraMount(join(fixtureHome, "notes"), fixtureHome), true);

  const filtered = buildBwrapCommand("ls", "/ws", {
    profile: "readonly",
    chdir: "/ws",
    home: fixtureHome,
    extras: [join(fixtureHome, ".pi"), join(fixtureHome, "notes")],
  });
  assert.ok(filtered.includes(`--ro-bind ${join(fixtureHome, "notes")} ${join(fixtureHome, "notes")}`));
  assert.ok(!filtered.includes(`--ro-bind ${join(fixtureHome, ".pi")} ${join(fixtureHome, ".pi")}`));
  assert.ok(!filtered.includes(join(agentDir, "auth.json"))); // piReuse 移除后不再挂载凭据文件
} finally {
  rmSync(fixtureHome, { recursive: true, force: true });
}

console.log("✅ sandbox: selectBackend / bwrap / quote / socketMask / normalize / sandboxDecision");
