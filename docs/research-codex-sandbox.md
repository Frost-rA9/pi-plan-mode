# Codex 沙箱架构调研（2026-09-04，vs pi-plan-mode）

> 调研对象：`openai/codex`（`~/projects/codex`，更新至 9 月初）。
> 本文件记录与 pi-plan-mode 的对照结论，供设计取舍参考；不随代码改动频繁更新。

## 一、Codex Linux 沙箱：bwrap 为主，landlock 仅遗留

**事实（源码实证）**：
- `codex-rs/linux-sandbox/src/bwrap.rs` 开头注释："**Filesystem restrictions are enforced by bubblewrap**"。
- `codex-rs/linux-sandbox/src/landlock.rs` 开头注释："**Landlock helpers remain available here as legacy/backup utilities**"。
- README："WSL2 uses the normal Linux bubblewrap path"。

**组成**（三层组合而非对立）：
```
codex Linux 沙箱 =
  ├─ 层1 文件系统视图：bubblewrap（只读基座 + 显式可写根 + .git/.codex 敏感子路径保持只读）
  ├─ 层2 进程内收紧：no_new_privs + seccomp（exec 前应用）
  └─ 层3（遗留）landlock：仅 bwrap 不可用时 fallback
```

**对 pi-plan-mode 的意义**：
- pi 的 bwrap 方案与 codex **同源主流**（不是"landlock 派"）——架构选择正确。
- codex 在 bwrap 之上有 **seccomp + no_new_privs** 纵深防御；pi 的 bwrap **无 syscall 层**（网络仅 `--share-net`/`--unshare-net` 开关）。
- landlock 对 pi **无价值**：bwrap 可用时冗余；不可用时 pi 是 fail-closed 降级（不 fallback 到 landlock，符合 pi 哲学）。

## 二、Codex Windows 沙箱：服务化（区别于 pi 的会话级）

**9 月初 13 提交大簇**：`windows-sandbox-service` + `windows-sandbox-rs`：
- **机器级服务**（`setup_main` 提权路径 + `command_runner` 受控进程），versioned 命名管道协议 + 认证（验证管道服务属于运行中的 `CodexSandboxService`）。
- 组件：`deny_read_walker.rs`（glob matcher 快照遍历）、`read_acl_mutex.rs`（并发保护）、`deny_read_resolver.rs`、`resolve_permissions.rs`。
- 区分：**请求的是"服务管理沙箱生命周期"，pi 是"会话内创建/撤销"**。

## 三、P2 评估修正：deny_read_walker 对 pi **无价值**

### 原判断（调研前）
"winacl deny-read 应精细化（walk 递归，不整目录 deny）——Codex 已验证方向"。

### 深入源码后的修正
- **Codex 的 walker 是为「用户自定义 glob 模式」服务**（`ReadDenyMatcher`：`*.env`、`~/**/.env`、`~/.ssh/**` 等），带 `glob_scan_max_depth` 深度上限。
- **pi 是固定清单**（`SENSITIVE_HOME_DIRS`/`SENSITIVE_HOME_FILES`），不需要模式引擎——照搬 walker = 为不存在的需求引入 glob 子系统（违反核心小）。

### pi 的真实状况（审查结论）
| 检查项 | 结论 |
|---|---|
| `win32SensitivePaths` 含文件？ | ✅ 已含 `SENSITIVE_HOME_FILES`（`.gitconfig`/`.bash_history`/`.netrc`/`.npmrc`） |
| `readDenyTargets` 排除宿主必需？ | ✅ excluded 正则正确（`.pi`/`.config`/`.copilot` 排除） |
| ACE 继承？ | ✅ `buildExplicitAccess` 已设 `SUB_CONTAINERS_AND_OBJECTS_INHERIT`（OI|CI） |
| **verify 档 `.git/.pi` 写保护单源？** | **❌ 修复前硬编码 `[".git", ".pi"]`（未用 `WORKSPACE_RO_SUBPATHS`）→ 已修正单源** |
| **deny-read 真机自检？** | ❌ `probe:winacl` 只测 pwsh-under-token 冒烟，**不测 deny-read 拦截**——Windows 真机待补 |

## 四、结论

1. **P2（walker 照搬）取消**——架构不匹配，无价值反增复杂度。
2. **实际缺口已修**：verify 档写保护路径单源化（`WORKSPACE_RO_SUBPATHS`）。
3. **遗留（Windows 真机）**：probe 自检补 deny-read 生效断言（受限 token 读 `~/.ssh/` 应失败）。
4. **可选深防（暂缓）**：pi bwrap 加 seccomp + no_new_privs 纵深层（codex 同款），成本小收益明确，但不影响主路径。

---

## 五、P4（win32 路径转换边界修正）——待 Windows 环境

**来源**：codex `7a7c188` "Preserve target-native paths in command approvals"——批准请求保留执行目标原生路径（PathUri），不转换 host 路径；native-path helpers 须 executor-aware（接收 `FileSystemSandboxPolicyContext`）。

**对 pi 的意义**：`normalizeShellPath` 在 win32/宿主间转换（`/c/Users/x/bash.exe` ↔ `C:\Users\x\bash.exe`），转换可能引入边界模糊（`/mnt/c/...` vs `C:\...` 判定不一致）。

**状态**：**暂缓**。Windows 宿主机系统重装后尚未安装 pi/pi-plan-mode 环境，无法真机验证——此修正须在真实 Windows 环境调试（无真机验证的路径转换修改更危险）。
