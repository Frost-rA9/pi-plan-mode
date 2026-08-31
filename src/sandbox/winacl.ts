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
 * 实现：koffi（native FFI）；win32 模块在 ./win32/。非 win32 / 未自检 pass → available=false →
 * fail-closed 降级链（readonly/verify → supervised），决不无限制 spawn。
 */
import { createRequire } from "node:module";
import type { BashToolOptions } from "@earendil-works/pi-coding-agent";
import { createLocalPowerShellOperations, type PowerShellOperations } from "@earendil-works/pi-coding-agent";
import type { SandboxBackend, BackendContext } from "./backend.ts";
import type { SandboxBackendInfo } from "../events.ts";
import type { WinaclSession } from "./win32/index.ts";

/** ESM 下惰性 require（win32 模块带 koffi，懒加载 + fail-closed）。 */
const win32Require = createRequire(import.meta.url);

export function winaclUsable(): boolean {
  return process.platform === "win32";
}

class WinaclBackend implements SandboxBackend {
  readonly kind = "winacl" as const;
  readonly shellTool = "powershell" as const;
  info: SandboxBackendInfo = { kind: "winacl", available: false, shellTool: "powershell" };
  private session: WinaclSession | undefined;
  private activeProfile: "readonly" | "verify" | undefined;

  probe(): boolean {
    if (!winaclUsable()) {
      this.info.available = false;
      return false;
    }
    try {
      this.info.available = Boolean(win32Require("./win32/index.ts").winaclProbe());
    } catch {
      this.info.available = false;
    }
    return this.info.available;
  }

  createToolOptions(ctx: BackendContext): BashToolOptions {
    if (!this.info.available) {
      // 不可用（非 win32 / 未自检）：不注入沙箱，纯本地 pwsh——走既有降级链（fail-closed）
      return {};
    }
    const localPwsh: PowerShellOperations = createLocalPowerShellOperations();
    return {
      operations: {
        exec: async (command, cwd, options) => {
          const s = ctx.readState();
          const sandboxed = s.mode === "plan" && (s.safetyMode === "readonly" || s.safetyMode === "verify");
          if (!sandboxed) return localPwsh.exec(command, cwd, options);
          const profile: "readonly" | "verify" = s.safetyMode === "verify" ? "verify" : "readonly";
          const session = await this.ensureSession(profile, ctx);
          // fail-closed：readonly/verify 档已是「沙箱意图」，会话未授权则拒绝无限制执行。
          if (!session.isSpawnable()) {
            throw new Error("winacl 会话未完成授权（isSpawnable=false）：fail-closed，拒绝无限制执行。请检查 Win32 绑定自检");
          }
          return session.exec(command, cwd, options);
        },
      },
    };
  }

  private async ensureSession(profile: "readonly" | "verify", ctx: BackendContext): Promise<WinaclSession> {
    const mod = await import("./win32/index.ts");
    if (this.activeProfile !== profile || !this.session) {
      await this.dispose();
      this.session = mod.createWinaclSession({ cwd: ctx.cwd, profile, readState: ctx.readState });
      await this.session.init(profile);
      this.activeProfile = profile;
    }
    return this.session;
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
