/**
 * pi-planbuild v4（路线 X）· winacl（Windows）后端往返自检脚本。
 *
 * 运行：`npm run probe:winacl`（须在 **真实 Windows 机** + koffi 已安装）。
 *
 * 沙箱 shell = pwsh（受限令牌与 git bash 固有不兼容，v4 改用 pi 的 `powershell` 工具；与 dsh/Codex 一致）。
 * 四态自诊断：非 win32 跳过 / winaclProbe=false fail-closed / 会话未启用 / 可 spawn 安全往返断言。
 */
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createWinaclSession, winaclProbe, type WinaclSession } from "../src/sandbox/win32/index.ts";
import { win32SensitivePaths } from "../src/config.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  const mark = cond ? "✅" : "❌";
  if (!cond) failures++;
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ""}`);
}

const setContent = (p: string) => `Set-Content -LiteralPath '${p}' -Value 'hi'`;
const getContent = (p: string) => `Get-Content -LiteralPath '${p}'`;

async function run(
  session: WinaclSession,
  command: string,
): Promise<{ code: number | null }> {
  const res = await session.exec(command, process.cwd(), { onData: () => {} });
  return { code: res.exitCode };
}

/** 宿主（非受限）上下文执行：验证 dispose 后 ACL 恢复、宿主权限回归。 */
function hostRun(command: string): number {
  const r = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8" });
  return r.status ?? -1;
}

/** 选一个真实存在、宿主可读的敏感**文件**（deny-read 目标；排除宿主必需 .pi/.config/.copilot）。 */
function pickSensitivePath(): string | null {
  const home = process.env.USERPROFILE ?? "";
  const excluded = /[\./](?:\\.pi|\\.config|\\.copilot)$/i;
  for (const p of win32SensitivePaths(home)) {
    const norm = p.replaceAll("\\", "/");
    if (excluded.test(norm)) continue;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

async function readOnlyRoundTrip(cwd: string): Promise<void> {
  const sec = pickSensitivePath();
  const hostBefore = sec !== null ? hostRun(getContent(sec)) : null;
  const session = createWinaclSession({ cwd, profile: "readonly", readState: () => undefined });
  await session.init("readonly");
  if (!session.isSpawnable()) {
    console.log("  ⚠️  会话 isSpawnable()=false —— 实现未完成，跳过往返验证");
    return;
  }
  const w = await run(session, setContent(join(cwd, "pb-probe-out.txt")));
  check("readonly · 写工作区被拒", w.code !== 0, `exit=${w.code}`);
  const t = await run(session, setContent(join(tmpdir(), "pb-probe-out.txt")));
  check("readonly · 写 temp 之外被拒（无写 SID）", t.code !== 0, `exit=${t.code}`);
  if (sec !== null) {
    check("readonly · 敏感路径宿主先读（前置条件）", hostBefore === 0, `exit=${hostBefore}`);
    const r = await run(session, getContent(sec));
    check("readonly · 敏感路径读被拒（真实拒绝）", r.code !== 0, `exit=${r.code}`);
  } else {
    console.log("  ⚠️  无真实敏感路径可测，跳过 deny-read 验证");
  }
  await session.dispose();
  if (sec !== null) {
    const hostAfter = hostRun(getContent(sec));
    check("readonly · dispose 后敏感路径宿主可读（恢复）", hostAfter === 0, `exit=${hostAfter}`);
  }
}

async function verifyRoundTrip(cwd: string): Promise<void> {
  const session = createWinaclSession({ cwd, profile: "verify", readState: () => undefined });
  await session.init("verify");
  if (!session.isSpawnable()) {
    console.log("  ⚠️  会话 isSpawnable()=false —— 实现未完成，跳过往返验证");
    return;
  }
  const ws = join(cwd, "pb-probe-out.txt");
  const w = await run(session, setContent(ws));
  check("verify · 工作区可写", w.code === 0, `exit=${w.code}`);
  const g = await run(session, setContent(join(cwd, ".git", "pb-probe-out.txt")));
  check("verify · .git 只读（写被拒）", g.code !== 0, `exit=${g.code}`);
  const p = await run(session, setContent(join(cwd, ".pi", "pb-probe-out.txt")));
  check("verify · .pi 只读（写被拒）", p.code !== 0, `exit=${p.code}`);
  // 私有 temp（verify 会话把子进程 TEMP 指向私有目录并授予写）可写。
  const t = await run(session, `Set-Content -LiteralPath (Join-Path $env:TEMP 'pb-temp-out.txt') -Value 'x'`);
  check("verify · 私有 temp 可写", t.code === 0, `exit=${t.code}`);
  const sec = pickSensitivePath();
  if (sec !== null) {
    const r = await run(session, getContent(sec));
    check("verify · 敏感路径读被拒（真实拒绝）", r.code !== 0, `exit=${r.code}`);
  } else {
    console.log("  ⚠️  无真实敏感路径可测，跳过 verify deny-read 验证");
  }
  await session.dispose();
  const after = hostRun(setContent(ws));
  check("verify · dispose 后工作区写恢复宿主权限（宿主 pwsh）", after === 0, `exit=${after}`);
}

async function main(): Promise<void> {
  console.log(`winacl 自检 · platform=${process.platform}`);
  if (process.platform !== "win32") {
    console.log("  跳过：须在真实 Windows 机运行（WSL2 / Linux 无法执行 Win32 ACL/令牌语义）");
    process.exit(0);
  }
  if (!winaclProbe()) {
    console.log("  ⚠️  winaclProbe()=false —— Phase 2 原生绑定未接入 / 自检未通过 → fail-closed 降级 supervised（安全）");
    console.log("  提示：看 src/sandbox/win32/README.md 接入 CreateRestrictedToken/SetEntriesInAclW + pwsh-under-token 冒烟");
    process.exit(0);
  }
  console.log("  ✅ winaclProbe()=true —— 绑定已接入且自检通过，开始安全往返验证");
  const cwd = mkdtempSync(join(tmpdir(), "pb-winacl-"));
  try {
    await readOnlyRoundTrip(cwd);
    await verifyRoundTrip(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "\n✅ winacl 往返安全断言全部通过" : `\n❌ ${failures} 项断言失败（不可接受的安全回归，勿启用）`);
  process.exit(failures > 0 ? 1 : 0);
}

void main();
