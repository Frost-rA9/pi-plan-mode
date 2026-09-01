/**
 * pi-plan-mode · 层 0：模式管理（工具可得性）+ 状态条 + 提示注入。
 *
 * - plan：快照工具集 → 移除 edit/write（shell 工具由沙箱后端决定）；win32+winacl 沙箱档 → 移除 bash、加入 powershell。
 * - build：恢复完整工具集
 * - 严格切换：仅用户 /build / Ctrl+Alt+B；模型不能自行切换模式（四家共识 + pi「打断 = 用户决策点」）。
 */
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isSandboxedProfile } from "pi-plan-bridge";
import { type SafetyMode, type SandboxShellTool, PB_ENTRY_TYPE } from "./events.ts";
import type { PlanbuildStore } from "./state.ts";
import { resolvePlanFilePath } from "./utils.ts";
import { BUILD_MODE_PROMPT, PLAN_MODE_PROMPT } from "./prompt.ts";

export const EXTENSION_TOOLS = ["plan_file", "plan_mode_complete", "build_status"] as const;

const BLOCKED_TOOLS = new Set(["edit", "write"]);

export const PLAN_BADGE = "[plan]";
export const BUILD_BADGE = "[build]";
const STATUS_COLORS = { build: "\x1b[38;5;69m", plan: "\x1b[38;5;208m", reset: "\x1b[39m" } as const;

/** 是否应在 plan 沙箱档把执行 shell 切到 powershell（路线 X）。纯函数（可单测）。 */
export interface PowershellSandboxDecision {
  platform: string;
  shellTool: SandboxShellTool;
  available: boolean;
  safetyMode: SafetyMode;
}
export function shouldUsePowershellSandbox(d: PowershellSandboxDecision): boolean {
  return (
    d.platform === "win32" &&
    d.shellTool === "powershell" &&
    d.available &&
    (d.safetyMode === "readonly" || d.safetyMode === "verify")
  );
}

export interface ModeActions {
  enterPlanMode(ctx: ExtensionContext, persist?: boolean): void;
  enterBuildMode(ctx: ExtensionContext, persist?: boolean): void;
  ensureBuildTools(): void;
  updateStatus(ctx: ExtensionContext): void;
}

export function registerModes(
  pi: ExtensionAPI,
  store: PlanbuildStore,
  options?: { extraTools?: string[] },
): ModeActions {
  // 能力相关工具可加进来（如 question 的 ask_user_question）；缺席则不加（工具名不悬空）
  const allTools = () => unique([...EXTENSION_TOOLS, ...(options?.extraTools ?? [])]);

  function unique(names: string[]): string[] {
    return [...new Set(names)];
  }

  function updateStatus(ctx: ExtensionContext): void {
    const badge = store.state.mode === "plan" ? PLAN_BADGE : BUILD_BADGE;
    const color = store.state.mode === "plan" ? STATUS_COLORS.plan : STATUS_COLORS.build;
    ctx.ui.setStatus("pi-plan-mode", `${color}${badge}${STATUS_COLORS.reset}`);
  }

  function enterBuildMode(ctx: ExtensionContext, persist = true): void {
    store.state.mode = "build";
    const restored = unique([
      ...(store.runtime.toolsBeforePlanMode ?? pi.getActiveTools()),
      ...allTools(),
    ]);
    pi.setActiveTools(restored);
    store.runtime.toolsBeforePlanMode = undefined;
    if (persist) store.setMode("build");
    updateStatus(ctx);
  }

  function enterPlanMode(ctx: ExtensionContext, persist = true): void {
    store.state.mode = "plan";
    if (isSandboxedProfile(store.state.safetyMode) && !store.runtime.sandbox.available) {
      store.state.safetyMode = "supervised";
      if (persist) store.setSafety("supervised");
    }
    if (store.runtime.toolsBeforePlanMode === undefined) {
      store.runtime.toolsBeforePlanMode = pi.getActiveTools();
    }
    const next = unique([
      ...store.runtime.toolsBeforePlanMode.filter((t) => !BLOCKED_TOOLS.has(t)),
      ...allTools(),
    ]);
    if (
      shouldUsePowershellSandbox({
        platform: process.platform,
        shellTool: store.runtime.sandbox.shellTool,
        available: store.runtime.sandbox.available,
        safetyMode: store.state.safetyMode,
      })
    ) {
      pi.setActiveTools(unique([...next.filter((t) => t !== "bash"), "powershell"]));
    } else {
      pi.setActiveTools(next);
    }
    if (persist) store.setMode("plan");
    updateStatus(ctx);
  }

  function ensureBuildTools(): void {
    const current = pi.getActiveTools();
    pi.setActiveTools(unique([...current, "edit", "write"]));
  }

  /* -------------------- 提示注入（system prompt 追加） + 模式切换 notice -------------------- */

  pi.on("before_agent_start", (event, ctx) => {
    const planFile = resolvePlanFilePath(undefined, ctx.cwd, store.state.planFilePath);
    const content =
      store.state.mode === "plan"
        ? PLAN_MODE_PROMPT.replace("{planFile}", planFile)
        : BUILD_MODE_PROMPT.replace("{planFile}", planFile);
    const result: {
      systemPrompt: string;
      message?: { customType: string; content: string; display: boolean };
    } = { systemPrompt: event.systemPrompt + "\n\n" + content };

    const last = store.runtime.notifiedMode;
    if (last !== undefined && last !== store.state.mode) {
      result.message = {
        customType: `${PB_ENTRY_TYPE}:mode-notice`,
        content:
          store.state.mode === "plan"
            ? "用户已将模式切换到计划模式（只读规划）。"
            : "用户已将模式切换到构建模式（完整权限）。",
        display: true,
      };
    }
    store.runtime.notifiedMode = store.state.mode;
    return result;
  });

  return { enterPlanMode, enterBuildMode, ensureBuildTools, updateStatus };
}

// 兼容导出（gate.ts 兜底 edit/write 拦截时复用）
export { isToolCallEventType };
