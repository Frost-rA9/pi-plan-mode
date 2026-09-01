# pi-plan-mode

[Pi](https://pi.dev) 的 **plan/build 双模式扩展**（monorepo，workspaces）：单一宿主 + 可插拔能力库。

> 架构（Route A）：**一个宿主 + 能力库**，所有能力经 `import` 注入，插拔方式一致。可**按需启用**（`plan-capabilities`）与**替换**（`plan-capabilities-<id>`）。

## 包结构（`packages/*`）

```text
bridge    契约：类型 + 能力接口（SafetyProvider / PlanPreviewRenderer / QuestionAsker）+ 共享纯函数（classifyDockerWrite、formatPlanSummary…）
core      唯一 pi 扩展（workspace 包名 `pi-plan-core`，扩展显示名 `pi-plan-mode`）：状态折叠/模式切换/plan_file/plan_mode_complete/build_status/命令/gate + 能力注册
sandbox   OS 沙箱库：bwrap（Linux/WSL2）、winacl（Windows 受限令牌 + NTFS ACE，shell=pwsh，win32/ FFI）。被 core import
preview   计划预览库：启发式摘要（首标题 + 要点前 N 条 + 步骤数/行数）。被 core import
question  结构化澄清库：ask_user_question（recommended + 「其他」自由文本）。被 core import
```

根 `package.json` 的 `pi.extensions` 指向 `./index.ts`（包根 re-export 入口，加载 `packages/core/src/index.ts`；包根入口保证 /config 显示名为 `pi-plan-mode/index.ts`，与 pi-mcp-bridge 同构）；`workspaces: ["packages/*"]`。

## 能力：按需启用 / 替换

启动 flag（改后 `/reload`）：

```sh
pi --plan-capabilities=preview          # 只启用 preview；sandbox/question 不加载
pi --plan-capabilities=none             # 纯 plan/build 工作流（无任何能力）
pi --plan-capabilities=all              # 默认：全部能力
pi --plan-capabilities-sandbox=my-sand  # 替换 sandbox 实现包名（同一契约）
pi --plan-capabilities-preview=my-prev  # 替换 preview 实现
pi --plan-capabilities-question=my-ask  # 替换 question 实现
```

缺席/未装/加载失败 → 该能力降级（无 sandbox → 门控降级 `supervised`；无 preview → 截断预览；无 question → 不注册 `ask_user_question`），不影响其它。运行时 `/plan-capabilities` 查看状态。

## 模型可调用工具

| 工具 | 来自 | 作用 |
|---|---|---|
| `plan_file` | mode | 读写当前计划文件（唯一真源；仅 `.pi/plans` 或 `/plan-file`） |
| `plan_mode_complete` | mode | 提交计划：**预览（preview 摘要）+ 批准/继续/dismissed** |
| `build_status` | mode | 查询当前模式（plan / build） |
| `ask_user_question` | question（能力） | 结构化澄清（recommended + 其他自由输入） |

## 行为速览

- **双模式**：plan（只读，移除 `edit`/`write`；模型不能自切）→ build（完整权限）。切换：`/plan` `/build` 或 Ctrl+Alt+P/B。
- **计划文件即真源**：规划产物入 `.pi/plans/PLAN.md`，无内存镜像。
- **批准三分支**：批准并执行（写计划文件 + 切 build）/ 继续规划 / `dismissed`（ESC = 留 plan 等指示）。
- **安全档位**（`/plan-safety`）：`readonly`（默认，OS 只读沙箱）/ `verify`（工作区可写）/ `supervised`（无沙箱+confirm）/ `strict`（无沙箱+拒绝）。沙箱不可用自动降级 `supervised`（fail-closed，决不无限制执行）。
- **沙箱挂载**（`/plan-sandbox`）：查看/更新沙箱额外挂载与掩码。

## 安装 / 本地调试

```sh
pi install git:github.com/Frost-rA9/pi-plan-mode
# 本仓位于 ~/projects/pi-extensions/pi-plan-mode → pi install "~/projects/pi-extensions/pi-plan-mode"
# 本地：直接在本仓（settings.json 的 packages 指向它），改代码后 /reload
```

## 二次开发 / 验证

```sh
npm run typecheck        # 跑全部 workspace typecheck（strict）
npm test                 # 跑全部 workspace 测试（各包 test/*.spec.ts）
# 单项：cd packages/<pkg> && npm run typecheck / npm test
```

## 设计要点（写入 AGENTS.md）

- **插拔方式一致**：所有能力 = 库，mode 经统一 loader（`loadCapabilities`）按需加载/替换，契约在 bridge。
- **关键约束**：`BashSpawnHook` 是同步的 → sandbox 不能做成扩展，只能作为被 mode import 的库（mode 注入 `readState`）；故不采用多扩展 + 事件总线 RPC（`rpcRequest/rpcServe` 已弃）。
- 单源：类型/纯函数/`classifyDockerWrite` 在 bridge；安全清单在 sandbox；交互层配置在 mode。
- 不变量：真实 OS 隔离靠 OS/虚拟化边界；fail-closed；模型不能自切模式；dismissed ≠ rejected；计划文件真源；最小暴露面。
