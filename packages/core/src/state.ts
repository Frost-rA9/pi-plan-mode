/**
 * pi-plan-mode · C1 存储：dispatch = 改缓存 + 落日志（单点），杜绝内存/日志双源。
 * 折叠源 = sessionManager.getBranch()（活动分支）——避免把被放弃分支条目混入。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSafetyMode } from "pi-plan-bridge";
import {
  PB_ENTRY_TYPE,
  applyEvent,
  emptyRuntime,
  emptyState,
  foldBranch,
  type PbEvent,
  type PbRuntime,
  type PbState,
  type SafetyMode,
  type SandboxConfig,
} from "./events.ts";

/** 本地状态覆盖（启动 flag 用；只改缓存不落日志——flag 只作用本次启动） */
export interface LocalOverrides {
  planFilePath?: string;
  safetyMode?: SafetyMode;
  sandboxExtras?: string[];
}

export class PlanbuildStore {
  readonly state: PbState;
  readonly runtime: PbRuntime;
  private readonly pi: ExtensionAPI;

  private constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.state = emptyState();
    this.runtime = emptyRuntime();
  }

  static create(pi: ExtensionAPI): PlanbuildStore {
    return new PlanbuildStore(pi);
  }

  /** 折叠恢复：把活动分支条目折成状态（启动时一次） */
  restore(entries: Array<{ type: string; customType?: string; data?: unknown }>): void {
    const folded = storeFromBranch(entries);
    this.state.mode = folded.mode;
    this.state.safetyMode = folded.safetyMode;
    this.state.planFilePath = folded.planFilePath;
    this.state.sandbox = folded.sandbox;
    this.state.approveMemory = folded.approveMemory;
  }

  /** 启动 flag 覆盖（仅改缓存，不落日志） */
  overrideLocal(overrides: LocalOverrides): void {
    if (overrides.planFilePath !== undefined) this.state.planFilePath = overrides.planFilePath;
    if (overrides.safetyMode !== undefined && isSafetyMode(overrides.safetyMode))
      this.state.safetyMode = overrides.safetyMode;
    if (overrides.sandboxExtras !== undefined)
      this.state.sandbox = { ...this.state.sandbox, extras: overrides.sandboxExtras };
  }

  /** 单点：改缓存 + 落日志（扩展自定义事件，不进 LLM 上下文） */
  private dispatch(event: PbEvent): void {
    applyEvent(this.state, event);
    this.pi.appendEntry(PB_ENTRY_TYPE, event);
  }

  setMode(mode: "plan" | "build"): void {
    this.dispatch({ kind: "mode", value: mode });
  }
  setSafety(mode: SafetyMode): void {
    this.dispatch({ kind: "safety", value: mode });
  }
  setPlanPath(path: string): void {
    this.dispatch({ kind: "plan-path", value: path });
  }
  setSandbox(config: SandboxConfig): void {
    this.dispatch({ kind: "sandbox", value: config });
  }
  grantCommand(command: string): void {
    this.dispatch({ kind: "grant", command });
  }
}

function storeFromBranch(
  entries: Array<{ type: string; customType?: string; data?: unknown }>,
): PbState {
  return foldBranch(entries);
}
