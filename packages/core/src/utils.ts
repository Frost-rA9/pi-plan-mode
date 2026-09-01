/**
 * pi-planbuild v4 · 工具函数：计划文件路径（C3：文件即真源）+ 计划文件读写。
 */
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";

/** 计划文件的默认存放目录：<cwd>/.pi/plans */
export function plansDir(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "plans");
}

/** 默认计划文件路径 */
export function defaultPlanFile(cwd: string): string {
  return join(plansDir(cwd), "PLAN.md");
}

/** 解析计划文件路径：显式传入 > 已配置 > 默认（相对路径基于 cwd） */
export function resolvePlanFilePath(input: string | undefined, cwd: string, configured: string): string {
  if (input?.trim()) {
    const p = input.trim();
    return isAbsolute(p) ? normalize(p) : resolve(cwd, p);
  }
  if (configured) return configured;
  return defaultPlanFile(cwd);
}

/** 计划写入边界：仅 .pi/plans 目录内，或 /plan-file 显式配置的文件 */
export function isAllowedPlanPath(target: string, cwd: string, configured: string): boolean {
  const dir = plansDir(cwd);
  const rel = relative(dir, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return true;
  if (configured && normalize(target) === normalize(configured)) return true;
  return false;
}

/** 读计划文件：不存在返回空串（不抛出）。文件即真源（C3），无内存镜像。 */
export async function readPlanFile(target: string): Promise<string> {
  try {
    return await readFile(target, "utf8");
  } catch {
    return "";
  }
}

/** 写计划文件（content 空 = 删除文件，容错） */
export async function writePlanFile(target: string, content: string): Promise<void> {
  if (content.trim()) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  } else {
    try {
      await unlink(target);
    } catch {
      // 文件可能不存在
    }
  }
}
