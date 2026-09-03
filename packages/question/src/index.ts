/**
 * pi-plan-question · 结构化澄清库（多问题 + recommended 标注 + 「其他（自行输入）」自由文本）。
 *
 * 作为**库**被 pi-plan-mode import（route A：单一宿主 + 能力库）。mode 用它注册 `ask_user_question` 工具。
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuestionAnswer, QuestionSpec } from "pi-plan-bridge";

const OTHERS = "其他（自行输入）";
const RECOMMENDED_SUFFIX = "（推荐）";

/** 剥掉选项文本末尾的「（推荐）」标注（比较与答案清洗共用；容忍模型传入时已带后缀）。 */
export function stripRecommendedSuffix(text: string): string {
  return text.endsWith(RECOMMENDED_SUFFIX) ? text.slice(0, -RECOMMENDED_SUFFIX.length) : text;
}

/**
 * 构造 select 显示选项：
 * - 选项去重（含模型误传的「其他（自行输入）」）；
 * - recommended 命中时只追加一次「（推荐）」——无论 options 文本是否已带后缀；
 * - 「其他（自行输入）」由系统统一追加，选项已含时不重复。
 */
export function buildSelectOptions(options: string[], recommended?: string): string[] {
  const seen = new Set<string>();
  const labeled: string[] = [];
  for (const raw of options) {
    if (!raw || typeof raw !== "string") continue;
    const stripped = stripRecommendedSuffix(raw);
    const dedupKey = stripped === OTHERS || raw === OTHERS ? "__others__" : stripped;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const isRecommended = recommended !== undefined && stripped === stripRecommendedSuffix(recommended);
    labeled.push(isRecommended ? `${stripped}${RECOMMENDED_SUFFIX}` : stripped);
  }
  if (!seen.has("__others__")) {
    seen.add("__others__");
    labeled.push(OTHERS);
  } else if (!labeled.some((o) => o === OTHERS)) {
    // 模型可能把「其他（自行输入）」传成带变体的选项（如空格），确保始终有标准 OTHERS 供匹配。
    labeled.push(OTHERS);
  }
  return labeled;
}

/** 核心逻辑：逐题 select（标推荐项）+ 「其他」→ input 自由文本。可单测（mock ui）。 */
export function askUserQuestion(ctx: ExtensionContext, questions: QuestionSpec[]): Promise<QuestionAnswer[]> {
  const answers: QuestionAnswer[] = [];
  const run = async (): Promise<QuestionAnswer[]> => {
    for (const q of questions) {
      const choice = await ctx.ui.select(q.question, buildSelectOptions(q.options, q.recommended));
      if (choice === OTHERS) {
        const custom = await ctx.ui.input(q.question, "请输入你的回答（ESC 取消）…");
        answers.push(
          custom?.trim() ? { kind: "custom", value: custom.trim() } : { kind: "cancel", value: "（取消）" },
        );
      } else if (choice) {
        answers.push({ kind: "choice", value: stripRecommendedSuffix(choice) });
      } else {
        answers.push({ kind: "cancel", value: "（取消）" });
      }
    }
    return answers;
  };
  return run();
}

/** 把答案格式化为工具结果文本。 */
function formatAnswers(answers: QuestionAnswer[]): string {
  if (answers.length === 1) {
    const a = answers[0];
    return `${a.kind === "custom" ? "用户自定义输入：" : "用户选择："}${a.value}`;
  }
  return `用户回答：\n${answers.map((a) => (a.kind === "custom" ? `自定义：${a.value}` : a.value)).join("\n")}`;
}

/** 注册 ask_user_question 工具（由 pi-plan-mode 调用）。 */
export function registerQuestionTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user_question",
    label: "向用户提问",
    description:
      "向用户提出结构化选择题（最多 3 个问题，每个 2-4 个互斥选项；每个问题可给一个 recommended 标注推荐项）。" +
      "options 与 recommended 只传纯选项文本（不要自带「（推荐）」后缀）；「其他（自行输入）」选项由系统自动追加，不要写入 options。" +
      "用于澄清高影响取舍，用户可改选「其他」打自定义答案。",
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
      const questions: QuestionSpec[] = (params.questions as QuestionSpec[]) ?? [];
      if (!questions.length) return { content: [{ type: "text" as const, text: "未提供问题" }], details: undefined };
      const answers = await askUserQuestion(ctx, questions);
      return { content: [{ type: "text" as const, text: formatAnswers(answers) }], details: undefined };
    },
  });
}

// 契约自检（编译期）：本包入口满足 pi-plan-bridge 的 QuestionApi 契约。
import type { QuestionApi } from "pi-plan-bridge";
export const __questionApiContract: QuestionApi = { registerQuestionTool };
