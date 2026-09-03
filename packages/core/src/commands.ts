/**
 * pi-planbuild v4 · 命令：/plan /build /plan-safety /plan-sandbox + 启动 flag（plan/plan-safety/plan-file/plan-mount）。
 * piReuse 已移除（ModLens 改用独立 provider，Plan shell 不再暴露 pi 凭据）；
 * podman 控制面 fail-closed 保留。
 */
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  isSafetyMode,
  requiresSandbox,
  safetyModeAvailability,
  SAFETY_MODE_CATALOG,
  safetyModeInfo,
  type SafetyMode,
  type CapabilityId,
} from "pi-plan-bridge";
import type { PlanbuildStore } from "./state.ts";
import type { ModeActions } from "./modes.ts";
import { parseEnabled, type LoadedCapabilities } from "./capabilities.ts";
import { isSafeExtraMount, normalizeMountPath } from "pi-plan-bridge";

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
      // 实时重探（不信任启动时的一次缓存）：bwrap 可用性随机器状态变化，切换即复查。
      const probeBackend = (): { available: boolean; reason?: string } => {
        const backend = cap.sandbox?.selectBackend();
        if (!backend) {
          const reason = cap.errors.sandbox ?? "沙箱能力未加载（plan-capabilities 未启用或加载失败）";
          store.runtime.sandbox = { ...store.runtime.sandbox, available: false };
          store.runtime.sandboxError = reason;
          return { available: false, reason };
        }
        const available = backend.probe();
        store.runtime.sandbox = { kind: backend.info.kind, available, shellTool: backend.info.shellTool };
        store.runtime.sandboxError = available
          ? undefined
          : "沙箱后端探测失败（bwrap --version 未通过；请确认 bubblewrap 已安装且在 PATH）";
        return { available, reason: store.runtime.sandboxError };
      };

      if (!args?.trim()) {
        // 档位目录展示：四档 + 各自可用性（借鉴 codex permission profile catalog 语义）。
        const { available, reason: backendReason } = probeBackend();
        const lines: string[] = [];
        for (const entry of SAFETY_MODE_CATALOG) {
          const av = safetyModeAvailability(entry.mode, available, backendReason);
          const marker = entry.mode === store.state.safetyMode ? "▶ " : "  ";
          const state = av.allowed ? "可用" : `不可用（${av.reason}）`;
          lines.push(`${marker}${entry.mode.padEnd(10)} ${state} — ${entry.description}`);
        }
        ctx.ui.notify(
          `当前安全档位: ${store.state.safetyMode}\n${lines.join("\n")}\n用法: /plan-safety <档位>`,
          "info",
        );
        return;
      }
      const value = args.trim() as SafetyMode;
      if (!isSafetyMode(value)) {
        ctx.ui.notify(`无效值: ${args.trim()}。可选值: ${SAFETY_MODE_CATALOG.map((e) => e.mode).join(" / ")}`, "error");
        return;
      }
      const backendState = probeBackend();
      const av = safetyModeAvailability(value, backendState.available, backendState.reason);
      if (!av.allowed) {
        ctx.ui.notify(`无法切换到 ${value}: ${av.reason}`, "error");
        return;
      }
      store.setSafety(value);
      const info = safetyModeInfo(value);
      ctx.ui.notify(`安全档位已设置为: ${store.state.safetyMode}${info ? `（${info.description}）` : ""}`, "info");
    },
  });

  pi.registerCommand("plan-sandbox", {
    description: "查看/配置沙箱挂载（home 只读 / podman.sock / Pi reuse / 附加路径）",
    handler: async (args, ctx) => {
      const usage =
        "用法: /plan-sandbox [mount-home on|off | podman on|off | add <path> | remove <path>]";
      const arg = args?.trim() ?? "";
      if (!arg) {
        ctx.ui.notify(
          `沙箱挂载配置（OS 沙箱档位 readonly/verify 生效）：\n` +
            `- home 只读（含敏感目录隐藏）: ${store.state.sandbox.mountHome ? "开" : "关"}\n` +
            `- podman.sock: ${store.state.sandbox.podmanSocket ? "开" : "关"}（只读子命令放行，写子命令拦截）\n` +
            `- 附加只读挂载: ${store.state.sandbox.extras.length > 0 ? store.state.sandbox.extras.join(", ") : "（无）"}`,
          "info",
        );
        return;
      }
      const [cmd, ...rest] = arg.split(/\s+/);
      const val = rest.join(" ");
      const s = { ...store.state.sandbox };
      if (cmd === "add" && val) {
        const normalized = normalizeMountPath(val);
        if (!isSafeExtraMount(normalized)) {
          ctx.ui.notify("拒绝：附加挂载不能覆盖敏感 home 目录/文件或其祖先（包括 ~/.pi）。", "error");
          return;
        }
        s.extras = [...new Set([...s.extras, normalized])];
      } else if (cmd === "remove" && val) {
        const normalized = normalizeMountPath(val);
        s.extras = s.extras.filter((p) => normalizeMountPath(p) !== normalized);
      } else if ((cmd === "mount-home" || cmd === "podman") && val === "on") {
        if (cmd === "mount-home") s.mountHome = true;
        else s.podmanSocket = true;
      } else if ((cmd === "mount-home" || cmd === "podman") && val === "off") {
        if (cmd === "mount-home") s.mountHome = false;
        else s.podmanSocket = false;
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
