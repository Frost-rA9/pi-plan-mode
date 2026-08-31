/**
 * pi-planbuild v4（路线 X）· winacl 后端：Win32 受限令牌 + NTFS ACE 沙箱（win32/）。
 *
 * ⚠️ 有意 fail-closed：真正的 Win32 原语（CreateRestrictedToken / SetEntriesInAclW /
 * CreateProcessWithTokenW + Job kill-on-close）在 ./token.ts ./sid.ts ./acl.ts ./grant.ts
 * ./spawn.ts ./stdio.ts，须在真实 Windows + koffi 下构建与自检（含 pwsh-under-token 冒烟）。
 * 未通过 `winaclProbe` 自检 → `available=false` → 降级链（readonly/verify → supervised），
 * **决不无限制 spawn**（对齐 dsh「child is never spawned unrestricted」）。
 */
import type { BashToolOptions } from "@earendil-works/pi-coding-agent";

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

/** koffi 是否可加载 + Win32 原语是否自检通过（fail-closed 判定） */
export function winaclProbe(): boolean {
  if (process.platform !== "win32") return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require("koffi");
    return Boolean(koffi && selfTest());
  } catch {
    return false;
  }
}

/** 真实 Win32 自检：加载绑定表 + 打开当前进程令牌 → 创建受限令牌 → pwsh-under-token 冒烟 */
function selfTest(): boolean {
  try {
    // 真实实现（Phase 2 / Windows 交付）：loadBindings() → openCurrentProcessToken →
    // createRestrictedToken(...) → spawn pwsh -Command 'echo ok' under token，exit 0 即通过。
    // 此处为占位（fail-closed）：phase 2 接入后替换。
    return bootstrapSelfTest();
  } catch {
    return false;
  }
}

function bootstrapSelfTest(): boolean {
  // Phase 2 占位：接入 koffi 绑定后实现。现在恒 false → winacl 不启用（安全）。
  return false;
}

/** 创建会话（非 win32 / 未自检 → NoopSession，isSpawnable=false → fail-closed） */
export function createWinaclSession(_opts: WinaclSessionOptions): WinaclSession {
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
