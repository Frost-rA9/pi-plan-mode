# pi-planbuild (v4 · 路线 X)

pi 的 plan/build 双模式扩展：**pi 原生为骨、四家语义为肉**（opencode / Claude Code / Codex / dsh）。
**独立仓库**（非 monorepo 聚合），未发布 npm。

> **本地设计依据** `AGENTS.md`（略：四家调研 / 三段式判定 / 设计不变量 / 已知取舍）——**不入库**（`.gitignore` 排除）。设计细节也见 `src/sandbox/win32/README.md`。

## v4（路线 X）为什么 Windows 用 pwsh

v3 尝试「原生 Windows readonly/verify 走受限令牌（winacl）」被真机证伪：**受限令牌 × git bash（MSYS2/Cygwin）固有不兼容**（Cygwin 初始化须调 `NtSetInformationToken(TokenDefaultDacl)`，Windows 对任何受限令牌拒绝）。但该结论前提「git bash 是固定 shell」**不成立**——pi 原生提供 **`powershell` 工具**（`createPowerShellTool`，与 bash 同款 `operations`/`spawnHook` 接缝）。四家参考源（dsh/Codex）之所以能用受限令牌，正因它们在 Windows 上用 **pwsh/cmd**。

**路线 X**：WSL2/Linux 走 bwrap；**原生 Windows 的 readonly/verify 走 winacl（受限令牌 + NTFS ACE，免提权），沙箱 shell = pwsh**（pi `powershell` 工具）。无 WSL2 依赖、无 `/mnt` 跨边界。

## 架构

| 层 | 职责 | 实现 |
|---|---|---|
| C1 状态即日志 | 模式/档位/计划路径/批准记忆 = 会话日志事件，`getBranch()` 纯折叠恢复 | `src/events.ts` + `src/state.ts` |
| 层 0 工具可得性 | plan 移除 `edit`/`write`；win32+winacl 沙箱档**移除 bash、加入 powershell** | `src/modes.ts` |
| 层 1 OS 边界 | 可插拔后端（`selectBackend` + `shellTool`）：**bwrap**（Linux/WSL2，shell=bash，`spawnHook` 前缀 + docker.sock 掩码）；**winacl**（Windows 受限令牌+NTFS ACE，**shell=pwsh**，自定义 `operations.exec` + deny-read，免提权） | `src/sandbox.ts` + `src/sandbox/` |
| 层 2 交互层 | OS 沙箱档零确认（docker 控制面 fail-closed）；supervised confirm（grant 事件化）/ strict 拒绝 | `src/gate.ts` + `src/classify.ts` + `src/docker-gate.ts` |
| C3 计划文件即真源 | 计划文件唯一真源，无内存镜像 | `src/tools/index.ts` |
| S1 批准三分支 | 批准并执行（写计划文件+切 build）/ 继续规划 / dismissed | `src/tools/index.ts` |

## 安全档位（`/plan-safety`）

| 档位 | 沙箱后端 | 交互层 |
|---|---|---|
| `readonly`（默认） | OS 只读沙箱（bwrap / winacl+pwsh，含敏感路径隐藏） | 零确认 |
| `verify` | 工作区**可写**（`.git`/`.pi` 只读子路径防提权） | 零确认——验证式规划 |
| `supervised` | 无沙箱（无可用 OS 沙箱后端时 readonly/verify 自动降级至此） | 只读集合放行 + 未知 confirm（允许一次/此类/拒绝） |
| `strict` | 无沙箱 | 只读集合放行 + 未知拒绝 |

安全不变量：无纯 prompt 档（真隔离靠 OS 边界）；edit/write 在 plan 下任何档位都移除；模型不能自行切换模式（仅用户 `/plan` `/build` 或 Ctrl+Alt+P/B）；winacl 未自检 pass → fail-closed 降级 supervised（决不无限制 spawn，**Windows 上不变弱**）。

## 常用命令 / flag

```sh
/plan                       # 进入计划模式（OS 沙箱后端可用时强制边界）
/build                      # 进入构建模式（纯切换，不注入计划内容）
/plan-safety                # 显示/设置安全档位（readonly/verify/supervised/strict）
/plan-sandbox               # 查看/配置沙箱挂载（home 只读 / docker.sock / 附加路径）
```

```sh
pi --plan=true                      # 以计划模式启动（布尔 flag 必须用 = 语法：pi 解析器会把 --plan 后的第一个 token 当值）
pi --plan=true --plan-safety verify # 验证式规划（工作区可写沙箱）
pi --plan-file ./PLAN.md            # 自定义计划文件
pi --plan-mount ~/data,/mnt/d       # 附加只读挂载
```

## 测试

```sh
npm run probe          # 折叠语义探针（fold / snapshot 兼容）
npm test               # 冒烟：C1 折叠 / C2 档位 / C3 文件真源 / S1 三分支 / S2 grant / 门控 / v4 路由 / docker.sock / bwrap / shell path
npm run probe:winacl   # winacl 后端自检：非 win32 跳过；真实 Windows 真机自检（含 pwsh-under-token 冒烟）通过后做安全往返断言
npm run typecheck      # strict 类型检查
```

## Phase 2（需真实 Windows 交付）

`src/sandbox/win32/index.ts` 为 **fail-closed seam**：`winaclProbe()`（koffi 加载 + 建受限令牌 + **pwsh-under-token 冒烟**）通过才 `available=true`；否则 Windows readonly/verify 降级 supervised（安全不弱化）。真正的 Win32 原语（`CreateRestrictedToken`/`SetEntriesInAclW`/`CreateProcessWithTokenW`+Job/deny-read）为 `win32/*` 各模块，须在真实 Windows 构建+自检。落地接线示例见 `src/sandbox/win32/README.md`。

## 第三方依赖

- `koffi`（optionalDependency，仅 winacl 运行时用；Win32 native FFI）
- peer：`@earendil-works/pi-coding-agent` 等（runtime ≥ 0.84.4；devDep 已锁 0.84.4）
