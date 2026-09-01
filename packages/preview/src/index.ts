/**
 * pi-plan-preview · 计划预览库（启发式摘要，无 LLM、无 ctx、无 UI 渲染）。
 *
 * 实现 pi-plan-bridge 的 PlanPreviewRenderer：把计划文本生成简短摘要。
 * 作为**库**被 pi-plan-mode import（route A：单一宿主 + 能力库），无需事件总线 RPC。
 */
import type { PlanSummary } from "pi-plan-bridge";

/** 取首个 markdown 标题（无标题返回 undefined）。 */
export function firstHeading(plan: string): string | undefined {
  for (const line of plan.split("\n")) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/** 清掉列表前的项目符号/序号前缀，保留要点正文。 */
function stripListMarker(trimmed: string): string {
  return trimmed.replace(/^[-*+]\s+|^\d{1,9}[.)]\s+/, "").trim() || trimmed;
}

/** 判断一行是否为列表项（任务/要点）。 */
function isListItem(trimmed: string): boolean {
  return /^[-*+]\s/.test(trimmed) || /^\d{1,9}[.)]\s/.test(trimmed);
}

/**
 * 启发式摘要：首个标题 + 要点/清单前 maxBullets 条 + 步骤数（列表项数）+ 总行数。
 * 纯函数、确定性、零成本（无 LLM）。mode 拿到 PlanSummary 后用 formatPlanSummary 展示。
 */
export function summarize(plan: string, maxBullets = 5): PlanSummary {
  const lines = plan.split("\n");
  const bullets: string[] = [];
  let steps = 0;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (isListItem(trimmed)) {
      steps++;
      if (bullets.length < maxBullets) bullets.push(stripListMarker(trimmed));
    }
  }
  return {
    title: firstHeading(plan),
    bullets,
    steps,
    lines: lines.length,
  };
}
