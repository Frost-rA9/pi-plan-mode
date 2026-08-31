/**
 * pi-planbuild v4 · 模式面工具（模型可调用，两类模式常驻——schema 恒定，dsh 语义）。
 *
 * - plan_file          计划文件读写（C3 文件即真源；仅 .pi/plans 或 /plan-file 配置）
 * - plan_mode_complete 提交最终计划（S1 三分支：批准并执行 / 继续规划 / dismissed）
 * - ask_user_question  结构化澄清（plan 专属，最多 3 个互斥选项）
 * - build_status       查询当前运行模式
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanbuildStore } from "../state.ts";
import type { ModeActions } from "../modes.ts";
import { readPlanFile, writePlanFile, isAllowedPlanPath, resolvePlanFilePath } from "../utils.ts";

/** 工具结果统一为 AgentToolResult 形状（content 数组 + details） */
function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

export function registerTools(pi: ExtensionAPI, store: PlanbuildStore, modes: ModeActions): void {
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

  /* ------ ask_user_question（结构化澄清） ------ */
  pi.registerTool({
    name: "ask_user_question",
    label: "向用户提问",
    description:
      "向用户提出结构化选择题（最多 3 个问题，每个 2-4 个互斥选项，给每个标注推荐项）。用于澄清高影响取舍。",
    promptSnippet: "结构化澄清",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          question: Type.String(),
          options: Type.Array(Type.String()),
          recommended: Type.Optional(Type.String()),
        }),
        { minItems: 1, maxItems: 3 },
      ),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx: ExtensionContext) => {
      const q = params.questions[0];
      if (!q) return textResult("未提供问题");
      const choice = await ctx.ui.select(q.question, q.options);
      return textResult(`用户选择：${choice ?? "（取消）"}`);
    },
  });

  /* ------ plan_mode_complete（S1 三分支） ------ */
  pi.registerTool({
    name: "plan_mode_complete",
    label: "提交计划",
    description:
      "提交最终计划并请求批准。批准 → 写入计划文件并切换到构建模式执行；继续规划 → 留在 plan；ESC/关闭 = dismissed。",
    promptSnippet: "提交最终计划",
    parameters: Type.Object({ plan: Type.String() }),
    execute: async (_id, params, _signal, _onUpdate, ctx: ExtensionContext) => {
      const target = resolvePlanFilePath(undefined, ctx.cwd, store.state.planFilePath);
      const preview =
        params.plan.length > 150 ? `${params.plan.slice(0, 147)}…` : params.plan || "（空计划）";
      const choice = await ctx.ui.select(`提交计划？\n${preview}`, ["批准并执行", "继续规划"]);
      if (choice === "批准并执行") {
        await writePlanFile(target, params.plan); // 计划文件即真源
        store.setMode("build");
        modes.enterBuildMode(ctx);
        return textResult(`计划已批准并写入 ${target}：\n${params.plan}`);
      }
      if (choice === "继续规划") {
        return textResult("继续规划（留在计划模式）。");
      }
      // dismissed（ESC/超时/关闭）→ 留在 plan，等待用户指示；不进消息队列
      return textResult("计划未提交（dismissed），留在计划模式等待指示。");
    },
  });
}
