/**
 * pi-planbuild v4 · 层 1 后端抽象（SandboxBackend）。
 *
 * 后端 = 真实 OS/虚拟化边界；档位只参数化边界，不因档位消失。后端不可用 → 降级链（readonly/verify → supervised）。
 * 按平台选择 + shellTool：
 * - bwrap（Linux/WSL2 命名空间；`./bwrap.ts`）：spawnHook 前缀，shell=bash
 * - winacl（Windows 受限令牌 + NTFS ACE；`./winacl.ts`）：custom operations，**shell=pwsh**（绕开 git bash×受限令牌冲突）
 */
import type { BashToolOptions } from "@earendil-works/pi-coding-agent";
import type { Mode, SandboxBackendInfo, SandboxBackendKind, SandboxShellTool, SafetyMode, SandboxConfig } from "pi-plan-bridge";
import { probeBwrap, detectPodmanSocket, detectSettingsSkills, isSandboxedProfile, sandboxDecision } from "./bwrap.ts";
import { createWinaclBackend } from "./winacl.ts";

/** 后端构建时的宿主/运行时上下文（registerSandbox 组装，随扩展开销一次） */
export interface BackendContext {
  cwd: string;
  shellPath?: string;
  readState: () => { mode: Mode; safetyMode: SafetyMode; sandbox: SandboxConfig };
}

export interface SandboxBackend {
  readonly info: SandboxBackendInfo;
  /** 沙箱 shell（registerSandbox 据此选 createBashTool / createPowerShellTool） */
  readonly shellTool: SandboxShellTool;
  probe(): boolean;
  createToolOptions(ctx: BackendContext): BashToolOptions;
  init?(): Promise<void>;
  dispose?(): Promise<void>;
}

/* ------------------------------ bwrap 后端 ------------------------------ */

class BwrapBackend implements SandboxBackend {
  readonly kind: SandboxBackendKind = "bwrap";
  readonly shellTool: SandboxShellTool = "bash";
  info: SandboxBackendInfo = { kind: "bwrap", available: false, shellTool: "bash" };

  probe(): boolean {
    this.info.available = probeBwrap();
    return this.info.available;
  }

  createToolOptions(ctx: BackendContext): BashToolOptions {
    const podmanSocketPath = detectPodmanSocket();
    const settingsSkillPaths = detectSettingsSkills(ctx.cwd);
    return {
      shellPath: ctx.shellPath,
      spawnHook: ({ command, cwd, env }) => {
        const s = ctx.readState();
        const next = sandboxDecision(
          {
            mode: s.mode,
            safetyMode: s.safetyMode,
            bwrapAvailable: this.info.available,
            sandbox: s.sandbox,
            socketPath: podmanSocketPath,
            allowRemounts: settingsSkillPaths,
          },
          command,
          cwd,
          ctx.cwd,
        );
        return { command: next.command, cwd: next.cwd, env };
      },
    };
  }
}

/* ------------------------------ 选择器 ------------------------------ */

export function selectBackend(platform: string = process.platform): SandboxBackend {
  if (platform === "win32") return createWinaclBackend();
  return new BwrapBackend();
}

export function createBwrapBackend(): SandboxBackend {
  return new BwrapBackend();
}

export { isSandboxedProfile };
