/**
 * pi-planbuild v4 · 层 1 后端：bwrap（Linux 命名空间）OS 只读沙箱。
 *
 * 档位 = 挂载策略参数化：
 * - readonly：工作区只读 + /tmp tmpfs + home 只读（敏感目录隐藏）+ podman.sock 掩码
 * - verify：  工作区可写（.git/.pi 只读子路径防提权）+ 其余同 readonly——验证式规划
 * - supervised / strict：不注入（交互层接管）
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { Mode, SafetyMode, SandboxConfig } from "pi-plan-bridge";
import {
  classifyPodmanWrite,
  SENSITIVE_HOME_DIRS,
  SENSITIVE_HOME_FILES,
  expandHomePath,
  filterSafeExtraMounts,
  isPathWithin,
  normalizeMountPath,
} from "pi-plan-bridge";
import { HOME_ALLOW_REMOUNTS, WORKSPACE_RO_SUBPATHS } from "./config.ts";

/** 检测 bwrap 是否可用（本机；WSL2 userns 实测正常） */
export function detectBwrap(): boolean {
  try {
    const r = spawnSync("bwrap", ["--version"], { timeout: 3000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

let bwrapDetect: () => boolean = detectBwrap;
export function overrideBwrapDetect(fn: () => boolean): void {
  bwrapDetect = fn;
}

/** 读取可覆盖检测器（后端 probe 用；尊重 overrideBwrapDetect，默认即 detectBwrap） */
export function probeBwrap(): boolean {
  return bwrapDetect();
}

/** 安全地把原始命令嵌入 `sh -c '<cmd>'`（POSIX 单引号包裹，内部单引号转义） */
export function safeQuote(command: string): string {
  return `'${command.replace(/'/g, `'\\''`)}'`;
}

/** bwrap 包装选项 */
export interface BwrapOptions {
  unshareNet?: boolean;
  chdir?: string;
  profile: "readonly" | "verify";
  mountHome?: boolean;
  extras?: string[];
  maskSocketPath?: string;
  allowRemounts?: string[];
  /** 测试/多 home 场景覆盖宿主 home；生产默认 homedir()。 */
  home?: string;
}

function isAllowedHomeRemount(input: string, home: string): boolean {
  const candidate = normalizeMountPath(input, home);
  return HOME_ALLOW_REMOUNTS.some((path) => isPathWithin(join(home, path), candidate));
}

/** 动态收集 settings.skills 配置的 skill 路径（凡在隐藏目录内需恢复可见；启动时探测一次） */
export function detectSettingsSkills(cwd: string): string[] {
  const result: string[] = [];
  const settingsFiles = [
    join(homedir(), ".pi", "agent", "settings.json"),
    join(cwd, ".pi", "settings.json"),
  ];
  for (const f of settingsFiles) {
    if (!existsSync(f)) continue;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(f, "utf8"));
    } catch {
      continue;
    }
    const skills = (data as { skills?: unknown })?.skills;
    if (!Array.isArray(skills)) continue;
    const base = dirname(f);
    for (const s of skills) {
      const raw = typeof s === "string" ? s : (s as { path?: unknown })?.path;
      if (typeof raw !== "string" || !raw.trim()) continue;
      const expanded = expandHomePath(raw);
      const abs = isAbsolute(expanded) ? normalize(expanded) : resolve(base, expanded);
      if (existsSync(abs)) result.push(abs);
    }
  }
  return result;
}

/** 空文件掩码源（宿主 /tmp 固定路径；bwrap ro-bind 源在宿主解析，目标在沙箱） */
let maskSourcePath: string | undefined;
export function getMaskSource(): string {
  if (!maskSourcePath) maskSourcePath = join(tmpdir(), "pi-planbuild-mask-empty");
  if (!existsSync(maskSourcePath)) writeFileSync(maskSourcePath, "");
  return maskSourcePath;
}

/** 组装 home 隐藏/恢复挂载（基于 / 只读基座；mountHome=false 时整个 home 隐藏） */
export function buildHomeMounts(home = homedir(), extraAllow: string[] = []): string[] {
  if (!home || home === "/" || home === "") return [];
  const parts: string[] = [];
  for (const d of SENSITIVE_HOME_DIRS) {
    const p = join(home, d);
    if (existsSync(p)) parts.push("--tmpfs", p);
  }

  const allow = [
    ...HOME_ALLOW_REMOUNTS.map((r) => join(home, r)),
    ...extraAllow.filter((p) => isAllowedHomeRemount(p, home)).map((p) => normalizeMountPath(p, home)),
  ];
  const covered = (p: string) =>
    SENSITIVE_HOME_DIRS.some((d) => {
      const dp = join(home, d);
      return p === dp || p.startsWith(dp + "/");
    });
  for (const p of allow) {
    if (p !== home && covered(p) && existsSync(p)) parts.push("--ro-bind", p, p);
  }

  for (const f of SENSITIVE_HOME_FILES) {
    const p = join(home, f);
    if (existsSync(p)) parts.push("--ro-bind", getMaskSource(), p);
  }
  return parts;
}

/** 构建 bwrap 包装命令（plan 沙箱档的 spawnHook 使用） */
export function buildBwrapCommand(command: string, root: string, options: BwrapOptions): string {
  const chdir = options?.chdir ?? root;
  const home = options?.home ?? homedir();
  const parts = ["bwrap", "--die-with-parent"];
  parts.push("--ro-bind", "/", "/");
  if (options?.mountHome === false) {
    if (home && home !== "/") parts.push("--tmpfs", home);
  } else {
    parts.push(...buildHomeMounts(home, options?.allowRemounts));
  }
  parts.push("--tmpfs", "/tmp");
  if (options.profile === "verify") {
    parts.push("--bind", root, root);
    for (const sub of WORKSPACE_RO_SUBPATHS) {
      const p = join(root, sub);
      if (existsSync(p)) parts.push("--ro-bind", p, p);
    }
  } else {
    parts.push("--ro-bind", root, root);
  }
  if (options?.maskSocketPath) parts.push("--ro-bind", getMaskSource(), options.maskSocketPath);
  for (const p of filterSafeExtraMounts(options?.extras ?? [], home)) {
    parts.push("--ro-bind", p, p);
  }
  parts.push(options?.unshareNet ? "--unshare-net" : "--share-net");
  parts.push("--chdir", chdir);
  parts.push("--dev", "/dev", "--proc", "/proc");
  parts.push("--", "sh", "-c", safeQuote(command));
  return parts.join(" ");
}

/** 对齐 pi normalizePath 中对 shellPath 生效的子集（win32 驱动器样式 + ~ 展开） */
export function normalizeShellPath(input: string, platform: string = process.platform): string {
  let normalized = input;
  if (
    platform === "win32" &&
    !normalized.includes("\\") &&
    normalized.startsWith("/") &&
    !normalized.startsWith("//")
  ) {
    const m = normalized.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (m) {
      const suffix = m[2]?.replaceAll("/", "\\");
      normalized = `${m[1].toUpperCase()}:\\${suffix ?? ""}`;
    }
  }
  const home = homedir();
  if (normalized === "~") return home;
  if (normalized.startsWith("~/") || (platform === "win32" && normalized.startsWith("~\\"))) {
    return join(home, normalized.slice(2));
  }
  return normalized;
}

/** 读取 settings.json 的 shellPath（global + project 合并，project 覆盖；归一语义对齐 pi） */
export function detectShellPath(cwd: string): string | undefined {
  const settingsFiles = [
    join(homedir(), ".pi", "agent", "settings.json"),
    join(cwd, ".pi", "settings.json"),
  ];
  let value: string | undefined;
  for (const f of settingsFiles) {
    if (!existsSync(f)) continue;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(f, "utf8"));
    } catch {
      continue;
    }
    const raw = (data as { shellPath?: unknown })?.shellPath;
    if (typeof raw === "string" && raw) value = raw;
  }
  return value === undefined ? undefined : normalizeShellPath(value);
}

/** 探测宿主 podman unix socket 真实路径（realpath 解开符号链接；PODMAN_HOST/CONTAINER_HOST 优先） */
export function detectPodmanSocket(candidates?: readonly string[]): string | undefined {
  const list = candidates ?? podmanSocketCandidates();
  for (const p of list) {
    if (existsSync(p)) {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    }
  }
  return undefined;
}

function podmanSocketCandidates(): string[] {
  // podman rootless 默认：$XDG_RUNTIME_DIR/podman/podman.sock（systemd 或 pasta 转发时）；
  // docker-compat socket（podman machine / 远程连接）在 /run/user/<uid>/docker.sock。
  const host = process.env.PODMAN_HOST ?? process.env.CONTAINER_HOST;
  if (host?.startsWith("unix://")) return [host.slice("unix://".length)];
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
  return [`${runtimeDir}/podman/podman.sock`, `${runtimeDir}/docker.sock`, `/run/user/${uid}/podman/podman.sock`];
}

/** spawnHook 决策输入（便于纯函数测试） */
export interface SandboxDecisionState {
  mode: Mode;
  safetyMode: SafetyMode;
  bwrapAvailable: boolean;
  sandbox: SandboxConfig;
  socketPath?: string;
  allowRemounts?: string[];
}

/** 判定 plan 模式下是否属于 OS 沙箱档（readonly/verify） */
export function isSandboxedProfile(safetyMode: SafetyMode): safetyMode is "readonly" | "verify" {
  return safetyMode === "readonly" || safetyMode === "verify";
}

/** podman.sock 可见性决策（纯函数）：默认掩码，仅 podman 只读子命令放行 */
export function socketMaskFor(
  enabled: boolean,
  socketPath: string | undefined,
  command: string,
): string | undefined {
  if (!socketPath) return undefined;
  const isPodman = /^podman\b/.test(command.trim());
  if (isPodman && enabled && !classifyPodmanWrite(command)) return undefined;
  return socketPath;
}

/** bwrap spawnHook 决策（纯函数）：plan + readonly/verify + bwrap 可用 → 注入；否则原样 */
export function sandboxDecision(
  s: SandboxDecisionState,
  command: string,
  cwd: string,
  root: string,
): { command: string; cwd: string } {
  if (s.mode === "plan" && isSandboxedProfile(s.safetyMode) && s.bwrapAvailable) {
    return {
      command: buildBwrapCommand(command, root, {
        profile: s.safetyMode,
        chdir: cwd,
        mountHome: s.sandbox.mountHome,
        maskSocketPath: socketMaskFor(s.sandbox.podmanSocket, s.socketPath, command),
        extras: s.sandbox.extras ?? [],
        allowRemounts: s.allowRemounts ?? [],
      }),
      cwd,
    };
  }
  return { command, cwd };
}
