/**
 * pi-planbuild v4 · docker 控制面分类：判定 docker 命令是否为写面（写/未知=拦截，只读=放行）。
 */
import {
  DOCKER_READONLY_COMPOSED,
  DOCKER_READONLY_SUBCOMMANDS,
  DOCKER_VALUE_FLAGS,
} from "./config.ts";

/**
 * 解析 docker 顶层子命令（跳过全局带值 flag 与 `docker <unknown>` 段）。
 * @returns 顶层子命令 token（首 token / 两段式首段；无则 ""）
 */
function dockerTopSubcommand(tokens: string[]): string {
  let i = 0;
  // 跳过全局带值 flag 及其值
  while (i < tokens.length && DOCKER_VALUE_FLAGS.has(tokens[i])) i += 2;
  return tokens[i] ?? "";
}

/**
 * 判定 docker 命令是否写面。
 * - 顶层子命令 ∈ 只读白名单 → false（放行）
 * - 白名单外任何子命令（含未知）→ true（fail-closed 拦截）
 * 两段式（如 `docker compose ps`）取第二段判定。
 */
export function classifyDockerWrite(command: string): boolean {
  const trimmed = command.trim();
  const m = trimmed.match(/^docker\s+(.+)$/);
  if (!m) return true; // 非 docker 前缀的"docker 控制面"命令不在此处理；交给上层
  const tokens = m[1].split(/\s+/);
  const top = dockerTopSubcommand(tokens);
  if (!top) return true; // 无子命令（如 `docker`）→ fail-closed
  // 两段式：`docker <top> <sub>`
  const composed = DOCKER_READONLY_COMPOSED[top];
  if (composed) {
    const sub = tokens[tokens.indexOf(top) + 1] ?? "";
    return !composed.has(sub);
  }
  if (DOCKER_READONLY_SUBCOMMANDS.has(top)) return false;
  return true; // 未知 → fail-closed
}
