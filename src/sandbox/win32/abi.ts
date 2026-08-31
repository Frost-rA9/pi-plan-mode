/**
 * pi-planbuild v4（路线 X）· winacl：Win32 进程/令牌/ACL 常量（x64 实测对齐）。
 * 来源：dsh `win32-abi.ts` + `subprocess/win32-process/src/abi.ts`（Win11 26200 实测）。
 */

/* ------------------------------ 进程 / Job / 管道 ------------------------------ */

/** STARTUPINFOW 使用标准输入/输出/错误句柄。 */
export const STARTF_USESTDHANDLES = 0x00000100;
/** HandleInformation 允许子进程继承的位。 */
export const HANDLE_FLAG_INHERIT = 0x1;
/** WaitForSingleObject 无限超时。 */
export const INFINITE = 0xffffffff;
/** CreateProcess 标志：resume 前不运行用户代码。 */
export const CREATE_SUSPENDED = 0x4;
/** GetStdHandle 标准输入选择器。 */
export const STD_INPUT_HANDLE = -10;
/** GetStdHandle 标准输出选择器。 */
export const STD_OUTPUT_HANDLE = -11;
/** GetStdHandle 标准错误选择器。 */
export const STD_ERROR_HANDLE = -12;
/** FormatMessage 读取系统消息表。 */
export const FORMAT_MESSAGE_FROM_SYSTEM = 0x00001000;
/** FormatMessage 忽略插入占位符。 */
export const FORMAT_MESSAGE_IGNORE_INSERTS = 0x00000200;
/** 调用者提供的缓冲区太小。 */
export const ERROR_INSUFFICIENT_BUFFER = 122;
/** 管道对端关闭。 */
export const ERROR_BROKEN_PIPE = 109;
/** 管道无剩余数据。 */
export const ERROR_NO_DATA = 232;
/** Job 限制：最终 Job 句柄关闭时终止全部成员。 */
export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
/** SetInformationJobObject 类（JOBOBJECT_EXTENDED_LIMIT_INFORMATION）。 */
export const JobObjectExtendedLimitInformation = 9;
/** x64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION 字节大小。 */
export const JOBOBJECT_EXTENDED_LIMIT_SIZE = 144;
/** 扩展 Job 记录中 BasicLimitInformation.LimitFlags 的字节偏移。 */
export const JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET = 16;
/** x64 STARTUPINFOW 字节大小（原生探针验证）。 */
export const STARTUPINFOW_SIZE = 104;
/** x64 PROCESS_INFORMATION 字节大小（原生探针验证）。 */
export const PROCESS_INFORMATION_SIZE = 24;

/* ------------------------------ 令牌 / ACL ------------------------------ */

/** OpenProcess 查询当前进程令牌所需的访问权。 */
export const PROCESS_QUERY_INFORMATION = 0x0400;
/** CreateProcessWithTokenW 所需的令牌权。 */
export const TOKEN_ASSIGN_PRIMARY = 0x0001;
/** DuplicateTokenEx 所需。 */
export const TOKEN_DUPLICATE = 0x0002;
/** 读取令牌信息所需。 */
export const TOKEN_QUERY = 0x0008;
/** 替换令牌默认 DACL 所需。 */
export const TOKEN_ADJUST_DEFAULT = 0x0080;
/** 标识令牌登录 SID 的组属性。 */
export const SE_GROUP_LOGON_ID = 0xc0000000;
/** 从写能力授权中排除的标准权位。 */
export const STANDARD_RIGHTS_WRITE = 0x00020000;
/** 通用文件写访问位。 */
export const FILE_GENERIC_WRITE = 0x00120116;
/** 删除或重命名对象。 */
export const DELETE = 0x00010000;
/** 删除或重命名目录子项。 */
export const FILE_DELETE_CHILD = 0x0040;
/**
 * capability-SID 访问掩码：写 + 删除 + 子删除。
 * 排除 WRITE_DAC / WRITE_OWNER，受限子进程不能改 DACL 或接管所有权逃逸。
 */
export const GRANT_MASK = (FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD) & ~STANDARD_RIGHTS_WRITE;
/** 受限令牌默认 DACL 使用的完全访问。 */
export const FILE_ALL_ACCESS = 0x1f01ff;
/** CreateRestrictedToken 标志：禁用最大特权。 */
export const DISABLE_MAX_PRIVILEGE = 0x1;
/** CreateRestrictedToken 受限用户标志。 */
export const LUA_TOKEN = 0x4;
/** 仅将写访问限制到列出的 restricting SID。 */
export const WRITE_RESTRICTED = 0x8;
/** WELL_KNOWN_SID_TYPE：Everyone。 */
export const WinWorldSid = 1;
/** TOKEN_INFORMATION_CLASS：TokenUser。 */
export const TokenUser = 1;
/** TOKEN_INFORMATION_CLASS：TokenGroups。 */
export const TokenGroups = 2;
/** TOKEN_INFORMATION_CLASS：TokenDefaultDacl。 */
export const TokenDefaultDacl = 6;
/** SECURITY_INFORMATION 选择 DACL。 */
export const DACL_SECURITY_INFORMATION = 0x00000004;
/** SE_OBJECT_TYPE：文件系统对象。 */
export const SE_FILE_OBJECT = 1;
/** TRUSTEE_TYPE：未知分类。 */
export const TRUSTEE_IS_UNKNOWN = 0;
/** TRUSTEE_FORM：SID 指针。 */
export const TRUSTEE_IS_SID = 0;
/** Trustee 无链式。 */
export const NO_MULTIPLE_TRUSTEE = 0;
/** EXPLICIT_ACCESS 授权。 */
export const GRANT_ACCESS = 1;
/** EXPLICIT_ACCESS 设置。 */
export const SET_ACCESS = 2;
/** EXPLICIT_ACCESS 拒绝。 */
export const DENY_ACCESS = 3;
/** EXPLICIT_ACCESS 撤销。 */
export const REVOKE_ACCESS = 4;
/** ACE 继承标志：子容器与对象。 */
export const SUB_CONTAINERS_AND_OBJECTS_INHERIT = 0x3;
/** 传统 Win32 最大路径。 */
export const MAX_PATH = 260;
/** 成功状态码。 */
export const ERROR_SUCCESS = 0;
/** 立即字节范围锁失败。 */
export const ERROR_LOCK_VIOLATION = 33;
/** 通用读访问位。 */
export const GENERIC_READ = 0x80000000;
/** 通用写访问位。 */
export const GENERIC_WRITE = 0x40000000;
/** CreateFile 共享读标志。 */
export const FILE_SHARE_READ = 0x00000001;
/** CreateFile 共享写标志。 */
export const FILE_SHARE_WRITE = 0x00000002;
/** CreateFile 共享删标志。 */
export const FILE_SHARE_DELETE = 0x00000004;
/** CreateFile 打开或创建。 */
export const OPEN_ALWAYS = 4;
/** LockFileEx 独占锁。 */
export const LOCKFILE_EXCLUSIVE_LOCK = 0x2;
/** LockFileEx 立即失败。 */
export const LOCKFILE_FAIL_IMMEDIATELY = 0x1;
/** 允许访问 ACE 类型。 */
export const ACCESS_ALLOWED_ACE_TYPE = 0;
/** 拒绝访问 ACE 类型。 */
export const ACCESS_DENIED_ACE_TYPE = 1;
/** SID 最大子权威数。 */
export const SID_MAX_SUB_AUTHORITIES = 15;
/** 标记继承 ACE 的位。 */
export const INHERITED_ACE = 0x10;
/** SID 最大分配字节数。 */
export const SECURITY_MAX_SID_SIZE = 68;
/** x64 SID_AND_ATTRIBUTES 字节大小。 */
export const SID_AND_ATTRIBUTES_SIZE = 16;
/** x64 TOKEN_GROUPS 首个组条目偏移。 */
export const TOKEN_GROUPS_OFFSET = 8;
/** x64 EXPLICIT_ACCESS_W 字节大小。 */
export const EXPLICIT_ACCESS_W_SIZE = 48;
/** x64 TRUSTEE_W 在 EXPLICIT_ACCESS_W 内偏移。 */
export const TRUSTEE_W_OFFSET = 16;
/** x64 ptstrName 在 TRUSTEE_W 内偏移。 */
export const TRUSTEE_W_PTSTRNAME_OFFSET = 24;
