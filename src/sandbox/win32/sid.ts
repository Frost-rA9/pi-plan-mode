/**
 * pi-planbuild v4（路线 X）· winacl：capability SID 派生（写 SID / temp SID / 读拒绝 SID）。
 * 来源：dsh `workspace-sid.ts`（写/temp）+ 本方案新增 `readDenySid`（读数隐藏 capability SID）。
 *
 * 每个 SID 采用 `S-1-4-x-y`（sha256，subauthority 30bit）。SID 的"权力"仅由命名它的 ACE 定义；
 * SID 字符串本身并非机密。capability 而非用户 SID → 免提权，用户自身访问不受影响。
 */

import { createHash } from "node:crypto";

function twoSubauthority(source: Buffer): [number, number] {
  const first = (source.readUInt32LE(0) % (2 ** 30 - 1)) + 1;
  const second = (source.readUInt32LE(4) % (2 ** 30 - 1)) + 1;
  return [first, second];
}

/**
 * 由规范化工作区路径派生其写 SID（`S-1-4-x-y`）。
 * 输入必须是规范化路径（realpathSync.native）。两个拼写收敛到一个 SID；
 * 重命名工作区会派生新 SID（旧 standing ACE 成为惰性残渣）。
 */
export function workspaceWriteSid(canonicalPath: string): string {
  const digest = createHash("sha256").update(canonicalPath, "utf8").digest();
  const [first, second] = twoSubauthority(digest);
  return `S-1-4-${first}-${second}`;
}

/**
 * 由私有 temp 目录路径派生其写 SID（`S-1-4-x-y-1`）。
 * 固定第三 subauthority 域分离，避免与两段式工作区 SID 冲突。
 */
export function tempWriteSid(tempDir: string): string {
  const digest = createHash("sha256").update("temp\0", "utf8").update(tempDir, "utf8").digest();
  const [first, second] = twoSubauthority(digest);
  return `S-1-4-${first}-${second}-1`;
}

/**
 * 读拒绝（凭据隐藏）capability SID（本方案新增，对齐 Codex 的 deny_read 语义）。
 * 恒定 `S-1-4-2-...` 派生：一个固定的、独立于路径的 SID，配合 token.ts 把它作为
 * 受限令牌的组加入 → 敏感路径上的 denyRead ACE 仅对携带该 SID 的受限进程生效，
 * 宿主（普通令牌不含该 SID）读取不受影响。
 */
export function readDenySid(): string {
  const digest = createHash("sha256").update("pi-planbuild\0readDeny\0", "utf8").digest();
  const [first, second] = twoSubauthority(digest);
  return `S-1-4-${first}-${second}-2`;
}
