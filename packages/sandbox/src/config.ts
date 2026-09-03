/**
 * pi-plan-sandbox · 安全配置：home 允许清单 + win32 映射（敏感清单/路径判定已上移 pi-plan-bridge 单源）。
 *
 * 仅保留 sandbox 私有的策略：allowlist（remounts / workspace 只读子路径）+ win32 映射。
 */

import { SENSITIVE_HOME_DIRS, SENSITIVE_HOME_FILES } from "pi-plan-bridge";

/** 敏感目录覆盖后仍需可见的子路径（bwrap 后挂载恢复；winacl 细粒度 deny） */
export const HOME_ALLOW_REMOUNTS = [".pi/agent/skills", ".pi/agent/bin", ".config/gh"] as const;

/** verify 档写面保护：工作区可写，但以下相对路径保持只读（防 hook/配置提权）。 */
export const WORKSPACE_RO_SUBPATHS = [".git", ".pi"] as const;

/**
 * 把 `SENSITIVE_HOME_DIRS` / `SENSITIVE_HOME_FILES` / `HOME_ALLOW_REMOUNTS` 映射为 win32 绝对路径
 * （winacl deny-read 目标；win32 上用 `~` → %USERPROFILE%）。
 * @param homeBase %USERPROFILE%（win32）
 */
export function win32SensitivePaths(homeBase: string): string[] {
  return [
    ...SENSITIVE_HOME_DIRS.map((d) => `${homeBase}\\${d}`),
    ...SENSITIVE_HOME_FILES.map((f) => `${homeBase}\\${f}`),
  ];
}

/** winacl 需要保留可见的子路径（对应 HOME_ALLOW_REMOUNTS） */
export function win32AllowRemountPaths(homeBase: string): string[] {
  return HOME_ALLOW_REMOUNTS.map((r) => `${homeBase}\\${r.replaceAll("/", "\\")}`);
}
