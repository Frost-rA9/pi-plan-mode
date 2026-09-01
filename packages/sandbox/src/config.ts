/**
 * pi-plan-sandbox · 安全配置：凭据/敏感路径清单 + win32 映射。
 *
 * 从原 `src/config.ts` 的「沙箱（层 1）配置」+「win32 映射」抽出下沉本包。
 * gate 侧（只读集合/写模式）留 mode 包，不在此。
 */

/** home 内需隐藏的敏感目录（凭据/密钥；bwrap tmpfs 覆盖为空；winacl deny-read）。 */
export const SENSITIVE_HOME_DIRS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".netrc",
  ".config", // 含 pi-agent 配置（sudo 密码 env）、gh token 等
  ".pi", // 含 auth.json 等凭据（skills/bin 由 HOME_ALLOW_REMOUNTS 恢复）
  ".copilot",
] as const;

/** home 根级敏感文件（bwrap 空文件掩码 / winacl deny-read；宿主存在才生效） */
export const SENSITIVE_HOME_FILES = [".gitconfig", ".bash_history", ".netrc", ".npmrc"] as const;

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
