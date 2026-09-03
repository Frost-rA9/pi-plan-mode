/**
 * pi-plan-question 测试：askUserQuestion（预设选项 + 推荐标注剥离 / 其他自由输入 / 多问题）。
 * 运行：node --experimental-strip-types test/question.spec.ts
 */
import assert from "node:assert/strict";
import { askUserQuestion, buildSelectOptions, stripRecommendedSuffix } from "../src/index.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

function mockCtx(selectResults: string[], inputResults: string[]): { ctx: ExtensionContext; ui: any } {
  const ui = {
    selectResults: [...selectResults],
    inputResults: [...inputResults],
    async select(_title: string, options: string[]) {
      const r = ui.selectResults.shift();
      if (r === undefined) return options[0] as string;
      return options.find((o) => o.includes(r)) ?? undefined as string | undefined;
    },
    async input(_t: string, _p?: string) {
      return ui.inputResults.shift();
    },
  };
  return { ctx: { ui } as unknown as ExtensionContext, ui };
}

// 1) 预设选项 + recommended 标注剥离
{
  const { ctx } = mockCtx(["方案B（推荐）"], []);
  const res = await askUserQuestion(ctx, [{ question: "选哪个？", options: ["方案A", "方案B"], recommended: "方案B" }]);
  assert.equal(res[0].kind, "choice");
  assert.equal(res[0].value, "方案B");
}

// 2) 其他 → 自定义输入
{
  const { ctx } = mockCtx(["其他（自行输入）"], ["轻量方案"]);
  const res = await askUserQuestion(ctx, [{ question: "方向？", options: ["A", "B"] }]);
  assert.equal(res[0].kind, "custom");
  assert.equal(res[0].value, "轻量方案");
}

// 3) 多问题
{
  const { ctx } = mockCtx(["方案A", "其他（自行输入）"], ["补充"]);
  const res = await askUserQuestion(ctx, [
    { question: "Q1", options: ["方案A", "方案B"] },
    { question: "Q2", options: ["是", "否"] },
  ]);
  assert.equal(res.length, 2);
  assert.equal(res[0].value, "方案A");
  assert.equal(res[1].kind, "custom");
}

// 4) ESC/取消（无选择、无自定义）→ cancel
{
  const { ctx } = mockCtx([], []); // select 无匹配 → undefined
  // select 返回 undefined 需模拟：透传 undefined
  const c = mockCtx([], []);
  (c.ctx.ui as any).select = async () => undefined;
  const res = await askUserQuestion(c.ctx, [{ question: "q", options: ["a"] }]);
  assert.equal(res[0].kind, "cancel");
}

// 5) 回归（真机 bug 复现）：模型把「（推荐）」后缀和「其他（自行输入）」写进 options ——
//    select 不出现双「（推荐）」、不出现双「其他（自行输入）」。
{
  const dirtyOptions = [
    "批准并执行后立即显示一次notice，并标记已消费；后续对话不再显示（推荐）",
    "保持在批准后的下一次模型回合显示一次；批准当下不立即显示",
    "其他（自行输入）",
  ];
  const dirtyRecommended = "批准并执行后立即显示一次notice，并标记已消费；后续对话不再显示（推荐）";
  const shown = buildSelectOptions(dirtyOptions, dirtyRecommended);
  assert.equal(shown.filter((o) => o.includes("（推荐）")).length, 1); // 只标注一次
  assert.equal(shown.filter((o) => o === "其他（自行输入）").length, 1); // 只出现一次
  assert.equal(shown[0], "批准并执行后立即显示一次notice，并标记已消费；后续对话不再显示（推荐）");
  // 端到端：mock select 选中推荐项 → 答案剥离后缀。
  const { ctx } = mockCtx([shown[0]], []);
  const res = await askUserQuestion(ctx, [
    { question: "q", options: dirtyOptions, recommended: dirtyRecommended },
  ]);
  assert.equal(res[0].kind, "choice");
  assert.equal(res[0].value, "批准并执行后立即显示一次notice，并标记已消费；后续对话不再显示");
}

// 6) buildSelectOptions：重复选项去重 + 空值过滤。
{
  const shown = buildSelectOptions(["方案A", "方案A", "", undefined as unknown as string, "方案B（推荐）"], "方案B");
  assert.equal(shown.length, 3);
  assert.ok(shown.includes("方案A"));
  assert.ok(shown.includes("方案B（推荐）"));
  assert.ok(shown.includes("其他（自行输入）"));
}

// 7) stripRecommendedSuffix 纯函数。
{
  assert.equal(stripRecommendedSuffix("x（推荐）"), "x");
  assert.equal(stripRecommendedSuffix("x（推荐）"), "x");
  assert.equal(stripRecommendedSuffix("y"), "y");
}

console.log("✅ question: askUserQuestion (choice/recommended/custom/multi/cancel/dirty-options)");
