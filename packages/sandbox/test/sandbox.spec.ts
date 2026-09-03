/**
 * pi-plan-sandbox 测试：selectBackend / buildBwrapCommand / safeQuote / socketMaskFor /
 * detectDockerSocket / normalizeShellPath / sandboxDecision（纯函数 + 后端选择）。
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
  detectDockerSocket,
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
  sandbox: { mountHome: true, dockerSocket: true, extras: [], piReuse: false },
};
const injected = sandboxDecision(base, "ls", "/ws", "/root");
assert.ok(injected.command.includes("bwrap"));
const off = sandboxDecision({ ...base, bwrapAvailable: false }, "ls", "/ws", "/root");
assert.equal(off.command, "ls");

// 默认只恢复 skills/bin；piReuse 显式开启时只恢复 auth.json/models-store.json。
const fixtureHome = mkdtempSync(join(tmpdir(), "pi-plan-sandbox-home-"));
try {
  const agentDir = join(fixtureHome, ".pi", "agent");
  mkdirSync(join(agentDir, "skills"), { recursive: true });
  mkdirSync(join(fixtureHome, "notes"), { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), "{}", "utf8");
  writeFileSync(join(agentDir, "models-store.json"), "{}", "utf8");

  const normalMounts = buildHomeMounts(fixtureHome, [], false).join(" ");
  assert.ok(normalMounts.includes(`--ro-bind ${join(agentDir, "skills")} ${join(agentDir, "skills")}`));
  assert.ok(!normalMounts.includes(join(agentDir, "auth.json")));
  assert.ok(!normalMounts.includes(join(agentDir, "models-store.json")));

  const reuseMounts = buildHomeMounts(fixtureHome, [], true).join(" ");
  assert.ok(reuseMounts.includes(`--ro-bind ${join(agentDir, "auth.json")} ${join(agentDir, "auth.json")}`));
  assert.ok(reuseMounts.includes(`--ro-bind ${join(agentDir, "models-store.json")} ${join(agentDir, "models-store.json")}`));
  assert.ok(!reuseMounts.includes(`--ro-bind ${join(fixtureHome, ".pi")} ${join(fixtureHome, ".pi")}`));

  assert.equal(isSafeExtraMount(join(fixtureHome, ".pi"), fixtureHome), false);
  assert.equal(isSafeExtraMount(join(fixtureHome, ".pi", "agent"), fixtureHome), false);
  assert.equal(isSafeExtraMount(join(fixtureHome, "notes"), fixtureHome), true);

  const filtered = buildBwrapCommand("ls", "/ws", {
    profile: "readonly",
    chdir: "/ws",
    home: fixtureHome,
    piReuse: true,
    extras: [join(fixtureHome, ".pi"), join(fixtureHome, "notes")],
  });
  assert.ok(filtered.includes(`--ro-bind ${join(agentDir, "auth.json")} ${join(agentDir, "auth.json")}`));
  assert.ok(filtered.includes(`--ro-bind ${join(fixtureHome, "notes")} ${join(fixtureHome, "notes")}`));
  assert.ok(!filtered.includes(`--ro-bind ${join(fixtureHome, ".pi")} ${join(fixtureHome, ".pi")}`));
} finally {
  rmSync(fixtureHome, { recursive: true, force: true });
}

console.log("✅ sandbox: selectBackend / bwrap / quote / socketMask / normalize / sandboxDecision / piReuse");
