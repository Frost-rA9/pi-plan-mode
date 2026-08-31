# pi-planbuild v4（路线 X）· winacl 后端落地（Phase 2）指南

> 面向**有真实 Windows 环境**的开发者。目标：把 `src/sandbox/win32/` 从 fail-closed seam 补完为
> **真实可用的 Windows OS 只读沙箱**（readonly/verify，**沙箱 shell = pwsh**），并用 `npm run probe:winacl` 自检通过后自动启用。
> 在此之前，`winaclProbe()` 恒为 false → readonly/verify 降级 `supervised`（安全，决不无限制 spawn）。

## 一、现状与目标
| 项 | 现状 | 目标 |
|---|---|---|
| `winaclProbe()` | 恒 false（占位 selfTest） | koffi 加载 + 建受限令牌 + **pwsh-under-token 冒烟** 通过才 true |
| `createWinaclSession()` | 返回 `NoopSession` | 返回真实 `WinaclSession` |
| Windows readonly/verify | 降级 `supervised` | 走真实受限令牌 + NTFS ACE 沙箱（pwsh） |

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
| `spawn.ts`/`stdio.ts` | `CreateProcessWithTokenW`（受限令牌，piped stdio）+ **Job kill-on-close** + `drainPipe`；env（TEMP/TMP→私有 temp） | `spawn.ts` + `@deepseek-ai/dsh-win32-process` |
| `session.ts` | `createWinaclSession`（init 派生 SID/建令牌/授权；exec 受限 spawn pwsh；dispose 撤销） | `index.ts`（`AclSandbox`） |

## 四、档位 → 语义（Windows pwsh）
| 档位 | restricting（cap SID） | ACE 授权 |
|---|---|---|
| `readonly` | `[logonSid, EVERYONE, readDenySid]` | 敏感路径 `denyRead(readDenySid)`；无写 grant |
| `verify` | `[logonSid, EVERYONE, workspaceWriteSid, tempWriteSid, readDenySid]` | 工作区 `grantWrite` + `.git`/`.pi` `denyWrite` + 敏感 `denyRead` + 私有 temp `grantWrite` |

敏感目标复用 `src/config.ts` `SENSITIVE_HOME_DIRS`/`SENSITIVE_HOME_FILES`（映射 `%USERPROFILE%`）；子路径 re-allow（`.pi/agent/skills`、`.config/gh`）细粒度 deny 或文档化差异。

## 五、enforcement=partial（必须识别并报告）
`WRITE_RESTRICTED` 只相交写访问；保留 Everyone（进程初始化）、NTFS 硬链接可跨路径别名、同用户身份限制读——弱于 bwrap。进入 readonly/verify 时经 notice 明示（用户决策点）。

## 六、Windows 构建/验证
1. `npm install`（拉 koffi）。
2. 逐模块接 koffi，让 `winaclProbe()` 通过（koffi 加载 + OpenProcessToken + **一条 pwsh-under-token 冒烟** `pwsh -NoProfile -Command 'echo ok'` exit 0）。
3. 替换 `NoopSession` → 真实 `WinaclSession`。
4. `npm run typecheck` 全绿；**在真实 Windows 上 `npm run probe:winacl` 全 `✅`** 才启用。

## 七、fail-closed 铁律
任何 Win32 失败在 `init`/`exec` 即 throw（决不无限制 spawn）；`isSpawnable()===false` 上层抛错；`winaclProbe()` 未过 → 降级 supervised；`dispose()` 每个撤销聚合失败上报、不留持久 ACL 残渣。（与 dsh「child is never spawned unrestricted」一致。）
