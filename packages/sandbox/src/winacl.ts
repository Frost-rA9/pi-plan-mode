/**
 * pi-planbuild v4（路线 X）· 层 1 后端：winacl（Windows 受限令牌 + NTFS ACE 写/读限制沙箱）。
 *
 * v4（路线 X）关键：沙箱 shell 用 **pwsh（pi `powershell` 工具）**——受限令牌 × git bash（MSYS2/Cygwin）
 * 固有不兼容；四家参考源也在 Windows 上用 pwsh/cmd。因此 `shellTool="powershell"`，registerSandbox 据此用 createPowerShellTool。
 *
 * 语义（dsh `sandbox-windows-acl` 裁剪 + Codex `deny_read` 增补）：
 * - `CreateRestrictedToken(WRITE_RESTRICTED|LUA_TOKEN|DISABLE_MAX_PRIVILEGE)` + capability SID + NTFS ACE 写白名单——免提权。
 * - 敏感路径 deny-read ACE（capability SID），保留 bwrap 的凭据隐藏（最小暴露面）。
 * - enforcement=partial（保留 Everyone、NTFS 硬链接、同身份读限制）——进入 readonly/verify 经 notice 明示。
 * - 生命周期：init() 授权 / dispose() 撤销（不留持久 ACL 残渣）。
 *
 * 实现载体（重要）：pi 宿主是 **Bun**，宿主进程内不能加载 koffi（原生 N-API 插件，Bun 加载即崩）。
 * 故 winacl 全部 koffi/Win32 逻辑在 **独立 Node 子进程**（`./win32/runner.ts`）里执行，本文件只通过
 * 一条极薄的 **IPC（stdin/stdout 一行一个 JSON）** 驱动它——对齐 dsh runner / codex 原生二进制的「OS 沙箱 = 子进程」模式。
 * 非 win32 / 子进程自检未过 → available=false → fail-closed 降级链（readonly/verify → supervised），决不无限制 spawn。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BashToolOptions } from "@earendil-works/pi-coding-agent";
import { createLocalPowerShellOperations, type PowerShellOperations } from "@earendil-works/pi-coding-agent";
import type { SandboxBackend, BackendContext } from "./backend.ts";
import type { SandboxBackendInfo } from "pi-plan-bridge";
import type { WinaclSession } from "./win32/index.ts";

export function winaclUsable(): boolean {
  return process.platform === "win32";
}

/* ------------------------------ 运行时路径 / node 定位 ------------------------------ */

const WINACL_DIR = dirname(fileURLToPath(import.meta.url)); // <root>/src/sandbox
const RUNNER_PATH = resolve(WINACL_DIR, "win32", "runner.ts");
const PACKAGE_ROOT = resolve(WINACL_DIR, "..", "..");

let cachedNodePath: string | undefined;

/** 解析 node 可执行（优先 node.exe，回退 PATH）。 */
function resolveNodePath(): string {
  if (cachedNodePath !== undefined) return cachedNodePath;
  const candidates = process.platform === "win32" ? ["node.exe", "node"] : ["node"];
  for (const dir of (process.env.PATH ?? "").split(";")) {
    if (dir === "") continue;
    for (const name of candidates) {
      const path = resolve(dir, name);
      if (existsSync(path)) return (cachedNodePath = path);
    }
  }
  return (cachedNodePath = "node");
}

/** spawn runner（Node 子进程）。cwd=包根，确保 koffi 从 node_modules 解析。 */
function spawnRunner(args: string[]): ChildProcess {
  return spawn(resolveNodePath(), ["--experimental-strip-types", RUNNER_PATH, ...args], {
    cwd: PACKAGE_ROOT,
    env: process.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** probe（同步）：runner `--probe` 退出码 0 → winacl 可用。 */
function runProbe(): boolean {
  try {
    const r = spawnSync(resolveNodePath(), ["--experimental-strip-types", RUNNER_PATH, "--probe"], {
      cwd: PACKAGE_ROOT,
      env: process.env,
      windowsHide: true,
      timeout: 60_000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/* ------------------------------ IPC 会话客户端 ------------------------------ */

type ExecOptions = { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv };

/** 跑在 runner Node 子进程里的 winacl 会话；本进程只转发 IPC。 */
class RunnerSession implements WinaclSession {
  private readonly workspace: string;
  private child: ChildProcess | undefined;
  private rl: Interface | undefined;
  private spawnable = false;
  private nextId = 0;
  private pendingExec: { onData: (b: Buffer) => void; resolve: (r: { exitCode: number | null }) => void; reject: (e: Error) => void; cleanup?: () => void } | undefined;
  private initResolver: ((ok: boolean) => void) | undefined;
  private disposeResolver: (() => void) | undefined;
  private lastError: string | undefined;

  constructor(opts: { cwd: string; profile: "readonly" | "verify" }) {
    this.workspace = opts.cwd;
  }

  async init(profile: "readonly" | "verify"): Promise<void> {
    this.child = spawnRunner([]);
    const child = this.child;
    this.rl = createInterface({ input: child.stdout! });
    this.rl.on("line", (line) => this.onLine(line));
    child.on("error", (error) => this.rejectAll(new Error(`runner spawn error: ${error.message}`)));
    child.on("close", () => this.rejectAll(new Error(this.lastError ?? "runner exited unexpectedly")));

    this.send({ cmd: "init", profile, cwd: this.workspace });
    await new Promise<void>((res, rej) => {
      this.initResolver = (ok) => {
        this.spawnable = ok;
        if (ok) res();
        else rej(new Error(this.lastError ?? "winacl runner init failed"));
      };
    });
  }

  isSpawnable(): boolean {
    return this.spawnable;
  }

  async exec(command: string, cwd: string, options: ExecOptions): Promise<{ exitCode: number | null }> {
    if (!this.isSpawnable() || this.child === undefined) {
      throw new Error("winacl 会话未完成授权（isSpawnable=false）：fail-closed，拒绝无限制执行。请检查 Win32 绑定自检");
    }
    const id = ++this.nextId;
    return new Promise<{ exitCode: number | null }>((resolveExec, reject) => {
      const killRunner = (): void => {
        // 兜底：runner 无响应时再杀 runner（受限 pwsh 在 kill-on-close Job 内，随 runner 关闭被杀）。
        this.child?.kill();
      };
      const kill = (): void => {
        // 优先让 runner 经 signal 终止子进程（不杀 runner，避免孤儿）；5s 未响应再杀 runner。
        this.send({ cmd: "kill", id });
        setTimeout(killRunner, 5_000).unref();
      };
      const timers: NodeJS.Timeout[] = [];
      if (options.timeout !== undefined && options.timeout > 0) {
        const t = setTimeout(kill, options.timeout);
        t.unref();
        timers.push(t);
      }
      const onAbort = (): void => kill();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.pendingExec = {
        onData: options.onData,
        resolve: resolveExec,
        reject,
        cleanup: () => {
          for (const t of timers) clearTimeout(t);
          options.signal?.removeEventListener("abort", onAbort);
        },
      };
      this.send({ cmd: "exec", id, command, cwd, env: options.env });
    });
  }

  async dispose(): Promise<void> {
    if (this.child === undefined) {
      this.spawnable = false;
      return;
    }
    const done = new Promise<void>((res) => {
      this.disposeResolver = res;
    });
    this.send({ cmd: "dispose" });
    try {
      await done;
    } finally {
      this.teardown();
      this.spawnable = false;
    }
  }

  /* ----- 内部 ----- */

  private send(obj: Record<string, unknown>): void {
    this.child?.stdin?.write(`${JSON.stringify(obj)}\n`);
  }

  private onLine(line: string): void {
    let msg: { type?: string; id?: number; chunk?: string; exitCode?: number | null; message?: string; ok?: boolean };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    switch (msg.type) {
      case "ready":
        this.initResolver?.(msg.ok === true);
        this.initResolver = undefined;
        break;
      case "data":
        if (this.pendingExec && msg.id !== undefined && msg.chunk !== undefined) {
          this.pendingExec.onData(Buffer.from(msg.chunk, "base64"));
        }
        break;
      case "done": {
        const p = this.pendingExec;
        if (p && msg.id !== undefined) {
          this.pendingExec = undefined;
          p.cleanup?.();
          p.resolve({ exitCode: msg.exitCode ?? null });
        }
        break;
      }
      case "disposed":
        this.disposeResolver?.();
        this.disposeResolver = undefined;
        break;
      case "error":
        this.lastError = msg.message ?? "winacl runner error";
        this.rejectAll(new Error(this.lastError));
        break;
      default:
        break;
    }
  }

  private rejectAll(error: Error): void {
    this.lastError ??= error.message;
    this.initResolver?.(false);
    this.initResolver = undefined;
    this.disposeResolver?.();
    this.disposeResolver = undefined;
    if (this.pendingExec) {
      const p = this.pendingExec;
      this.pendingExec = undefined;
      p.cleanup?.();
      p.reject(error);
    }
  }

  private teardown(): void {
    this.rl?.close();
    this.rl = undefined;
    this.child?.stdin?.end();
    this.child?.kill();
    this.child = undefined;
  }
}

/* ------------------------------ Backend ------------------------------ */

class WinaclBackend implements SandboxBackend {
  readonly kind = "winacl" as const;
  readonly shellTool = "powershell" as const;
  info: SandboxBackendInfo = { kind: "winacl", available: false, shellTool: "powershell" };
  private session: RunnerSession | undefined;
  private activeProfile: "readonly" | "verify" | undefined;

  probe(): boolean {
    if (!winaclUsable()) {
      this.info.available = false;
      return false;
    }
    this.info.available = runProbe();
    return this.info.available;
  }

  createToolOptions(ctx: BackendContext): BashToolOptions {
    const localPwsh: PowerShellOperations = createLocalPowerShellOperations();
    return {
      operations: {
        exec: async (command, cwd, options) => {
          const s = ctx.readState();
          const sandboxed = s.mode === "plan" && (s.safetyMode === "readonly" || s.safetyMode === "verify");
          if (!sandboxed) return localPwsh.exec(command, cwd, options);
          if (s.sandbox.piReuse) {
            throw new Error("winacl 后端暂不支持 Pi reuse 的精确文件挂载：fail-closed，未执行命令");
          }
          const profile: "readonly" | "verify" = s.safetyMode === "verify" ? "verify" : "readonly";
          const session = await this.ensureSession(profile, ctx);
          // fail-closed：会话未授权（自检未过/init 失败）即拒绝无限制执行。
          if (!session.isSpawnable()) {
            throw new Error("winacl 会话未完成授权（isSpawnable=false）：fail-closed，拒绝无限制执行。请检查 Win32 自检");
          }
          return session.exec(command, cwd, options);
        },
      },
    };
  }

  private async ensureSession(profile: "readonly" | "verify", ctx: BackendContext): Promise<RunnerSession> {
    if (this.activeProfile === profile && this.session !== undefined && this.session.isSpawnable()) {
      return this.session;
    }
    await this.dispose();
    const session = new RunnerSession({ cwd: ctx.cwd, profile });
    this.session = session;
    this.activeProfile = profile;
    await session.init(profile);
    return session;
  }

  async dispose(): Promise<void> {
    try {
      await this.session?.dispose();
    } finally {
      this.session = undefined;
      this.activeProfile = undefined;
    }
  }
}

export function createWinaclBackend(): SandboxBackend {
  return new WinaclBackend();
}
