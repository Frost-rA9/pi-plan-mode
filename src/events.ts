/**
 * pi-planbuild v4 · 状态即日志（C1）：事件定义 + 纯折叠 + 单点应用。
 *
 * pi 机制：会话是 append-only JSONL 日志，appendEntry 持久化扩展事件（不进 LLM 上下文），
 * session_start 时折叠 getBranch() 恢复——无内存真源、无整块快照。
 * dsh 语义：whole-value replace（逐键 last-wins）+ 累积型事件（grant）+ 纯函数 fold。
 *
 * 折叠源必须是 ctx.sessionManager.getBranch()（active branch 路径）而非 getEntries()：
 * 后者返回文件全量条目（含 /tree 回溯前的被放弃分支条目），会混入非活动分支的状态事件。
 */

/** 模式 */
export type Mode = "plan" | "build";

/** 安全档位 = OS 沙箱边界策略 × 交互策略的捆绑预设（C2）
 * - readonly（默认）：OS 只读沙箱 + 零确认
 * - verify：工作区可写沙箱（.git/.pi 只读子路径）+ 零确认——验证式规划
 * - supervised：无沙箱 + 只读集合/confirm
 * - strict：无沙箱 + 只读集合/拒绝
 */
export type SafetyMode = "readonly" | "verify" | "supervised" | "strict";

export const DEFAULT_SAFETY_MODE: SafetyMode = "readonly";

export function isSafetyMode(v: unknown): v is SafetyMode {
  return v === "readonly" || v === "verify" || v === "supervised" || v === "strict";
}

/** 需要 OS 沙箱后端的档位（后端不可用时降级 supervised；fail-closed） */
export function requiresSandbox(mode: SafetyMode): boolean {
  return mode === "readonly" || mode === "verify";
}

/** 沙箱后端种类：bwrap（Linux 命名空间）或 winacl（Windows 受限令牌 + NTFS ACE）。 */
export type SandboxBackendKind = "bwrap" | "winacl";

/** 后端沙箱 shell（决定 registerSandbox 覆盖哪个 shell 工具；winacl 用 pwsh 绕开 git bash 冲突） */
export type SandboxShellTool = "bash" | "powershell";

/** 运行时缓存的后端信息（探测结果，非持久化） */
export interface SandboxBackendInfo {
  kind: SandboxBackendKind;
  available: boolean;
  shellTool: SandboxShellTool;
}

/** 沙箱配置（whole-value replace 事件携带完整配置） */
export interface SandboxConfig {
  mountHome: boolean;
  dockerSocket: boolean;
  extras: string[];
}

/** pi-planbuild 自定义条目类型（appendEntry customType） */
export const PB_ENTRY_TYPE = "pi-planbuild";

/** 状态事件（data.kind 判别联合） */
export type PbEvent =
  | { kind: "mode"; value: Mode }
  | { kind: "safety"; value: SafetyMode }
  | { kind: "plan-path"; value: string }
  | { kind: "sandbox"; value: SandboxConfig }
  | { kind: "grant"; command: string }
  /** v3 兼容：旧整块 blob 条目作为快照事件展开（planContent 废弃，文件即真源） */
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
    // 默认：home 只读挂载开（敏感目录隐藏）、docker.sock 可见（gate 拦写面）
    sandbox: { mountHome: true, dockerSocket: true, extras: [] },
    approveMemory: new Map(),
  };
}

/** 运行时字段（不持久化）：沙箱后端探测缓存、plan 前工具集快照、confirm 频率计数、notice 防抖 */
export interface PbRuntime {
  sandbox: SandboxBackendInfo;
  toolsBeforePlanMode: string[] | undefined;
  confirmCount: number;
  /** 上次注入模式切换 notice 时的模式（会话内存防抖，不落日志）；undefined = 未注入过 */
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

/** 单点应用：把一个事件应用到状态（mutate）。fold 与 dispatch 共用此函数——内存与日志永不分离。 */
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
      state.sandbox = event.value;
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
        dockerSocket: event.sandboxDockerSocket ?? state.sandbox.dockerSocket,
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
 * 未知条目静默忽略（前向兼容：新事件被旧扩展读取时不误判）。
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
    // v3 blob：含 mode/safetyMode 等顶层字段、无 kind
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
        sandboxExtras: Array.isArray(data.sandboxExtras)
          ? (data.sandboxExtras as string[])
          : undefined,
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
