/**
 * pi-plan-bridge · 多扩展共享契约（纯 TS，无 pi 运行时副作用）。
 *
 * 为 pi-plan-{mode,sandbox,preview,question} 提供：
 * - 类型：Mode/SafetyMode/SandboxBackendKind/SandboxShellTool/SandboxBackendInfo/SandboxConfig/PlanReviewChoice/PlanSummary
 * - 能力接口：SafetyProvider / PlanPreviewRenderer / QuestionAsker（依赖倒置——库实现它，mode 经它调用）
 * - 共享纯函数/常量：classifyPodmanWrite + podman 常量、formatPlanSummary、requiresSandbox/isSandboxedProfile/isSafetyMode/DEFAULT_SAFETY_MODE
 *
 * 架构（路线 A）：单一宿主（pi-plan-mode 扩展）import 全部能力库（sandbox/preview/question），
 * 无需事件总线 RPC——能力都是可注入库，mode 直接调用。可插拔 = 换库包（npm 依赖）。
 *
 * 关键约束：BashSpawnHook 是同步的，沙箱 spawnHook 需同步读 mode 档位 → 沙箱不能做成扩展，
 * 只能作为被 mode import 的库（mode 注入 readState 闭包）。preview/question 同理作为库，统一插拔方式。
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import type { BashToolOptions, ExtensionContext } from "@earendil-works/pi-coding-agent";

/* ------------------------------ 能力注册（按需启用 + 可替换） ------------------------------ */

/** 能力 id：三个可选能力。 */
export type CapabilityId = "sandbox" | "preview" | "question";

export const CAPABILITY_IDS: readonly CapabilityId[] = ["sandbox", "preview", "question"];

/* ------------------------------ 类型（从 src/events.ts、src/plan-review.ts 抽） ------------------------------ */

export type Mode = "plan" | "build";

/** 安全档位 = OS 沙箱边界策略 × 交互策略的捆绑预设 */
export type SafetyMode = "readonly" | "verify" | "supervised" | "strict";

/** 需要 OS 沙箱后端的档位 */
export type SandboxProfile = "readonly" | "verify";

export function requiresSandbox(mode: SafetyMode): mode is SandboxProfile {
  return mode === "readonly" || mode === "verify";
}

/** 是否属于 OS 沙箱档（readonly/verify）。 */
export function isSandboxedProfile(mode: SafetyMode): mode is SandboxProfile {
  return mode === "readonly" || mode === "verify";
}

export const DEFAULT_SAFETY_MODE: SafetyMode = "readonly";

export function isSafetyMode(v: unknown): v is SafetyMode {
  return v === "readonly" || v === "verify" || v === "supervised" || v === "strict";
}

export type SandboxBackendKind = "bwrap" | "winacl";
export type SandboxShellTool = "bash" | "powershell";

export interface SandboxBackendInfo {
  kind: SandboxBackendKind;
  available: boolean;
  shellTool: SandboxShellTool;
}

/** 沙箱配置（whole-value replace 事件携带完整配置） */
export interface SandboxConfig {
  mountHome: boolean;
  /** 允许 Plan shell 访问 container 控制面（podman socket；readonly/verify 档仅读子命令放行）。 */
  podmanSocket: boolean;
  extras: string[];
}

/** plan_mode_complete 三分支结果：approve=批准并执行 / continue=继续规划 / undefined=dismissed */
export type PlanReviewChoice = "approve" | "continue" | undefined;

/** 计划摘要（preview 库生成；mode 展示，不进 LLM 上下文） */
export interface PlanSummary {
  /** 首个 markdown 标题（无则 undefined） */
  title?: string;
  /** 要点/清单项前 N 条 */
  bullets: string[];
  /** 步骤/任务数（estimate） */
  steps: number;
  /** 计划总行数 */
  lines: number;
}

/** 把 PlanSummary 格式化为 markdown（渲染到消息区的计划预览，标题/要点/统计）。 */
export function formatPlanSummary(s: PlanSummary): string {
  const head = s.title ? `## 目标：${s.title}` : "## 计划";
  const parts = [head, ...s.bullets.map((b) => `- ${b}`), `*${s.steps} 步 / ${s.lines} 行*`];
  return parts.filter(Boolean).join("\n");
}

/* ------------------------------ 能力接口（依赖倒置；库实现，mode 经它调用） ------------------------------ */

/** mode 传给 sandbox 的上下文（sandbox 无状态、无 ctx；只需这些参数产 executor） */
export interface SafetyContext {
  cwd: string;
  profile: SandboxProfile;
  sandbox: SandboxConfig;
}

/** OS 沙箱能力（pi-plan-sandbox 实现；由 mode import，注入 readState 后 buildToolOptions） */
export interface SafetyProvider {
  probe(): Promise<SandboxBackendInfo>;
  shellTool(): SandboxShellTool;
  buildToolOptions(ctx: SafetyContext): Promise<BashToolOptions>;
  dispose?(): Promise<void>;
}

/** 计划摘要能力（pi-plan-preview 实现；启发式，无 ctx、无 UI） */
export interface PlanPreviewRenderer {
  summarize(plan: string): Promise<PlanSummary> | PlanSummary;
}

/** 一个结构化澄清问题（schema 形状） */
export interface QuestionSpec {
  question: string;
  options: string[];
  recommended?: string;
}

/** 单个问题的回答 */
export interface QuestionAnswer {
  kind: "choice" | "custom" | "cancel";
  value: string;
}

/** 结构化澄清能力（pi-plan-question 实现；由 mode 注册 ask_user_question 工具） */
export interface QuestionAsker {
  ask(ctx: ExtensionContext, questions: QuestionSpec[]): Promise<QuestionAnswer[]>;
}

/* ------------------------------ podman 控制面（sandbox 与 mode 共用；纯函数/常量） ------------------------------ */

/** podman 顶层只读子命令（白名单外一律拦截：fail-closed） */
export const PODMAN_READONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "ps", "info", "version", "images", "logs", "inspect", "stats", "top", "port", "events",
  "history", "diff", "ls", "search", "manifest",
]);

/** podman 复合子命令（两段式）的只读第二段 */
export const PODMAN_READONLY_COMPOSED: Record<string, ReadonlySet<string>> = {
  compose: new Set(["ps", "config", "ls", "top", "events", "logs", "images", "version"]),
  network: new Set(["ls", "inspect", "exists"]),
  volume: new Set(["ls", "inspect", "exists"]),
  system: new Set(["df", "info", "events"]),
  image: new Set(["ls", "inspect", "exists", "history", "tree"]),
  container: new Set(["ls", "inspect", "exists", "stats", "top", "port", "diff", "logs", "ps"]),
  pod: new Set(["exists", "inspect", "ps", "stats", "top"]),
  machine: new Set(["inspect", "list"]),
};

/** podman 全局带值 flag（跳过其值 token，避免把 flag 值误当子命令） */
export const PODMAN_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--connection", "-c", "--url", "--identity", "--log-level", "--root", "--runroot",
  "--storage-driver", "--cgroup-manager", "--events-backend", "--runtime",
]);

function podmanTopSubcommand(tokens: string[]): string {
  let i = 0;
  while (i < tokens.length && PODMAN_VALUE_FLAGS.has(tokens[i])) i += 2;
  return tokens[i] ?? "";
}

/**
 * 判定 podman 命令是否写面：顶层子命令 ∈ 只读白名单 → false；否则（含未知）→ true（fail-closed）。
 * 两段式（如 `podman compose ps`）取第二段判定。
 */
export function classifyPodmanWrite(command: string): boolean {
  const trimmed = command.trim();
  const m = trimmed.match(/^podman\s+(.+)$/);
  if (!m) return true;
  const tokens = m[1].split(/\s+/);
  const top = podmanTopSubcommand(tokens);
  if (!top) return true;
  const composed = PODMAN_READONLY_COMPOSED[top];
  if (composed) {
    const sub = tokens[tokens.indexOf(top) + 1] ?? "";
    if (!composed.has(sub)) return true;
    // 复合只读子命令不接受额外参数（如 `podman volume ls --json` 除外——留白名单内所有 flag）。
    return false;
  }
  if (PODMAN_READONLY_SUBCOMMANDS.has(top)) return false;
  return true;
}

/* ------------------------------ home 敏感清单 + 挂载路径判定（沙箱与应用层共用） ------------------------------ */

/** home 内需隐藏的敏感目录（凭据/密钥；bwrap tmpfs 覆盖为空；winacl deny-read）。 */
export const SENSITIVE_HOME_DIRS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".netrc",
  ".config", // 含 pi-agent 配置（sudo 密码 env）、gh token 等
  ".pi", // 含 auth.json 等凭据（skills/bin 由 HOME_ALLOW_REMOUNTS 恢复）
  ".copilot",
] as const;

/** home 根级敏感文件（bwrap 空文件掩码 / winacl deny-read；宿主存在才生效） */
export const SENSITIVE_HOME_FILES = [".gitconfig", ".bash_history", ".netrc", ".npmrc"] as const;

/** 展开 `~`/`~/` 前缀（其余原样返回）。 */
export function expandHomePath(p: string, home = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/** 规范化挂载路径，并解析已有路径的符号链接别名。 */
export function normalizeMountPath(input: string, home = homedir()): string {
  const expanded = expandHomePath(input.trim(), home);
  const absolute = isAbsolute(expanded) ? normalize(expanded) : resolve(expanded);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** 路径关系判定：candidate 是否位于 parent 内（含自身；符号链接已解。sandbox 的 allowlist 复用）。 */
export function isPathWithin(parent: string, candidate: string): boolean {
  const rel = relative(normalize(parent), normalize(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * 通用 extras 是否安全：不能覆盖敏感目录/文件，也不能挂载其祖先目录绕过 mask。
 * `.pi/agent/skills` 等内置 allowlist 不经过此入口恢复。
 */
export function isSafeExtraMount(input: string, home = homedir()): boolean {
  if (!input.trim()) return false;
  const candidate = normalizeMountPath(input, home);
  for (const dir of SENSITIVE_HOME_DIRS) {
    const sensitive = join(home, dir);
    if (isPathWithin(sensitive, candidate) || isPathWithin(candidate, sensitive)) return false;
  }
  for (const file of SENSITIVE_HOME_FILES) {
    const sensitive = join(home, file);
    if (isPathWithin(sensitive, candidate) || isPathWithin(candidate, sensitive)) return false;
  }
  return true;
}

/** 规范化并过滤通用 extras；最终组装层仍需再次调用，形成 fail-closed 防线。 */
export function filterSafeExtraMounts(inputs: string[], home = homedir()): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const input of inputs) {
    if (!isSafeExtraMount(input, home)) continue;
    const normalized = normalizeMountPath(input, home);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
