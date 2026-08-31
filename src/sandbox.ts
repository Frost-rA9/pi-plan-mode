/**
 * pi-planbuild v4 · 层 1：OS 边界（可插拔沙箱后端）+ 档位 = 边界策略参数化（C2）。
 *
 * createBashTool / createPowerShellTool + 后端 options；后端按平台选择：
 * - bwrap（Linux/WSL2）：spawnHook 注入 bwrap 前缀，shell=bash（覆盖内置 bash）。
 * - winacl（Windows 受限令牌 + NTFS ACE）：custom operations.exec，**shell=pwsh**（registerSandbox 用 createPowerShellTool）。
 */
import { createBashTool, createPowerShellTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PbState, PbRuntime } from "./events.ts";
import { selectBackend } from "./sandbox/backend.ts";
import { detectShellPath } from "./sandbox/bwrap.ts";
import { isSandboxedProfile } from "./sandbox/bwrap.ts";

export { isSandboxedProfile };

export function registerSandbox(
  pi: ExtensionAPI,
  store: { state: PbState; runtime: PbRuntime },
): void {
  const backend = selectBackend();
  backend.probe();
  store.runtime.sandbox = {
    kind: backend.info.kind,
    available: backend.info.available,
    shellTool: backend.info.shellTool,
  };

  const workspaceRoot = process.cwd();
  // 覆盖 bash 须透传 settings.json 的 shellPath；winacl 用 pwsh，无 shellPath。
  const shellPath = backend.info.shellTool === "powershell" ? undefined : detectShellPath(workspaceRoot);

  const toolOptions = backend.createToolOptions({
    cwd: workspaceRoot,
    shellPath,
    readState: () => ({
      mode: store.state.mode,
      safetyMode: store.state.safetyMode,
      sandbox: store.state.sandbox,
    }),
  });

  // v4 路线 X：winacl→powershell 工具（保 git bash 原生不冲突）；bwrap→bash 工具。
  const shellTool =
    backend.info.shellTool === "powershell"
      ? createPowerShellTool(workspaceRoot, {
          operations: toolOptions.operations,
          spawnHook: toolOptions.spawnHook,
        })
      : createBashTool(workspaceRoot, toolOptions);

  pi.registerTool({
    ...shellTool,
    execute: async (id, params, signal, onUpdate) => shellTool.execute(id, params, signal, onUpdate),
  });
}
