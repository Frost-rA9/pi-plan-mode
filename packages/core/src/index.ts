/**
 * pi-plan-mode · 扩展入口（async factory）：装配 C1 状态 / 层0 工具面 / 层1 沙箱（经能力注册）/ 层2 门控 + session_init。
 *
 * 能力注册（route A 增强）：loadCapabilities 惰性加载 sandbox/preview/question（按需启用 + 可替换），
 * 任一缺席 → 相应降级（无 OS 沙箱 → gate 降级；无 preview → 截断预览；无 question → 不注册 ask_user_question 工具）。
 */
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSafetyMode, requiresSandbox, type SafetyMode } from "pi-plan-bridge";
import { PlanbuildStore } from "./state.ts";
import { registerModes } from "./modes.ts";
import { registerSandbox } from "./sandbox.ts";
import { registerGate } from "./gate.ts";
import { registerCommands } from "./commands.ts";
import { registerTools } from "./tools.ts";
import { registerPlanPreviewRenderer } from "./preview.ts";
import { loadCapabilities } from "./capabilities.ts";

export default async function planModeExtension(pi: ExtensionAPI): Promise<void> {
  const store = PlanbuildStore.create(pi);

  // 能力注册：按需启用 + 惰性加载（/plan-capabilities 或 flag 门控）
  const flags: Record<string, unknown> = {
    "plan-capabilities": pi.getFlag("plan-capabilities"),
    "plan-capabilities-sandbox": pi.getFlag("plan-capabilities-sandbox"),
    "plan-capabilities-preview": pi.getFlag("plan-capabilities-preview"),
    "plan-capabilities-question": pi.getFlag("plan-capabilities-question"),
  };
  const cap = await loadCapabilities(flags);

  const modes = registerModes(pi, store, {
    extraTools: cap.question ? ["ask_user_question"] : [],
  });
  registerTools(pi, store, modes, cap.preview);
  registerPlanPreviewRenderer(pi);
  registerSandbox(pi, store, cap.sandbox, cap.errors.sandbox);
  registerGate(pi, store);
  registerCommands(pi, store, modes, cap);
  if (cap.question) cap.question.registerQuestionTool(pi);

  // 会话恢复：折叠活动分支 + 启动 flag 覆盖 + 档位降级
  pi.on("session_start", async (_event, ctx) => {
    store.restore(
      ctx.sessionManager.getBranch() as Array<{ type: string; customType?: string; data?: unknown }>,
    );

    // 启动 flag（仅改缓存不落日志）
    const flagFile = pi.getFlag("plan-file");
    if (typeof flagFile === "string" && flagFile.trim()) {
      store.overrideLocal({ planFilePath: isAbsolute(flagFile) ? flagFile : resolve(ctx.cwd, flagFile) });
    }
    const flagSafety = pi.getFlag("plan-safety");
    if (typeof flagSafety === "string" && isSafetyMode(flagSafety.trim())) {
      store.overrideLocal({ safetyMode: flagSafety.trim() as SafetyMode });
    }
    const flagMount = pi.getFlag("plan-mount");
    if (typeof flagMount === "string" && flagMount.trim()) {
      store.overrideLocal({ sandboxExtras: flagMount.split(",").map((x) => x.trim()).filter(Boolean) });
    }

    // 沙箱后端不可用时**运行时**降级（只改缓存不落日志——档位 = 用户显式设置的真源，
    // 沙箱可用性为运行时事实；落日志会把 supervised 粘进恢复折叠，默认 readonly 被覆盖）
    if (requiresSandbox(store.state.safetyMode) && !store.runtime.sandbox.available) {
      store.state.safetyMode = "supervised";
    }

    if (store.state.mode === "plan") {
      modes.enterPlanMode(ctx, false);
      ctx.ui.notify(
        "已恢复计划模式（只读）。新任务优先，旧计划文件仅作参考；/build 或 Ctrl+Alt+B 可退出",
        "info",
      );
    } else if (pi.getFlag("plan") === true) {
      store.setMode("plan");
      modes.enterPlanMode(ctx, false);
    } else {
      modes.updateStatus(ctx);
    }
  });
}
