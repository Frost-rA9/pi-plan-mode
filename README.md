# pi-planbuild

[Pi](https://pi.dev) 的 plan/build 双模式扩展：**plan 模式**只读规划、产出计划文件；**build 模式**执行实现。
模式切换仅由用户驱动（`/plan` `/build` 或 Ctrl+Alt+P/B），模型不能自行切换。隔离边界由**可插拔 OS 沙箱后端**提供：
Linux/WSL2 走 bwrap（命名空间），原生 Windows 走 winacl（受限令牌 + NTFS ACE，**沙箱 shell = pwsh**）。

> 独立仓库（未发布 npm）。设计依据与取舍：[AGENTS.md](./AGENTS.md)（本地，不入库）· winacl Phase 2 交付：[src/sandbox/win32/README.md](./src/sandbox/win32/README.md)

## 模型可调用工具

| 工具 | 作用 |
|---|---|
| `plan_file` | 读写当前计划文件（**唯一真源**；写入仅限 `.pi/plans` 或 `/plan-file` 配置内） |
| `plan_mode_complete` | 提交最终计划：**批准并执行**（写计划文件 + 切 build）/ **继续规划** / **dismissed**（ESC 关闭 = 留在 plan） |
| `ask_user_question` | 结构化澄清（最多 3 个互斥选项，标推荐项） |
| `build_status` | 查询当前运行模式（plan / build） |

## 行为速览

- **双模式**：plan（只读，移除 `edit`/`write`；模型不能自行切回）→ build（完整权限，恢复写工具）。
- **计划文件即真源**：规划产物入 `.pi/plans/PLAN.md`（可 `/plan-file ./x.md` 改），无内存镜像；build 提示指向它作执行依据。
- **安全档位**（`/plan-safety`）：OS 沙箱只在 `readonly`/`verify` 档强制；后端不可用自动降级 `supervised`（fail-closed，**决不无限制执行、不变弱**）。
- **Windows 沙箱 shell = pwsh**：受限令牌 × git bash（MSYS2/Cygwin）固有不兼容（dsh/Codex 在 Windows 也用 pwsh/cmd）；winacl 档自动移除 `bash`、加入 `powershell`。
- **winacl 由独立 Node 子进程承载**：pi 宿主是 Bun，加载不了 koffi（原生插件即崩），故 koffi/Win32 全在 `src/sandbox/win32/runner.ts`（Node 子进程）里执行，pi 侧仅经一条 IPC（`init`/`exec`/`dispose`，`kill` 经 AbortSignal 终止子进程）驱动——对齐 dsh runner / codex 原生二进制的「OS 沙箱 = 子进程」模式。
- **docker 控制面 fail-closed**：只读子命令放行；写/未知拦截，防止经 unix-socket 绕过沙箱写面。

## 安全档位（`/plan-safety`）

| 档位 | 沙箱后端 | 交互层 |
|---|---|---|
| `readonly`（默认） | OS 只读沙箱（bwrap / winacl+pwsh，含敏感路径隐藏） | 零确认 |
| `verify` | 工作区**可写**（`.git`/`.pi` 只读子路径防提权）+ 其余同 readonly | 零确认——验证式规划（plan 下跑测试/构建） |
| `supervised` | 无沙箱（无可用 OS 沙箱后端时 readonly/verify 自动降级至此） | 只读集合放行 + 未知命令 confirm（允许一次/此类/拒绝；"允许此类"落 grant 事件，跨会话记忆） |
| `strict` | 无沙箱 | 只读集合放行 + 未知拒绝 |

## 安装

```bash
pi install git:github.com/Frost-rA9/pi-planbuild      # 从 git 安装（常驻全局）
# 或
pi install https://github.com/Frost-rA9/pi-planbuild  # raw URL 亦可
# 本地调试
pi -e ./index.ts
```

> 作者本地：本仓位于 `~/projects/pi-extensions/pi-planbuild`，直接 `pi install "~/projects/pi-extensions/pi-planbuild"` 或 `pi -e ./index.ts`。

## 配置（命令 / 启动参数）

命令：

```sh
/plan-safety              # 显示/设置安全档位（readonly/verify/supervised/strict）
/plan-sandbox             # 查看/配置沙箱挂载（home 只读 / docker.sock / 附加路径）
```

启动参数：

```sh
pi --plan=true                      # 以计划模式启动（布尔 flag 必须用 = 语法：pi 会把 --plan 后的第一个 token 当值）
pi --plan=true --plan-safety verify # 验证式规划（工作区可写沙箱）
pi --plan-file ./PLAN.md            # 自定义计划文件
pi --plan-mount ~/data,/mnt/d       # 附加只读挂载（bwrap）
```

## 使用

```
/plan                              → 进入计划模式（只读规划）
plan_file({action:"write", content:"..."})    → 写计划
plan_mode_complete({plan:"..."})             → 提交计划：批准并执行 → 切 build
/build                              → 手动切回构建模式（纯切换，不注入计划内容）
```

## 二次开发

```text
pi-planbuild/
├── index.ts            # 入口：装配 C1/层0/层1/层2 + session_start 恢复
├── src/
│   ├── events.ts       # C1 事件定义 + 纯折叠（mode/safety/plan-path/sandbox/grant/snapshot）
│   ├── state.ts        # PlanbuildStore：dispatch = 改缓存 + 落日志（单点）
│   ├── modes.ts        # 层0 工具可得性 + 状态条 + 提示/notice 注入
│   ├── sandbox.ts      # 层1 编排：selectBackend + shellTool → createBashTool/createPowerShellTool
│   ├── sandbox/
│   │   ├── backend.ts      # SandboxBackend 抽象 + selectBackend
│   │   ├── bwrap.ts        # bwrap（Linux）挂载/掩码/探测
│   │   ├── winacl.ts       # winacl（Windows+pwsh）后端：probe=spawnSync runner --probe；会话=runner IPC
│   │   └── win32/          # Win32 FFI seam：koffi 在 Node 子进程 runner.ts 内跑（Bun 宿主不容）
│   ├── gate.ts         # 层2 门控：supervised confirm / strict 拒绝 / docker 控制面
│   ├── classify.ts     # 命令 读/写/未知 分类
│   ├── docker-gate.ts  # docker 只读子命令白名单
│   ├── commands.ts     # /plan /build /plan-safety /plan-sandbox + flags
│   ├── prompt.ts       # PLAN/BUILD_MODE_PROMPT
│   ├── config.ts       # 安全清单/模式/敏感路径
│   └── utils.ts        # 计划文件路径解析/读写
├── test/smoke.ts       # 冒烟：C1/C2/C3/S1/S2/门控/v4 路由（18 组）
├── AGENTS.md           # 设计依据：不变量与取舍（改实现前先读；本地，不入库）
└── src/sandbox/win32/README.md  # Phase 2 交付指南
```

**开发流程**

```bash
npm install
npm run typecheck    # tsc --noEmit
npm test             # node test/smoke.ts
npm run probe        # 折叠语义探针
npm run probe:winacl # winacl 自检（非 win32 跳过；真实 Windows 往返断言）
pi -e ./index.ts     # 带扩展本地调试
```

## winacl 落地（Windows + Bun 已可用）

`src/sandbox/win32/` 为 fail-closed seam：`winaclProbe()`（koffi + 建受限令牌 + **pwsh-under-token 冒烟**）通过才 `available=true`；否则 Windows readonly/verify 降级 supervised（安全不弱化）。

**关键：koffi 必须在独立 Node 子进程（`win32/runner.ts`）里跑**——pi 宿主是 Bun，加载 koffi（原生 N-API 插件）即 panic；Bun 的 `bun:ffi` 又读不了裸原生内存（ACL capture-restore / 幂等必需）。故 koffi/Win32 全在 runner（Node）内执行，pi 侧 `winacl.ts` 经一条极薄 IPC 驱动（`init`/`exec`/`dispose`；`kill` 经 AbortSignal → `terminateProcess`）。细节见 `src/sandbox/win32/README.md`。

## 依赖

- `koffi`（optionalDependency，仅 winacl 用，且只被 **Node 子进程 `win32/runner.ts`** 加载；Win32 native FFI）
- peer：`@earendil-works/pi-coding-agent` 等（runtime ≥ 0.84.4；devDep 已锁 0.84.4）
