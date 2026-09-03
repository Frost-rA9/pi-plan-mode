/**
 * pi-plan-sandbox · OS 沙箱能力（library 包，供 pi-plan-mode import）。
 *
 * 可插拔 = 换 sandbox 包（npm 依赖），而非事件总线。因为 BashSpawnHook 是同步的，
 * 沙箱 spawnHook 需同步读 mode 档位——故由 mode 拥有 spawnHook + 工具，sandbox 提供
 * 后端（probe/shellTool/createToolOptions + 纯 builder），mode 注入 readState（同步闭包）。
 *
 * 语义来源：dsh（Restricted Token/NTFS ACL/Win32 runner）+ Codex（deny-read）+ bwrap（Linux）。
 * fail-closed：后端不可用 → 降级链（readonly/verify → supervised），决不无限制 spawn。
 */
export {
  selectBackend,
  createBwrapBackend,
  type SandboxBackend,
  type BackendContext,
} from "./backend.ts";
export {
  detectBwrap,
  overrideBwrapDetect,
  probeBwrap,
  safeQuote,
  expandHomePath,
  normalizeMountPath,
  isSafeExtraMount,
  filterSafeExtraMounts,
  detectSettingsSkills,
  getMaskSource,
  buildHomeMounts,
  buildBwrapCommand,
  normalizeShellPath,
  detectShellPath,
  detectPodmanSocket,
  socketMaskFor,
  sandboxDecision,
  isSandboxedProfile,
  type BwrapOptions,
  type SandboxDecisionState,
} from "./bwrap.ts";
export { winaclUsable, createWinaclBackend } from "./winacl.ts";
// 注意：**不**顶层 re-export win32/ 运行时符号——win32/index.ts（koffi 绑定 + struct 全局注册）
// 只能由独立 Node runner 子进程（win32/runner.ts）或在 Windows 上按需加载；
// 任何平台经 sandbox 包入口加载 win32/ 都会执行 koffi.struct 注册，jiti 双重加载即抛
// 「Duplicate type name」（PIB_STARTUPINFOW）→ import("pi-plan-sandbox") 失败 → 能力整体降级。

// 安全清单（bwrap/winacl 内部的敏感路径定义；mode 不需 import）
export {
  SENSITIVE_HOME_DIRS,
  SENSITIVE_HOME_FILES,
  HOME_ALLOW_REMOUNTS,
  WORKSPACE_RO_SUBPATHS,
  win32SensitivePaths,
  win32AllowRemountPaths,
} from "./config.ts";

export const NAME = "pi-plan-sandbox";
