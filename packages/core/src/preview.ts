/**
 * pi-plan-mode · 计划预览消息区条目（markdown 渲染，不进 LLM 上下文）。
 *
 * 形态：plan_mode_complete 时把预览（formatPlanSummary markdown / 降级截断原文）经
 * `pi.appendEntry` 渲染到消息区（持久化、可回看），`select` 只留简短标题——preview
 * 不再塞进选择区标题（长摘要不可展开、无 markdown）。设计不变量 4：批准交互
 * （选项/选择）不进 LLM 上下文；entry 渲染（appendEntry）本就 TUI-only，满足。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { PB_ENTRY_TYPE } from "./events.ts";

/** 计划预览条目类型（与状态事件 PB_ENTRY_TYPE 区分；parsePbEvents 只认前者，不会误折叠）。 */
export const PLAN_PREVIEW_ENTRY = `${PB_ENTRY_TYPE}:plan-preview`;

/** 预览 markdown 上限（截断降级用），超过则用尾部省略。 */
export const PREVIEW_MAX_CHARS = 1200;

/** 注册消息区渲染器（工厂初始化时一次）。 */
export function registerPlanPreviewRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<{ markdown: string }>(PLAN_PREVIEW_ENTRY, (entry, _opts, theme) => {
    const md = entry.data?.markdown ?? "";
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("accent", "📋 计划预览"), 0, 0));
    box.addChild(new Markdown(md, 0, 0, getMarkdownTheme()));
    return box;
  });
}

/** 发出预览条目（消息区渲染；幂等无副作用——每次提交一条，历史可回看）。 */
export function emitPlanPreview(pi: ExtensionAPI, markdown: string): void {
  pi.appendEntry(PLAN_PREVIEW_ENTRY, { markdown });
}

/** 预览 markdown 构造：有摘要用 markdown 摘要；无（preview 能力缺席/失败）→ 截断原文 + 降级说明。 */
export function buildPreviewMarkdown(summary: string | undefined, plan: string): string {
  if (summary) return summary;
  const truncated =
    plan.length > PREVIEW_MAX_CHARS ? `${plan.slice(0, PREVIEW_MAX_CHARS - 1)}…` : plan || "（空计划）";
  return `> 预览能力未启用，已截断原文（${plan.length} 字符）。完整计划在工具结果/计划文件中。\n\n${truncated}`;
}
