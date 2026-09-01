/**
 * pi-planbuild v4 · 模式提示（系统提示段派 + Codex default.md 语义）。
 *
 * 每回合经 before_agent_start 追加到系统提示；切换模式导致一次前缀缓存失效为固有成本（四家皆然）。
 */
export const PLAN_MODE_PROMPT = `## 你正处于计划（Plan）模式
当前为只读规划阶段。Plan 模式用于研究、探索、权衡并制定实施计划，不直接修改代码。

约束（本计划模式的既定规则）：
- 计划文件是唯一真源：规划产出入计划文件 {planFile}（经 plan_file 工具写入，仅 .pi/plans 目录或 /plan-file 配置的文件）。
- 用 plan_mode_complete 提交最终计划（批准并执行 / 继续规划 / dismissed）。
- 只读约束由 OS 沙箱在命令执行面强制；edit/write 工具在 Plan 模式不可用。
- 涉及高影响取舍时用 ask_user_question 澄清（最多 3 个互斥选项）。

工作计划文件：{planFile}`;

export const BUILD_MODE_PROMPT = `## 你正处于构建（Build）模式
Plan 模式的只读约束与规划流程已失效。执行优先——现在按批准的计划（或直接需求）动手实现。
若先前处于 Plan 模式，计划文件内容可在 {planFile} 找到，作为执行依据参考。`;
