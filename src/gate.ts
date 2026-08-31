/**
 * pi-planbuild v4 · 层 2：交互层门控（按档位路由）。
 *
 * - readonly / verify（OS 沙箱档）：OS 沙箱接管（bwrap / winacl+pwsh），本层不判定 shell 命令；
 *   例外：docker 控制面（socket 绕过文件系统只读）——只读子命令放行、写/未知拦截（fail-closed）
 * - supervised：只读集合自动放行 → 写面拒绝 → 未知命令 confirm（允许一次 / 允许此类 / 拒绝）；
 *   「允许此类」走 store.grantCommand 落日志（S2 事件化，会话恢复后记忆仍在）
 * - strict：只读集合放行 + 未知拒绝
 * - 层 0 兜底：edit/write 任何档位都拦截（与工具移除双保险）
 */
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PlanbuildStore } from "./state.ts";
import { CONFIRM_LIMIT } from "./config.ts";
import { classifyBash } from "./classify.ts";
import { classifyDockerWrite } from "./docker-gate.ts";
import { isSandboxedProfile } from "./sandbox.ts";

interface ToolCallEvent {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: { command?: string };
}

export function registerGate(pi: ExtensionAPI, store: PlanbuildStore): void {
  pi.on("tool_call", async (event, _ctx) => {
    if ((event as ToolCallEvent).type !== "tool_call") return;
    const e = event as ToolCallEvent;
    const { toolName, input } = e;
    const command = input?.command ?? "";

    // 层 0 兜底（仅 plan 模式）：写工具拦截（与工具移除双保险）；build 模式放行（完整权限）
    if (store.state.mode === "plan" && (toolName === "edit" || toolName === "write")) {
      return { block: true, reason: "Plan 模式禁写工具（层 0 兜底）：请用 plan_file / 切换 build" };
    }
    if (toolName !== "bash" && toolName !== "powershell") return; // 非 shell 工具放行

    const sandboxedTier = isSandboxedProfile(store.state.safetyMode) && store.runtime.sandbox.available;

    // docker 控制面（非 win32 bash；win32 沙箱档由 pwsh 沙箱接管，docker 走 winacl 控制面）
    if (toolName === "bash" && /^docker\b/.test(command.trim()) && classifyDockerWrite(command)) {
      return { block: true, reason: "docker 写面：切 /build 执行；docker 控制面 fail-closed" };
    }

    // OS 沙箱档位：OS 沙箱接管命令执行
    if (sandboxedTier) {
      if (toolName === "powershell") return; // win32 pwsh 沙箱（winacl）接管
      if (process.platform === "win32")
        return { block: true, reason: "win32 沙箱档仅 pwsh 可沙箱化：请用 powershell 工具" };
      return; // linux bash → bwrap 沙箱接管
    }

    // 无 OS 沙箱档位（supervised / strict，或沙箱不可用降级后）：
    const cls = classifyBash(command);
    if (cls === "read") return; // 只读集合 → 放行
    if (cls === "write") {
      return { block: true, reason: "检测到写操作：请切换 /build 执行" };
    }
    if (store.state.safetyMode === "strict") {
      return { block: true, reason: "strict 档拒绝未知命令" };
    }
    // supervised：confirm（允许一次 / 允许此类 / 拒绝）——「允许此类」落 grant 事件（S2）
    if (store.runtime.confirmCount >= CONFIRM_LIMIT) {
      return { block: true, reason: "计划模式：确认次数已超上限。建议 /build 切换构建模式" };
    }
    store.runtime.confirmCount++;
    const choice = await _ctx.ui.select("计划模式：允许执行？", ["允许一次", "允许此类（本会话记住）", "拒绝"]);
    if (!choice || choice === "拒绝") return { block: true, reason: "用户拒绝" };
    if (choice === "允许此类（本会话记住）") {
      store.grantCommand(command);
      return; // 放行 + 落 grant 事件
    }
    return; // 允许一次 → 放行（不记忆）
  });
}
