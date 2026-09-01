/**
 * pi-plan-question · 结构化澄清库（多问题 + recommended 标注 + 「其他（自行输入）」自由文本）。
 *
 * 作为**库**被 pi-plan-mode import（route A：单一宿主 + 能力库）。mode 用它注册 `ask_user_question` 工具。
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuestionAsker, QuestionAnswer, QuestionSpec } from "pi-plan-bridge";

const OTHERS = "其他（自行输入）";

/** 核心逻辑：逐题 select（标推荐项）+ 「其他」→ input 自由文本。可单测（mock ui）。 */
export function askUserQuestion(ctx: ExtensionContext, questions: QuestionSpec[]): Promise<QuestionAnswer[]> {
  const answers: QuestionAnswer[] = [];
  const run = async (): Promise<QuestionAnswer[]> => {
    for (const q of questions) {
      const labeled = q.options.map((o) => (q.recommended && o === q.recommended ? `${o}（推荐）` : o));
      const choice = await ctx.ui.select(q.question, [...labeled, OTHERS]);
      if (choice === OTHERS) {
        const custom = await ctx.ui.input(q.question, "请输入你的回答（ESC 取消）…");
        answers.push(
          custom?.trim() ? { kind: "custom", value: custom.trim() } : { kind: "cancel", value: "（取消）" },
        );
      } else if (choice) {
        answers.push({ kind: "choice", value: choice.replace(/（推荐）$/, "") });
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
      "向用户提出结构化选择题（最多 3 个问题，每个 2-4 个互斥选项，给每个标注推荐项）。每个问题额外提供「其他（自行输入）」选项，用户可选它打自定义答案。用于澄清高影响取舍。",
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

export type { QuestionAsker };
