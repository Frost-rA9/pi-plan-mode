/**
 * pi-plan-mode · 模式面工具（模型可调用，两类模式常驻——schema 恒定）。
 *
 * - plan_file          计划文件读写（C3 文件即真源；仅 .pi/plans 或 /plan-file 配置）
 * - plan_mode_complete 提交最终计划（S1 三分支：批准并执行/继续规划/dismissed；预览经 pi-plan-preview 摘要）
 * - build_status       查询当前运行模式
 * （ask_user_question 由独立扩展 pi-plan-question 注册，P3 接入。）
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatPlanSummary, type PlanSummary, type PlanReviewChoice } from "pi-plan-bridge";
import type { PlanbuildStore } from "./state.ts";
import type { ModeActions } from "./modes.ts";
import type { PreviewApi } from "./capabilities.ts";
import { buildPreviewMarkdown, emitPlanPreview } from "./preview.ts";
import { readPlanFile, writePlanFile, isAllowedPlanPath, resolvePlanFilePath } from "./utils.ts";

/** 工具结果统一为 AgentToolResult 形状（content 数组 + details） */
function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

export function registerTools(
  pi: ExtensionAPI,
  store: PlanbuildStore,
  modes: ModeActions,
  previewApi?: PreviewApi,
): void {
  /* ------ plan_file（C3 文件即真源） ------ */
  pi.registerTool({
    name: "plan_file",
    label: "计划文件",
    description: "读取或写入当前计划文件（唯一真源）。write 的 content 为空 = 删除文件。",
    promptSnippet: "计划文件读写",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("read"), Type.Literal("write")]),
      content: Type.Optional(Type.String()),
      file: Type.Optional(Type.String()),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx: ExtensionContext) => {
      const target = resolvePlanFilePath(params.file, ctx.cwd, store.state.planFilePath);
      if (params.action === "write") {
        if (!isAllowedPlanPath(target, ctx.cwd, store.state.planFilePath)) {
          return textResult(`拒绝：计划写入目标在允许路径之外（仅 .pi/plans 或 /plan-file 配置）：${target}`);
        }
        await writePlanFile(target, params.content ?? "");
        return textResult(`计划文件已写入：${target}`);
      }
      const body = await readPlanFile(target);
      return textResult(body || "（计划文件为空或不存在）");
    },
  });

  /* ------ build_status ------ */
  pi.registerTool({
    name: "build_status",
    label: "运行模式",
    description: "查询当前运行模式（plan 或 build）。",
    promptSnippet: "查询当前模式",
    parameters: Type.Object({}),
    execute: async () => {
      return textResult(`当前模式: ${store.state.mode}`);
    },
  });

  /* ------ plan_mode_complete（S1 三分支；预览经 preview RPC 取摘要） ------ */
  pi.registerTool({
    name: "plan_mode_complete",
    label: "提交计划",
    description:
      "提交最终计划并请求批准。批准 → 写入计划文件并切换到构建模式执行；继续规划 → 留在 plan；ESC/关闭 = dismissed。",
    promptSnippet: "提交最终计划",
    parameters: Type.Object({ plan: Type.String() }),
    execute: async (_id, params, _signal, _onUpdate, ctx: ExtensionContext) => {
      const target = resolvePlanFilePath(undefined, ctx.cwd, store.state.planFilePath);
      // 预览：经能力注册取 previewApi（可选库）；缺席降级截断原文。
      // 形态：预览以 markdown 渲染到**消息区**（appendEntry：TUI-only，不进 LLM 上下文，
      // 不变量 4）；select 只保留简短标题，长摘要不再塞进选择区。
      const summary: PlanSummary | undefined = previewApi ? previewApi.summarize(params.plan) : undefined;
      const previewMarkdown = buildPreviewMarkdown(
        summary ? formatPlanSummary(summary) : undefined,
        params.plan,
      );
      emitPlanPreview(pi, previewMarkdown);

      const choice = await ctx.ui.select("提交计划？（完整预览已显示于消息区）", ["批准并执行", "继续规划"]);
      const decision: PlanReviewChoice =
        choice === "批准并执行" ? "approve" : choice === "继续规划" ? "continue" : undefined;

      if (decision === "approve") {
        await writePlanFile(target, params.plan); // 计划文件即真源（agent 生成原文，用户不改）
        modes.enterBuildMode(ctx);
        // 批准发生在当前 agent 回合内：即时显示一次，后续 build prompt 不重复。
        modes.announceModeNotice();
        return textResult(`计划已批准并写入 ${target}：\n${params.plan}`);
      }
      if (decision === "continue") {
        return textResult("继续规划（留在计划模式）。");
      }
      // dismissed（ESC/超时/关闭）→ 留在 plan，等待用户指示；不进消息队列
      return textResult("计划未提交（dismissed），留在计划模式等待指示。");
    },
  });
}
