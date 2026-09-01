/**
 * pi-plan-question 测试：askUserQuestion（预设选项 + 推荐标注剥离 / 其他自由输入 / 多问题）。
 * 运行：node --experimental-strip-types test/question.spec.ts
 */
import assert from "node:assert/strict";
import { askUserQuestion } from "../src/index.ts";
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

console.log("✅ question: askUserQuestion (choice/recommended/custom/multi/cancel)");
