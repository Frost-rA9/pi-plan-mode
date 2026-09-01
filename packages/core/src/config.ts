/**
 * pi-plan-mode · 交互层配置：只读集合 / 写面模式 / confirm 上限。
 * （安全清单已下沉 pi-plan-sandbox；docker 常量已上移 pi-plan-bridge。）
 */

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
