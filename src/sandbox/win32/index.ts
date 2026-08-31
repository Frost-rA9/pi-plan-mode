/**
 * pi-planbuild v4（路线 X）· winacl 后端：Win32 受限令牌 + NTFS ACE 沙箱（win32/）。
 *
 * ⚠️ 有意 fail-closed：真正的 Win32 原语（CreateRestrictedToken / SetEntriesInAclW /
 * CreateProcessAsUserW + Job kill-on-close）在此实现并在**真实 Windows（koffi）**下自检
 * （含 pwsh-under-token 冒烟）。未通过 `winaclProbe` 自检 → `available=false` → 降级链
 * （readonly/verify → supervised），**决不无限制 spawn**（对齐 dsh「child is never spawned unrestricted」）。
 */
import koffi from "koffi";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BashToolOptions } from "@earendil-works/pi-coding-agent";
import {
  win32Sync,
  type NativePtr, type Win32Bindings,
} from "./ffi.ts";
import * as abi from "./abi.ts";
import { spawnPipedProcess, waitForProcessExit } from "./spawn.ts";
import { drainPipe } from "./stdio.ts";
import {
  createRestrictedToken, findLogonSid, makeWellKnownSid,
  openCurrentProcessToken, setTokenDefaultDaclGrant,
} from "./token.ts";
import { createWinaclSessionImpl } from "./session.ts";

/** winacl 会话级授权/撤销 + 受限 spawn（供 ../winacl.ts 惰性接入） */
export interface WinaclSession {
  init(profile: "readonly" | "verify"): Promise<void>;
  dispose(): Promise<void>;
  isSpawnable(): boolean;
  exec(
    command: string,
    cwd: string,
    options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv },
  ): Promise<{ exitCode: number | null }>;
}

export interface WinaclSessionOptions {
  cwd: string;
  profile: "readonly" | "verify";
  readState: () => unknown;
}

const CREATE_PROCESS_PRIVILEGES = ["SeAssignPrimaryTokenPrivilege", "SeIncreaseQuotaPrivilege", "SeImpersonatePrivilege"] as const;

function enablePrivileges(api: Win32Bindings, token: NativePtr): void {
  const luidSlot = koffi.alloc("uint64", 1);
  try {
    for (const name of CREATE_PROCESS_PRIVILEGES) {
      if (api.lookupPrivilegeValueW(null, name, luidSlot) === 0) continue;
      const luid = BigInt(koffi.decode(luidSlot, "uint64"));
      const buf = Buffer.alloc(16);
      buf.writeUInt32LE(1, 0);
      buf.writeBigUInt64LE(luid, 4);
      buf.writeUInt32LE(0x2, 12);
      api.adjustTokenPrivileges(token, 0, buf, 16, 0 as unknown as NativePtr, 0 as unknown as NativePtr);
    }
  } finally {
    koffi.free(luidSlot);
  }
}

let winaclProbeOverride: (() => boolean) | undefined;
let cachedProbe: boolean | undefined;

/** 仅测试：覆盖 winacl 自检结果（与 bwrap `overrideBwrapDetect` 同一测试接缝模式）。 */
export function overrideWinaclProbe(fn: (() => boolean) | undefined): void {
  winaclProbeOverride = fn;
}

/** koffi 是否可加载 + Win32 原语是否自检通过（fail-closed 判定）。自检结果缓存（稳定）。 */
export function winaclProbe(): boolean {
  if (winaclProbeOverride !== undefined) return winaclProbeOverride();
  if (process.platform !== "win32") return false;
  if (cachedProbe !== undefined) return cachedProbe;
  try {
    cachedProbe = Boolean(koffi && selfTest());
  } catch {
    cachedProbe = false;
  }
  return cachedProbe;
}

/** 真实 Win32 自检：loadBindings → openCurrentProcessToken → 建受限令牌 → 一条 pwsh-under-token 冒烟。 */
function selfTest(): boolean {
  try {
    return bootstrapSelfTest();
  } catch {
    return false;
  }
}

/**
 * 自检（接入 koffi 后真实实现）：
 * 打开当前进程令牌 → 启用子进程创建权限 → logon/world SID → 建受限令牌 [logon, world]
 * → setTokenDefaultDaclGrant → 受限 spawn `pwsh -NoProfile -NonInteractive -Command 'echo ok'`，
 * exit 0 即通过。任一失败 throw → winaclProbe()=false（fail-closed）。
 */
function bootstrapSelfTest(): boolean {
  const api = win32Sync();
  let currentToken: NativePtr | undefined;
  let restrictedToken: NativePtr | undefined;
  const allocations: NativePtr[] = [];
  const freeSid = (sid: NativePtr | undefined): void => {
    if (sid !== undefined) api.localFree(sid);
  };
  try {
    currentToken = openCurrentProcessToken(api);
    enablePrivileges(api, currentToken);
    const logonSid = findLogonSid(api, currentToken);
    allocations.push(logonSid);
    const worldSid = makeWellKnownSid(api, abi.WinWorldSid);
    allocations.push(worldSid);
    restrictedToken = createRestrictedToken(api, currentToken, logonSid, [], { world: worldSid }, "readonly");
    setTokenDefaultDaclGrant(api, restrictedToken, worldSid);
    // 冒烟：pwsh echo ok 在受限令牌下 exit 0。
    const pwsh = resolveTestPwsh();
    const native = spawnPipedProcess(api, { command: pwsh, args: ["-NoProfile", "-NonInteractive", "-Command", "echo ok"], cwd: process.cwd(), token: restrictedToken });
    // 输出极小（< 管道缓冲），先排空防管道写阻塞，child 退出后 wait 立即返回。
    const outD = drainPipe(api, native.stdoutRead, () => {});
    const errD = drainPipe(api, native.stderrRead, () => {});
    void outD;
    void errD;
    const exitCode = waitForProcessExit(api, native.process);
    return exitCode === 0;
  } catch {
    return false;
  } finally {
    for (const sid of allocations.splice(0)) freeSid(sid);
    if (restrictedToken !== undefined) api.closeHandle(restrictedToken);
    if (currentToken !== undefined) api.closeHandle(currentToken);
  }
}

function resolveTestPwsh(): string {
  for (const dir of (process.env.PATH ?? "").split(";")) {
    for (const base of ["pwsh.exe", "powershell.exe"]) {
      const candidate = join(dir, base);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** 创建会话（非 win32 / 未自检 → NoopSession，isSpawnable=false → fail-closed） */
export function createWinaclSession(opts: WinaclSessionOptions): WinaclSession {
  if (process.platform === "win32" && winaclProbe()) {
    return createWinaclSessionImpl(opts);
  }
  return new NoopSession();
}

class NoopSession implements WinaclSession {
  async init(): Promise<void> {
    /* 不授权 */
  }
  async dispose(): Promise<void> {
    /* 撤销为空 */
  }
  isSpawnable(): boolean {
    return false;
  }
  async exec(
    _command: string,
    _cwd: string,
    options: { onData: (d: Buffer) => void },
  ): Promise<{ exitCode: number | null }> {
    options.onData(Buffer.from(""));
    return { exitCode: null };
  }
}

export type { BashToolOptions };
