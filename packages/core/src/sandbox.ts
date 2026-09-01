/**
 * pi-plan-mode · 层 1：OS 边界（惰性引用 pi-plan-sandbox 库）+ 档位 = 边界策略参数化（C2）。
 *
 * 经能力注册拿到 SandboxApi（可选）：sandboxApi 缺席 → 不覆盖 shell 工具（gate 降级）；否则按平台选后端：
 * - bwrap（Linux/WSL2）：spawnHook 注入 bwrap 前缀，shell=bash（覆盖内置 bash）。
 * - winacl（Windows 受限令牌 + NTFS ACE）：custom operations.exec，shell=pwsh（createPowerShellTool）。
 */
import { createBashTool, createPowerShellTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PbState, PbRuntime } from "./events.ts";
import type { SandboxApi } from "./capabilities.ts";

export function registerSandbox(
  pi: ExtensionAPI,
  store: { state: PbState; runtime: PbRuntime },
  sandboxApi?: SandboxApi,
): void {
  if (!sandboxApi) {
    // 无 OS 沙箱能力 → 不覆盖 shell 工具（pi 内置 bash 保留），档位 available=false → gate 降级 supervised
    store.runtime.sandbox = { kind: "bwrap", available: false, shellTool: "bash" };
    return;
  }

  const backend = sandboxApi.selectBackend();
  backend.probe();
  store.runtime.sandbox = {
    kind: backend.info.kind,
    available: backend.info.available,
    shellTool: backend.info.shellTool,
  };

  const workspaceRoot = process.cwd();
  // 覆盖 bash 须透传 settings.json 的 shellPath；winacl 用 pwsh，无 shellPath。
  const shellPath = backend.info.shellTool === "powershell" ? undefined : sandboxApi.detectShellPath(workspaceRoot);

  const toolOptions = backend.createToolOptions({
    cwd: workspaceRoot,
    shellPath,
    readState: () => ({
      mode: store.state.mode,
      safetyMode: store.state.safetyMode,
      sandbox: store.state.sandbox,
    }),
  });

  // 路线 X：winacl→powershell 工具（保 git bash 原生不冲突）；bwrap→bash 工具。
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
