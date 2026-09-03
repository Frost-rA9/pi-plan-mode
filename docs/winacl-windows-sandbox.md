# pi-planbuild v4（路线 X）· winacl 后端落地（Phase 2）指南

> 面向**有真实 Windows 环境**的开发者。目标：把 `src/sandbox/win32/` 从 fail-closed seam 补完为
> **真实可用的 Windows OS 只读沙箱**（readonly/verify，**沙箱 shell = pwsh**），并用 `npm run probe:winacl` 自检通过后自动启用。
> 在此之前，`winaclProbe()` 恒为 false → readonly/verify 降级 `supervised`（安全，决不无限制 spawn）。

## 一、现状与目标（Windows 真机已达目标）
| 项 | 状态 |
|---|---|
| `winaclProbe()` | ✅ koffi + OpenProcessToken + CreateRestrictedToken + **pwsh-under-token 冒烟**（echo ok exit 0）通过才 true |
| `createWinaclSession()` | ✅ 返回真实 `WinaclSessionImpl`（非 win32 / 未自检 → `NoopSession`，isSpawnable=false → fail-closed） |
| Windows readonly/verify | ✅ 走真实受限令牌 + NTFS ACE 沙箱（pwsh）；非 win32 / 未自检 → 降级 `supervised` |

> **⚠️ 运行时铁律：koffi 必须在独立 Node 子进程（`runner.ts`）里跑，绝不能进 Bun 宿主进程。**
> pi 宿主是 **Bun**，加载 koffi（原生 N-API 插件）即 `napi_reference_unref` panic（**abort 进程，非 throw**）；而 Bun 的 `bun:ffi` 又读不了裸原生内存（ACL capture-restore / 幂等必需）。因此：
> - 全部 koffi/Win32 逻辑（`token.ts`/`acl.ts`/`session.ts`/`spawn.ts`/`stdio.ts`…）在 `win32/runner.ts`（Node 子进程）内执行；
> - pi 侧 `winacl.ts` 只经一条极薄 **IPC**（stdin/stdout 一行一个 JSON：`init`/`exec`/`dispose`，`kill` 经 AbortSignal → `terminateProcess` 终止子进程）驱动它——对齐 dsh runner / codex 原生二进制的「OS 沙箱 = 子进程」模式；
> - `probe()` 由 `winacl.ts` 用 `spawnSync node --experimental-strip-types runner.ts --probe`（exit 0 = 可用）判定。
> 非 win32 / 子进程自检未过 → `available=false` → fail-closed 降级（readonly/verify → `supervised`），决不无限制 spawn。

## 二、接入 seam（已就绪，别改签名）
`winacl.ts` 已接好：`probe()`→`win32/index.ts` `winaclProbe()`；进入 plan+readonly/verify 时 `createWinaclSession({cwd, profile, readState})`→`init`→每条 **pwsh** 命令经 `session.exec(command, cwd, {onData, signal, timeout, env})`；`isSpawnable()===false` 时 fail-closed 抛错（绝不无限制执行）。`registerSandbox` 用 `createPowerShellTool` 承载（win32 拉起 pi `powershell` 工具）。

## 三、要实现的模块（transcribe 自 dsh）
参考源：`~/projects/deepseek-harness/packages/sandbox/sandbox-windows-acl/src/`（Win11 26200 实测）。依赖：`koffi`。

| 文件 | 职责 | dsh 参考 |
|---|---|---|
| `abi.ts` | Win32 常量（WRITE_RESTRICTED/LUA_TOKEN/GRANT_MASK/TOKEN_CLASS/ACE 掩码…） | `win32-abi.ts` |
| `ffi.ts` | koffi 绑定表 + alloc/decode（allocPtrSlot/decodePtr/isNullPtr/throwLastError） | `ffi.ts` |
| `token.ts` | `openCurrentProcessToken`→`findLogonSid`→`createRestrictedToken(WRITE_RESTRICTED\|LUA_TOKEN\|DISABLE_MAX_PRIVILEGE, restricting=[logonSid, EVERYONE, ...capSids])` + `setTokenDefaultDaclGrant` | `token.ts` |
| `sid.ts` | `workspaceWriteSid(canonical)`→`S-1-4-x-y`；`tempWriteSid(tmp)`→`S-1-4-x-y-1`；**`readDenySid()`** | `workspace-sid.ts` |
| `acl.ts` | `grantWrite`/`denyWrite`/`denyRead`（`GetNamedSecurityInfoW`+`SetEntriesInAclW`；ACE 命名 capability SID，免提权） | `acl.ts` |
| `grant.ts` | `AclWriteGrant` 等价（工作区写 ACE、temp ACE、敏感 deny-read；add/dispose） | `grant.ts` |
| `spawn.ts`/`stdio.ts` | `CreateProcessAsUserW`（受限令牌，piped stdio）+ **Job kill-on-close** + `drainPipe`；env（TEMP/TMP→私有 temp） | `process.ts` + `@deepseek-ai/dsh-win32-process`（改用 `CreateProcessAsUserW`，见落地差异） |
| `session.ts` | `createWinaclSession`（init 派生 SID/建令牌/授权；exec 受限 spawn pwsh；dispose **capture-and-restore** 恢复原始 ACL） | `index.ts`（`AclSandbox`，弃 standing 缓存） |

## 四、档位 → 语义（Windows pwsh，已实现）
| 档位 | restricting（cap SID） | ACE 授权 |
|---|---|---|
| `readonly` | `[logonSid, EVERYONE, readDenySid]` | 敏感路径 `denyRead`（用**用户 SID**，见落地差异）；无写 grant |
| `verify` | `[logonSid, EVERYONE, workspaceWriteSid, tempWriteSid, readDenySid]` | 工作区 `grantWrite` + `.git`/`.pi` `denyWrite` + 敏感 `denyRead` + 私有 temp `grantWrite` |

敏感目标复用 `src/config.ts` `SENSITIVE_HOME_DIRS`/`SENSITIVE_HOME_FILES`（映射 `%USERPROFILE%`，**排除宿主必需 `.pi`/`.config`/`.copilot`**）；子路径 re-allow（`.pi/agent/skills`、`.config/gh`）细粒度 deny 或文档化差异。

## 五、enforcement=partial（必须识别并报告）
`WRITE_RESTRICTED` 只相交写访问；保留 Everyone（进程初始化）、NTFS 硬链接可跨路径别名、同用户身份限制读——弱于 bwrap。进入 readonly/verify 时经 notice 明示（用户决策点）。

## 六、Windows 构建/验证
1. `npm install`（拉 koffi）。
2. 逐模块接 koffi，让 `winaclProbe()` 通过（koffi 加载 + OpenProcessToken + **一条 pwsh-under-token 冒烟** `pwsh -NoProfile -Command 'echo ok'` exit 0）。
3. 替换 `NoopSession` → 真实 `WinaclSession`。
4. `npm run typecheck` 全绿；**在真实 Windows 上 `npm run probe:winacl` 全 `✅`** 才启用。

## 七、fail-closed 铁律
任何 Win32 失败在 `init`/`exec` 即 throw（决不无限制 spawn）；`isSpawnable()===false` 上层抛错；`winaclProbe()` 未过 → 降级 supervised；`dispose()` 每个恢复聚合失败上报、不留持久 ACL 残渣。（与 dsh「child is never spawned unrestricted」一致。）

## 八、落地差异（真机实测 2026-08-22 · Win11 26200 · 必须报告）
1. **`CreateProcessWithTokenW` → `CreateProcessAsUserW`**：本机（MSYS/bash 下 node，High Integrity + SeImpersonate 可用）`CreateProcessWithTokenW` 恒 `ERROR_ACCESS_DENIED(5)`（含非受限令牌），故改用 `CreateProcessAsUserW`（dsh 亦用；需对当前令牌启用 `SeAssignPrimaryToken`/`SeIncreaseQuota`/`SeImpersonate`）。
2. **deny-read 用用户 SID**：受限令牌的 **restricting SID 只相交写访问，不门控读**（实测：`readDenySid` 作 restricting SPD + deny-read ACE 不能拦截读）。故真正的读拦截用**当前用户 SID** 的 deny-read ACE（`denyRead(userSid, path)`）——这会**临时限制宿主同用户**读凭据，属 enforcement=partial 的「同身份读限制」，经 notice 明示；`dispose` 恢复。`readDenySid()` 保留在 restricting 列表作防御层（对宿主无害）。
3. **capture-and-restore 清理**：`SetEntriesInAclW` 的 `REVOKE_ACCESS` **不删除 DENY ACE**（实测仅删除 ALLOW），若按 dsh 的 `revokeWrite` 会留残渣。故每次修改前 `saveAcl` 保存原始 DACL 字节，`dispose` 时 `applyAcl` 精确写回（不留持久残渣；无显式 DACL 的路径不动，避免剥继承）。
4. **弃 standing 刷 / 每会话重建**：工作区/temp/敏感路径的 ACE 每次会话建立，`dispose` 逐恢复（不保留跨会话 standing 缓存）。
5. **`overrideWinaclProbe` 测试接缝**：与 bwrap `overrideBwrapDetect` 同模式，供 `test/smoke.ts` 在 win32 上控制后端可用性（C2 降级用例）。
6. **敏感 readDenyTargets 排除宿主必需目录**：`.pi`/`.config`/`.copilot` 含 pi 自身 auth/config（宿主必需），不加入用户 SID deny-read；仅纯凭据存储（`.ssh`/`.aws`/`.gnupg`/`.kube`/`.docker`/`.netrc`/`.gitconfig`/`.bash_history`/`.npmrc`）被隐藏。

---

## 附：v3 → v4 设计演进史（2026-09 归档自根 AGENTS.md）

### v3 失败（真机证伪）
v3 目标「原生 Windows readonly/verify 走受限令牌（winacl）」在 **Windows 26200 + git bash（MSYS2）** 真机被证伪：
- `cmd.exe` under 受限令牌 ✅；**MSYS2 bash under 受限令牌 ❌**（`cygheap_user::init: NtSetInformationToken(TokenDefaultDacl), 0xC0000022`；挂起 `CreateFileMapping`）。
- 结论：受限令牌 × Cygwin/MSYS2 **固有不兼容**（Cygwin 初始化必须调 `NtSetInformationToken(TokenDefaultDacl)`，Windows 对任何受限令牌拒绝）。机制性冲突，非参数可绕过。

### 关键洞察：git bash 不是固定 shell
v3 隐含前提「Windows 沙箱 shell = git bash」不成立——pi 原生提供 **`powershell` 工具**（`createPowerShellTool`，与 bash 同款 `operations`/`spawnHook` 接缝；`PowerShellOperations = BashOperations`；`defaultTools` 可启用）。运行时 pi ≥0.84.4 导出 `createPowerShellTool`/`createLocalPowerShellOperations`（0.84.1 无）。

### v4（路线 X）结论
**原生 Windows readonly/verify 走 winacl，但沙箱 shell 用 pwsh**（`createPowerShellTool` 承载 `operations.exec`）；Linux/WSL2 走 bwrap。无 WSL2 依赖、无 `/mnt` 跨边界、原生 Windows。

### 三段式判定（路线 X）
1. **pi 原生机制** ✅：pi 无内置沙箱，但提供 `powershell` 工具 + `createPowerShellTool` 的 `operations`/`spawnHook` 接缝 + `defaultTools`/`setActiveTools`。零新 pi API。
2. **四家语义** ✅：受限令牌 + capability SID + NTFS ACE 写白名单（+deny-read）——dsh 真机 pwsh 实测；Codex 同族（deny-read 语义）；enforcement=partial。
3. **pi 裁剪** ✅：dsh 式 TS+koffi 免提权 + Codex deny-read（凭据隐藏）；**不引入提权 helper / WFP / 独立 logon 身份**。取舍明示：enforcement=partial（弱于 bwrap）；Windows 沙箱档只能用 pwsh（bash 被移除）。

**后置**：win32 原生 FFI 须在真实 Windows 自检（含 pwsh-under-token 冒烟）通过才启用；否则 fail-closed 降级 supervised。
