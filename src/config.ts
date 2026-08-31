/**
 * pi-planbuild v4 · 集中配置：安全清单 / 只读集合 / 写面模式 / docker 白名单 / 频率上限 / 档位预设。
 * 调整安全边界只改本文件，不翻逻辑代码（gate/classify/docker-gate/sandbox 引用此处）。
 */

/* ------------------------------ 交互层（gate）配置 ------------------------------ */

/** 会话内 confirm 频率上限（防确认疲劳；会话内存语义，不持久化） */
export const CONFIRM_LIMIT = 5;

/** 核心只读命令（supervised/strict 档自动放行）。只覆盖最常见的研究命令；不覆盖则 unknown。 */
export const READONLY_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "cat", "head", "tail", "less", "more", "type", "file", "stat",
  "ls", "dir", "pwd", "tree", "du", "df", "find",
  "grep", "rg", "fd",
  "cut", "wc", "sort", "uniq", "diff", "printf", "echo",
  "uname", "whoami", "id", "date", "cal", "uptime", "ps", "free",
  "which", "whereis", "printenv", "env", "hostname", "ss", "getent",
  "jq",
]);

/** git 只读子命令（前缀匹配） */
export const GIT_READ_ONLY =
  /^(?:status|log|diff|show|branch|remote|config\s+--get|rev-parse|ls-files|ls-tree|ls-remote|cat-file|rev-list|shortlog|describe|blame|reflog|show-ref|symbolic-ref|for-each-ref|merge-base|name-rev|grep)\b/;

/** 命令级写面命令（命令位置检测：行首或 ; && || 之后） */
export const WRITE_COMMAND_PATTERNS: RegExp[] = [
  /(?:^|[;&|])\s*(?:rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|tee|truncate|dd|shred|scp|rsync|mount|umount|mkfs|fdisk)\b/i,
  /(?:^|[;&|])\s*(?:sudo|su|kill|pkill|killall|reboot|shutdown|systemctl\s+(?:start|stop|restart|enable|disable))\b/i,
  /(?:^|[;&|])\s*(?:vim|vi|nano|emacs|code|subl|notepad)\b/i,
  /(?:^|[;&|])\s*(?:npm|yarn|pnpm|pip|pipx)\s+(?:install|uninstall|update|ci|link|publish|init|add|remove|upgrade)\b/i,
  /(?:^|[;&|])\s*apt(-get)?\s+(?:install|remove|purge|update|upgrade)\b/i,
  /(?:^|[;&|])\s*git\s+(?:add|commit|push|pull|merge(?!-)|rebase|reset|checkout|switch|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone|restore|clean)\b/i,
];

/** [命令名, 写面参数正则]——命中即 write（防止 confirm 放行隐藏写面） */
export const WRITE_ARG_PATTERNS: Array<[RegExp, RegExp]> = [
  [/^curl\b/, /(?:^|\s)-(?:o|O|C)(?:\s|$)|--output|--remote-name|--create-dirs|--continue-at/],
  [/^wget\b/, /-O\s+/],
  [/^find\b/, /-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)\b/],
  [/^sed\b/, /(?:^|\s)-i\b|--in-place|system\s*\(|(?:^|[;'"/|])\s*w\s+\S/],
  [/^sort\b/, /(?:^|\s)-o(?:\s|=|$)|--output/],
  [/^date\b/, /(?:^|\s)-s\b|--set/],
  [/^(?:python|python3|node|perl|ruby)$/, /(?:^|\s)-(?:c|e)\b/],
  [/^awk\b/, /system\s*\(|\|\s*getline|\|&/],
];

/* ------------------------------ docker 控制面配置 ------------------------------ */

/** docker 顶层只读子命令（白名单外一律拦截：fail-closed） */
export const DOCKER_READONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "ps", "info", "version", "images", "logs", "inspect", "stats", "top", "port", "events",
  "history", "diff", "ls", "df", "scan", "sbom",
]);

/** docker 复合子命令（两段式）的只读第二段 */
export const DOCKER_READONLY_COMPOSED: Record<string, ReadonlySet<string>> = {
  compose: new Set(["ps", "config", "ls", "top", "events", "logs", "images", "version"]),
  network: new Set(["ls", "inspect"]),
  volume: new Set(["ls", "inspect"]),
  system: new Set(["df", "info", "events", "inspect"]),
  builder: new Set(["ls", "inspect"]),
  buildx: new Set(["ls", "inspect"]),
  container: new Set(["ls", "inspect", "stats", "top", "port", "diff", "logs"]),
  image: new Set(["ls", "inspect", "history"]),
  secret: new Set(["ls", "inspect"]),
  config: new Set(["ls", "inspect"]),
  plugin: new Set(["ls", "inspect"]),
  context: new Set(["ls", "inspect", "show"]),
  node: new Set(["ls", "inspect"]),
  service: new Set(["ls", "inspect", "logs", "ps"]),
  stack: new Set(["ls", "ps", "config"]),
  manifest: new Set(["inspect"]),
  trust: new Set(["inspect", "signer"]),
};

/** docker 全局带值 flag（跳过其值 token，避免把 flag 值误当子命令） */
export const DOCKER_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--context", "-c", "--host", "-H", "--config", "--log-level",
  "--tlscacert", "--tlscert", "--tlskey",
]);

/* ------------------------------ 沙箱（层 1）配置 ------------------------------ */

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

/* ------------------------------ win32（winacl）映射 ------------------------------ */

/**
 * 把 `SENSITIVE_HOME_DIRS` / `SENSITIVE_HOME_FILES` / `HOME_ALLOW_REMOUNTS` 映射为 win32 绝对路径
 * （winacl deny-read 目标；win32 上用 `~` → %USERPROFILE%）。win32 路径用反斜杠。
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
