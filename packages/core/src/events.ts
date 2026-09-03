/**
 * pi-plan-mode · 状态即日志（C1）：事件定义 + 纯折叠 + 单点应用。
 *
 * 类型（Mode/SafetyMode/SandboxBackendInfo/SandboxConfig 等）从 pi-plan-bridge 引（单源）。
 * pi 机制：会话 append-only JSONL 日志，appendEntry 持久化扩展事件（不进 LLM 上下文），
 * session_start 时折叠 getBranch() 恢复——无内存真源、无整块快照。
 * dsh 语义：whole-value replace（逐键 last-wins）+ 累积型事件（grant）+ 纯函数 fold。
 *
 * 折叠源必须是 ctx.sessionManager.getBranch()（active branch 路径）而非 getEntries()：
 * 后者返回文件全量条目（含 /tree 回溯前的被放弃分支条目），会混入非活动分支的状态事件。
 */
import {
  type Mode,
  type SafetyMode,
  type SandboxBackendInfo,
  type SandboxBackendKind,
  type SandboxShellTool,
  type SandboxConfig,
  DEFAULT_SAFETY_MODE,
  isSafetyMode,
} from "pi-plan-bridge";

export type { Mode, SafetyMode, SandboxBackendInfo, SandboxBackendKind, SandboxShellTool, SandboxConfig };

/** 需要 OS 沙箱后端的档位（后端不可用时降级 supervised；fail-closed） */
export function requiresSandbox(mode: SafetyMode): boolean {
  return mode === "readonly" || mode === "verify";
}

/** pi-plan-mode 自定义条目类型 */
export const PB_ENTRY_TYPE = "pi-plan-mode";

/** 状态事件（data.kind 判别联合） */
export type PbEvent =
  | { kind: "mode"; value: Mode }
  | { kind: "safety"; value: SafetyMode }
  | { kind: "plan-path"; value: string }
  | { kind: "sandbox"; value: SandboxConfig }
  | { kind: "grant"; command: string }
  /** v3 兼容：旧整块 blob 条目作为快照事件展开 */
  | {
      kind: "snapshot";
      mode?: Mode;
      safetyMode?: SafetyMode;
      planFile?: string;
      sandboxMountHome?: boolean;
      sandboxDockerSocket?: boolean;
      sandboxExtras?: string[];
    };

/** 折叠结果（可持久化状态；confirmCount 等会话内存语义不在此列） */
export interface PbState {
  mode: Mode;
  safetyMode: SafetyMode;
  /** 计划文件路径；空串 = 用默认 .pi/plans/PLAN.md */
  planFilePath: string;
  sandbox: SandboxConfig;
  /** supervised 档「允许此类」记忆（累积事件 grant） */
  approveMemory: Map<string, boolean>;
}

export function emptyState(): PbState {
  return {
    mode: "build",
    safetyMode: DEFAULT_SAFETY_MODE,
    planFilePath: "",
    // 默认：home 只读挂载开（敏感目录隐藏）、podman.sock 可见（gate 拦写面）、Pi reuse 关闭
    sandbox: { mountHome: true, podmanSocket: true, extras: [] },
    approveMemory: new Map(),
  };
}

/** 运行时字段（不持久化）：沙箱后端探测缓存、plan 前工具集快照、confirm 频率计数、notice 防抖 */
export interface PbRuntime {
  sandbox: SandboxBackendInfo;
  /** 最近一次沙箱能力加载/探测失败的原因（诊断可见化；不持久化） */
  sandboxError?: string;
  toolsBeforePlanMode: string[] | undefined;
  confirmCount: number;
  notifiedMode: Mode | undefined;
}

export function emptyRuntime(): PbRuntime {
  return {
    sandbox: { kind: "bwrap", available: false, shellTool: "bash" },
    toolsBeforePlanMode: undefined,
    confirmCount: 0,
    notifiedMode: undefined,
  };
}

/** 单点应用：把一个事件应用到状态（mutate）。fold 与 dispatch 共用——内存与日志永不分离。 */
export function applyEvent(state: PbState, event: PbEvent): void {
  switch (event.kind) {
    case "mode":
      state.mode = event.value;
      break;
    case "safety":
      state.safetyMode = event.value;
      break;
    case "plan-path":
      state.planFilePath = event.value;
      break;
    case "sandbox":
      // 兼容：早于 podmanSocket 字段的持久化 sandbox 事件（旧键 dockerSocket）映射到 podmanSocket。
      {
        const value = event.value as SandboxConfig & { dockerSocket?: boolean };
        state.sandbox = {
          ...state.sandbox,
          mountHome: value.mountHome ?? state.sandbox.mountHome,
          podmanSocket: value.podmanSocket ?? value.dockerSocket ?? state.sandbox.podmanSocket,
          extras: value.extras ?? state.sandbox.extras,
        };
      }
      break;
    case "grant":
      state.approveMemory.set(event.command, true);
      break;
    case "snapshot":
      if (event.mode) state.mode = event.mode;
      if (event.safetyMode) state.safetyMode = event.safetyMode;
      if (event.planFile) state.planFilePath = event.planFile;
      state.sandbox = {
        mountHome: event.sandboxMountHome ?? state.sandbox.mountHome,
        podmanSocket: event.sandboxDockerSocket ?? state.sandbox.podmanSocket,
        extras: event.sandboxExtras ?? state.sandbox.extras,
      };
      break;
  }
}

/** 折叠纯函数：逐键 last-wins，grant 累积。输入须来自 getBranch()（活动分支路径）。 */
export function foldEvents(events: PbEvent[]): PbState {
  const state = emptyState();
  for (const event of events) applyEvent(state, event);
  return state;
}

/** pi 会话条目最小视图（兼容 CustomEntry） */
export interface SessionEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}

/**
 * 从 pi 会话条目流提取本扩展事件：
 * - v4 事件：customType === PB_ENTRY_TYPE 且 data.kind 可识别
 * - v3 兼容：旧整块 blob（无 kind 但含 v2/v3 字段）映射为 snapshot 事件
 */
export function parsePbEvents(entries: SessionEntryLike[]): PbEvent[] {
  const events: PbEvent[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== PB_ENTRY_TYPE) continue;
    const data = entry.data as Record<string, unknown> | undefined;
    if (!data || typeof data !== "object") continue;
    if (typeof data.kind === "string" && isPbEventKind(data.kind)) {
      events.push(data as unknown as PbEvent);
      continue;
    }
    if ("mode" in data || "safetyMode" in data || "planFile" in data) {
      events.push({
        kind: "snapshot",
        mode: data.mode === "plan" ? "plan" : "build",
        safetyMode: isSafetyMode(data.safetyMode) ? data.safetyMode : undefined,
        planFile: typeof data.planFile === "string" ? data.planFile : undefined,
        sandboxMountHome:
          typeof data.sandboxMountHome === "boolean" ? data.sandboxMountHome : undefined,
        sandboxDockerSocket:
          typeof data.sandboxDockerSocket === "boolean" ? data.sandboxDockerSocket : undefined,
        sandboxExtras: Array.isArray(data.sandboxExtras) ? (data.sandboxExtras as string[]) : undefined,
      });
    }
  }
  return events;
}

function isPbEventKind(kind: string): kind is PbEvent["kind"] {
  return (
    kind === "mode" ||
    kind === "safety" ||
    kind === "plan-path" ||
    kind === "sandbox" ||
    kind === "grant" ||
    kind === "snapshot"
  );
}

/** 便捷：从活动分支条目直接折叠出状态 */
export function foldBranch(entries: SessionEntryLike[]): PbState {
  return foldEvents(parsePbEvents(entries));
}
