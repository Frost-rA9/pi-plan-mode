/**
 * pi-planbuild v4（路线 X）· winacl：受限令牌 + NTFS ACE 沙箱会话。
 * 来源：dsh `index.ts`（AclSandbox），本方案裁剪为 pi `WinaclSession` 契约 + 增补 deny-read。
 *
 * 档位 → 语义：
 * - readonly：restricting [logonSid, EVERYONE, readDenySid]，无写 grant；敏感路径 deny-read。
 * - verify：restricting [logonSid, EVERYONE, workspaceWriteSid, tempWriteSid, readDenySid]，
 *   工作区 grantWrite + `.git`/`.pi` denyWrite + 敏感 deny-read + 私有 temp grantWrite。
 *
 * 生命周期：init 派生 SID→建令牌→授权（任一失败 throw，决不无限制 spawn）；
 * exec 受限 spawn pwsh；dispose 撤销全部 revocable grant/deny + 释放 SID/令牌 + 删 temp（不留残渣）。
 *
 * ⚠️ 派生决策（真机实测）：
 *  - `CreateProcessWithTokenW` 在本机恒 ERROR_ACCESS_DENIED → 用 `CreateProcessAsUserW`（等效，dsh 亦用）。
 *  - restricted-token 的 restricting SID **只相交写访问，不门控读**；故 deny-read 用**当前用户 SID**
 *    （会临时限制宿主同用户读——enforcement=partial，文档化）。capability readDenySid 加入 restricting
 *    作为防御层（对宿主无害），但真正的读拦截靠用户 SID deny ACE。
 */

import koffi from "koffi";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  win32Sync, allocPtrSlot, allocUint32, decodePtr, isNullPtr, throwLastError,
  type NativePtr, type Win32Bindings,
} from "./ffi.ts";
import * as abi from "./abi.ts";
import { grantWrite, denyWrite, denyRead, saveAcl, applyAcl } from "./acl.ts";
import { workspaceWriteSid, tempWriteSid, readDenySid } from "./sid.ts";
import { spawnPipedProcess, waitForProcessExit, type SpawnedPipedProcess } from "./spawn.ts";
import { drainPipe } from "./stdio.ts";
import {
  createRestrictedToken, currentUserSid, findLogonSid, makeWellKnownSid,
  openCurrentProcessToken, setTokenDefaultDaclGrant,
} from "./token.ts";
import { win32SensitivePaths } from "../config.ts";
import type { WinaclSession, WinaclSessionOptions } from "./index.ts";

/** 创建受限令牌 + 授权所必需的子进程 SID（CreateProcessAsUserW 权限）。 */
const CREATE_PROCESS_PRIVILEGES = ["SeAssignPrimaryTokenPrivilege", "SeIncreaseQuotaPrivilege", "SeImpersonatePrivilege"] as const;

/** 对当前进程令牌启用子进程创建权限。 */
function enableTokenPrivileges(api: Win32Bindings, token: NativePtr, names: readonly string[]): void {
  const slot = allocUint32();
  const luidSlot = koffi.alloc("uint64", 1);
  try {
    for (const name of names) {
      if (api.lookupPrivilegeValueW(null, name, luidSlot) === 0) continue;
      const luid = BigInt(koffi.decode(luidSlot, "uint64"));
      const buf = Buffer.alloc(16);
      buf.writeUInt32LE(1, 0);
      buf.writeBigUInt64LE(luid, 4);
      buf.writeUInt32LE(0x2, 12); // SE_PRIVILEGE_ENABLED
      api.adjustTokenPrivileges(token, 0, buf, 16, 0 as unknown as NativePtr, 0 as unknown as NativePtr);
    }
  } finally {
    koffi.free(luidSlot);
    koffi.free(slot);
  }
}

/** 解析 pwsh（PowerShell 7 优先），与 pi `createLocalPowerShellOperations` 一致。 */
function resolvePwshPath(): string {
  const searchPaths = (process.env.PATH ?? "").split(";");
  for (const dir of searchPaths) {
    for (const base of ["pwsh.exe", "powershell.exe"]) {
      const candidate = join(dir, base);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  // 兜底：已知安装位置。
  const canonical = [
    join(process.env["ProgramFiles"] ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
    join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ];
  for (const c of canonical) if (existsSync(c) && statSync(c).isFile()) return c;
  throw new Error("winacl exec: 未找到 pwsh.exe / powershell.exe（Pi 需要 PowerShell 作为沙箱 shell）");
}

/** 规范化路径（realpath 语义由 CreateProcess cwd 负责；此处保留可解析的绝对路径）。 */
function canonicalize(p: string): string {
  return resolve(p);
}


/** deny-read 目标：纯凭据目录/文件（**.pi/.config/.copilot 为宿主必需，排除**）。 */
function readDenyTargets(): string[] {
  const home = homedir();
  const all = win32SensitivePaths(home);
  const excluded = /[\\.\/](\.pi|\.config|\.copilot)$/i;
  const keep: string[] = [];
  for (const p of all) {
    if (excluded.test(p.replaceAll("\\", "/"))) continue;
    keep.push(p);
  }
  return keep;
}



export class WinaclSessionImpl implements WinaclSession {
  private api: Win32Bindings | undefined;
  private currentToken: NativePtr | undefined;
  private restrictedToken: NativePtr | undefined;
  private writeSidPtr: NativePtr | undefined;
  private tempWriteSidPtr: NativePtr | undefined;
  private sidAllocations: NativePtr[] = [];
  private restorePaths: Array<{ path: string; acl: Buffer }> = [];
  private tempDir: string | undefined;
  private workspace: string;
  readonly readState: () => unknown;

  constructor(opts: WinaclSessionOptions) {
    this.workspace = canonicalize(opts.cwd);
    this.readState = opts.readState;
  }

  private track(sid: NativePtr): NativePtr {
    this.sidAllocations.push(sid);
    return sid;
  }

  private parseSid(sidStr: string): NativePtr {
    const api = this.api!;
    const slot = allocPtrSlot();
    if (api.convertStringSidToSidW(sidStr, slot) === 0) throwLastError(api, "ConvertStringSidToSidW", sidStr);
    const sid = decodePtr(slot);
    if (sid === null) throwLastError(api, "ConvertStringSidToSidW", `null SID for ${sidStr}`);
    return this.track(sid);
  }

  /**
   * 记录一次 ACL 修改，dispose 时精确恢复原始 DACL（capture-and-restore，不留残渣）。
   * 无显式 DACL（null）时不修改（避免剥除继承 ACE）。
   */
  private modifyAcl(path: string, mutator: (api: Win32Bindings) => void): void {
    const api = this.api!;
    const original = saveAcl(api, path);
    if (original === null) return;
    this.restorePaths.push({ path, acl: original });
    mutator(api);
  }

  async init(profile: "readonly" | "verify"): Promise<void> {
    const api = win32Sync();
    this.api = api;
    const currentToken = openCurrentProcessToken(api);
    this.currentToken = currentToken;
    enableTokenPrivileges(api, currentToken, CREATE_PROCESS_PRIVILEGES);

    // 派生/建立 SID。
    const userSid = this.track(currentUserSid(api, currentToken));
    const logonSid = this.track(findLogonSid(api, currentToken));
    const worldSid = this.track(makeWellKnownSid(api, abi.WinWorldSid));
    const readDeny = this.parseSid(readDenySid());

    if (profile === "verify") {
      const wsSid = this.parseSid(workspaceWriteSid(this.workspace));
      this.writeSidPtr = wsSid;
      // 工作区写授权（根授予，子项继承）。
      this.modifyAcl(this.workspace, (a) => grantWrite(a, this.workspace, wsSid));
      // .git / .pi 只读（deny 先于 allow）。
      for (const ro of [".git", ".pi"] as const) {
        const p = join(this.workspace, ro);
        if (existsSync(p)) this.modifyAcl(p, (a) => denyWrite(a, p, wsSid));
      }
      // 私有 temp 目录 + 写授权。
      const base = tmpdir();
      if (!existsSync(base)) throw new Error(`winacl init: 临时目录不存在: ${base}`);
      const tempDir = mkdtempSync(join(base, "pi-winacl-"));
      this.tempDir = tempDir;
      const tempSid = this.parseSid(tempWriteSid(tempDir));
      this.tempWriteSidPtr = tempSid;
      this.modifyAcl(tempDir, (a) => grantWrite(a, tempDir, tempSid));
    }

    // deny-read 敏感凭据（用户 SID，纯凭据目录/文件）。
    for (const p of readDenyTargets()) {
      if (!existsSync(p)) continue;
      this.modifyAcl(p, (a) => denyRead(a, p, userSid));
    }

    // 建受限令牌。
    const writeSids = [this.writeSidPtr, this.tempWriteSidPtr].filter((s): s is NativePtr => s !== undefined);
    const restrictedToken = createRestrictedToken(
      api, currentToken, logonSid, writeSids,
      { world: worldSid },
      profile,
      [readDeny],
    );
    this.restrictedToken = restrictedToken;
    // 新对象默认 DACL 允许 capability SID（写 pass-2）。
    setTokenDefaultDaclGrant(api, restrictedToken, this.tempWriteSidPtr ?? this.writeSidPtr ?? worldSid);
  }

  isSpawnable(): boolean {
    return this.api !== undefined && this.restrictedToken !== undefined;
  }

  async exec(
    command: string,
    cwd: string,
    options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv },
  ): Promise<{ exitCode: number | null }> {
    if (!this.isSpawnable()) {
      throw new Error("winacl 会话未完成授权（isSpawnable=false）：fail-closed，拒绝无限制执行");
    }
    const api = this.api!;
    const token = this.restrictedToken!;
    const pwsh = resolvePwshPath();
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command];
    const workdir = isAbsolute(cwd) ? cwd : resolve(this.workspace, cwd);

    // child TEMP/TMP → 私有 temp（verify）；readonly 视环境原样。
    const priorTemp = process.env.TEMP;
    const priorTmp = process.env.TMP;
    if (this.tempDir !== undefined) {
      process.env.TEMP = this.tempDir;
      process.env.TMP = this.tempDir;
    }
    let native: SpawnedPipedProcess;
    try {
      native = spawnPipedProcess(api, { command: pwsh, args, cwd: workdir, token });
    } finally {
      if (this.tempDir !== undefined) {
        if (priorTemp === undefined) delete process.env.TEMP; else process.env.TEMP = priorTemp;
        if (priorTmp === undefined) delete process.env.TMP; else process.env.TMP = priorTmp;
      }
    }
    let killed = false;
    const kill = (): void => {
      if (killed) return;
      killed = true;
      api.terminateProcess(native.process, 1);
    };
    const timer = options.timeout !== undefined && options.timeout > 0
      ? setTimeout(kill, options.timeout)
      : undefined;
    const onAbort = (): void => kill();
    options.signal?.addEventListener("abort", onAbort);

    try {
      const out = drainPipe(api, native.stdoutRead, options.onData);
      const err = drainPipe(api, native.stderrRead, options.onData);
      await Promise.all([out, err]);
      const exitCode = waitForProcessExit(api, native.process);
      return { exitCode };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      // 已 terminate 的子进程句柄由 waitForProcessExit 关闭；管道由 drainPipe 关闭。
    }
  }

  async dispose(): Promise<void> {
    const api = this.api;
    if (api === undefined) return;
    const failures: unknown[] = [];
    // 精确恢复每处修改的原始 DACL（capture-and-restore，不留 ACL 残渣）。
    for (const { path, acl } of this.restorePaths) {
      try {
        if (existsSync(path)) applyAcl(api, path, acl);
      } catch (error) {
        failures.push(error);
      }
    }
    this.restorePaths = [];
    // 释放 SID 分配。
    for (const sid of this.sidAllocations.splice(0)) {
      try {
        const freed = api.localFree(sid);
        if (!isNullPtr(freed)) throwLastError(api, "LocalFree", "session SID");
      } catch (error) {
        failures.push(error);
      }
    }
    // 关闭受限令牌。
    if (this.restrictedToken !== undefined) {
      try {
        if (api.closeHandle(this.restrictedToken) === 0) throwLastError(api, "CloseHandle", "restricted token");
      } catch (error) {
        failures.push(error);
      }
      this.restrictedToken = undefined;
    }
    // 关闭当前进程令牌。
    if (this.currentToken !== undefined) {
      try {
        if (api.closeHandle(this.currentToken) === 0) throwLastError(api, "CloseHandle", "current process token");
      } catch (error) {
        failures.push(error);
      }
      this.currentToken = undefined;
    }
    // 删私有 temp 目录。
    if (this.tempDir !== undefined) {
      try {
        rmSync(this.tempDir, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
      this.tempDir = undefined;
    }
    this.api = undefined;
    this.writeSidPtr = undefined;
    this.tempWriteSidPtr = undefined;
    if (failures.length > 0) {
      throw new AggregateError(failures, `winacl session dispose completed with ${failures.length} cleanup failure(s)`);
    }
  }
}

/** 创建 winacl 会话（非 win32 / 未自检 → NoopSession 由 index.ts 处理）。 */
export function createWinaclSessionImpl(opts: WinaclSessionOptions): WinaclSession {
  return new WinaclSessionImpl(opts);
}
