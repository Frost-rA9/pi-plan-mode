/**
 * pi-planbuild v4（路线 X）—— pi 原生为骨、四家语义为肉的 plan/build 双模式扩展。
 *
 * 架构（调研见 RESEARCH-security-models.md）：
 * - C1 状态即日志：appendEntry 事件 + getBranch() 纯折叠（state.ts/events.ts），无内存真源
 * - 层 0 工具可得性（modes.ts）：plan 移除 edit/write；win32+winacl 沙箱档移除 bash/加入 powershell
 * - 层 1 OS 边界（sandbox.ts）：可插拔后端（selectBackend + shellTool）；bwrap（Linux） / winacl（Windows+pwsh）
 * - 层 2 交互层（gate.ts）：supervised confirm（grant 事件化）/ strict 拒绝
 * - C3 计划文件即真源（tools/plan-file）：无内存镜像
 * - S1 批准三分支（tools/plan_mode_complete）：批准并执行 / 继续规划 / dismissed
 */
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PlanbuildStore } from "./src/state.ts";
import { isSafetyMode, requiresSandbox, type SafetyMode } from "./src/events.ts";
import { registerModes } from "./src/modes.ts";
import { registerSandbox } from "./src/sandbox.ts";
import { registerGate } from "./src/gate.ts";
import { registerCommands } from "./src/commands.ts";
import { registerTools } from "./src/tools/index.ts";

export default function planbuildExtension(pi: ExtensionAPI): void {
  const store = PlanbuildStore.create(pi);

  const modes = registerModes(pi, store);
  registerTools(pi, store, modes);
  registerSandbox(pi, store);
  registerGate(pi, store);
  registerCommands(pi, store, modes);

  // 会话恢复：折叠活动分支 + 启动 flag 覆盖 + 档位降级
  pi.on("session_start", async (_event, ctx) => {
    store.restore(ctx.sessionManager.getBranch() as Array<{ type: string; customType?: string; data?: unknown }>);

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

    // 沙箱后端不可用时降级档位
    if (requiresSandbox(store.state.safetyMode) && !store.runtime.sandbox.available) {
      store.setSafety("supervised");
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
