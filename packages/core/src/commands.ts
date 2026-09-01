/**
 * pi-planbuild v4 · 命令：/plan /build /plan-safety /plan-sandbox + 启动 flag（plan/plan-safety/plan-file/plan-mount）。
 */
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isSafetyMode, requiresSandbox, type SafetyMode, type CapabilityId } from "pi-plan-bridge";
import type { PlanbuildStore } from "./state.ts";
import type { ModeActions } from "./modes.ts";
import { parseEnabled, type LoadedCapabilities } from "./capabilities.ts";

const SAFETY_HELP =
  "档位含义：\n" +
  "  readonly    OS 只读沙箱 + 零确认（bwrap / winacl+pwsh）\n" +
  "  verify      工作区可写沙箱（.git/.pi 只读子路径）+ 零确认——验证式规划\n" +
  "  supervised  无沙箱 + 只读集合放行 + 未知 confirm\n" +
  "  strict      无沙箱 + 只读集合放行 + 未知拒绝";

export function registerCommands(
  pi: ExtensionAPI,
  store: PlanbuildStore,
  modes: ModeActions,
  cap: LoadedCapabilities,
): void {
  async function enterPlan(ctx: ExtensionContext): Promise<void> {
    if (store.state.mode === "plan") {
      ctx.ui.notify("当前已在计划模式", "info");
      return;
    }
    // 进入前复核沙箱后端：不可用时自动降级
    if (requiresSandbox(store.state.safetyMode) && !store.runtime.sandbox.available) {
      store.setSafety("supervised");
      ctx.ui.notify(
        "未检测到可用的 OS 沙箱后端，安全档位自动降级为 supervised（未知命令需确认）。/plan-safety 可手动调整",
        "info",
      );
    }
    modes.enterPlanMode(ctx);
    const sandboxed = isSandboxed(store.state.safetyMode) && store.runtime.sandbox.available;
    const partial = sandboxed && store.runtime.sandbox.kind === "winacl";
    ctx.ui.notify(
      `计划模式已开启（安全档位: ${store.state.safetyMode}）。${sandboxed
        ? store.state.safetyMode === "verify"
          ? `bash 运行于 OS 沙箱（${store.runtime.sandbox.kind}）${partial ? "，enforcement=partial，弱于 bwrap" : ""}`
          : `bash 运行于 OS 只读沙箱（${store.runtime.sandbox.kind}）${partial ? "，enforcement=partial，弱于 bwrap" : ""}`
        : "写操作将拦截并引导切 build"}`,
      "info",
    );
  }

  async function enterBuild(ctx: ExtensionContext): Promise<void> {
    if (store.state.mode === "build") {
      ctx.ui.notify("当前已在构建模式", "info");
      return;
    }
    modes.enterBuildMode(ctx);
    ctx.ui.notify("构建模式已开启（完整工具权限）", "info");
  }

  pi.registerCommand("plan", {
    description: "切换到计划模式（只读规划；OS 沙箱后端可用时强制边界）",
    handler: async (_args, ctx) => enterPlan(ctx),
  });

  pi.registerCommand("build", {
    description: "切换到构建模式（完整工具权限）；纯切换，不注入计划内容",
    handler: async (_args, ctx) => enterBuild(ctx),
  });

  pi.registerCommand("plan-safety", {
    description: "显示/设置安全档位（readonly / verify / supervised / strict）",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify(
          `当前安全档位: ${store.state.safetyMode}（OS 沙箱可用: ${store.runtime.sandbox.available ? "是" : "否"}）` +
            `${store.runtime.sandboxError ? `\n沙箱原因: ${store.runtime.sandboxError}` : ""}\n${SAFETY_HELP}`,
          "info",
        );
        return;
      }
      const value = args.trim() as SafetyMode;
      if (!isSafetyMode(value)) {
        ctx.ui.notify(`无效值: ${args.trim()}。可选值: readonly / verify / supervised / strict`, "error");
        return;
      }
      if (requiresSandbox(value)) {
        // 实时重探（不信任启动时的一次缓存）：bwrap 可用性随机器状态变化，切换即复查
        const backend = cap.sandbox?.selectBackend();
        const available = backend ? backend.probe() : false;
        store.runtime.sandbox = backend
          ? { kind: backend.info.kind, available, shellTool: backend.info.shellTool }
          : { ...store.runtime.sandbox, available: false };
        store.runtime.sandboxError = available
          ? undefined
          : backend
            ? "沙箱后端探测失败（bwrap --version 未通过；请确认 bubblewrap 已安装且在 PATH）"
            : cap.errors.sandbox ?? "沙箱能力未加载（plan-capabilities 未启用或加载失败）";
        if (!available) {
          ctx.ui.notify(`无法切换到该档位：${store.runtime.sandboxError}`, "error");
          return;
        }
      }
      store.setSafety(value);
      ctx.ui.notify(`安全档位已设置为: ${store.state.safetyMode}`, "info");
    },
  });

  pi.registerCommand("plan-sandbox", {
    description: "查看/配置沙箱挂载（home 只读 / docker.sock / 附加路径）",
    handler: async (args, ctx) => {
      const usage = "用法: /plan-sandbox [mount-home on|off | docker on|off | add <path> | remove <path>]";
      const arg = args?.trim() ?? "";
      if (!arg) {
        ctx.ui.notify(
          `沙箱挂载配置（OS 沙箱档位 readonly/verify 生效）：\n` +
            `- home 只读（含敏感目录隐藏）: ${store.state.sandbox.mountHome ? "开" : "关"}\n` +
            `- docker.sock: ${store.state.sandbox.dockerSocket ? "开" : "关"}（只读子命令放行，写子命令拦截）\n` +
            `- 附加只读挂载: ${store.state.sandbox.extras.length > 0 ? store.state.sandbox.extras.join(", ") : "（无）"}`,
          "info",
        );
        return;
      }
      const [cmd, ...rest] = arg.split(/\s+/);
      const val = rest.join(" ");
      const s = { ...store.state.sandbox };
      if (cmd === "add" && val) {
        s.extras = [...s.extras, val];
      } else if (cmd === "remove" && val) {
        s.extras = s.extras.filter((p) => p !== val);
      } else if ((cmd === "mount-home" || cmd === "docker") && val === "on") {
        if (cmd === "mount-home") s.mountHome = true;
        else s.dockerSocket = true;
      } else if ((cmd === "mount-home" || cmd === "docker") && val === "off") {
        if (cmd === "mount-home") s.mountHome = false;
        else s.dockerSocket = false;
      } else {
        ctx.ui.notify(usage, "error");
        return;
      }
      store.setSandbox(s);
      ctx.ui.notify("沙箱挂载配置已更新", "info");
    },
  });

  pi.registerCommand("plan-capabilities", {
    description: "查看启用的能力（sandbox/preview/question）；经启动 flag 启用，改后 /reload 生效",
    handler: async (_args, ctx) => {
      const enabled = parseEnabled(pi.getFlag("plan-capabilities"));
      const loaded = (["sandbox", "preview", "question"] as CapabilityId[])
        .filter((id) => cap[id])
        .join(", ");
      const failed = (Object.entries(cap.errors) as Array<[CapabilityId, string]>)
        .map(([id, reason]) => `${id}: ${reason}`)
        .join("\n");
      ctx.ui.notify(
        `已启用能力：${[...enabled].join(", ") || "（无）"}\n` +
          `已加载：${loaded || "（无）"}` +
          `${failed ? `\n加载失败：\n${failed}` : ""}\n` +
          `用法：启动时 /plan-capabilities（或 --plan-capabilities）= all | none | sandbox,preview,...` +
          `；替换实现用 --plan-capabilities-<id>=包名。改后 /reload 生效`,
        "info",
      );
    },
  });

  /* ------------------------------ flag ------------------------------ */
  pi.registerFlag("plan", {
    description: "以计划模式启动（只读规划）",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("plan-capabilities", {
    description: "启用的能力（all | none | sandbox,preview,question；默认 all）",
    type: "string",
  });
  pi.registerFlag("plan-capabilities-sandbox", {
    description: "替换 sandbox 实现包名（默认 pi-plan-sandbox）",
    type: "string",
  });
  pi.registerFlag("plan-capabilities-preview", {
    description: "替换 preview 实现包名（默认 pi-plan-preview）",
    type: "string",
  });
  pi.registerFlag("plan-capabilities-question", {
    description: "替换 question 实现包名（默认 pi-plan-question）",
    type: "string",
  });
  pi.registerFlag("plan-safety", {
    description:
      "安全档位（readonly / verify / supervised / strict，默认 readonly；无 OS 沙箱后端自动降级 supervised）",
    type: "string",
  });
  pi.registerFlag("plan-file", {
    description: "自定义计划文件路径（默认 .pi/plans/PLAN.md）",
    type: "string",
  });
  pi.registerFlag("plan-mount", {
    description: "沙箱附加只读挂载路径（逗号分隔，如 ~/data,/mnt/d）",
    type: "string",
  });

  /* ------------------------ 快切按键（与 /plan /build 同逻辑） ------------------------ */
  pi.registerShortcut("ctrl+alt+p", {
    description: "切换到计划模式（只读规划）",
    handler: enterPlan,
  });
  pi.registerShortcut("ctrl+alt+b", {
    description: "切换到构建模式（完整工具权限）",
    handler: enterBuild,
  });
}

function isSandboxed(mode: SafetyMode): boolean {
  return mode === "readonly" || mode === "verify";
}
