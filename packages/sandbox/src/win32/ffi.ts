/**
 * pi-planbuild v4（路线 X）· winacl：自包含 koffi 绑定（进程 + 令牌 + ACL）+ alloc/decode 助手。
 * 不依赖 `@deepseek-ai/dsh-win32-process`（本方案裁剪为单文件绑定表）。
 * 每个 Win32 调用经 `bindings()` 惰性加载，任一失败抛 `Win32Error`（API 名 + 精确代码）。
 */

import koffi from "koffi";
import * as abi from "./abi.ts";

declare const nativePtr: unique symbol;
/** koffi 原生指针品牌类型（避免误当数字用）。 */
export type NativePtr = bigint & { readonly [nativePtr]: true };

type Ptr = ReturnType<typeof koffi.pointer>;
type KoffiStruct = ReturnType<typeof koffi.struct>;

// koffi 类型注册是**全局命名表**：同名字（PIB_STARTUPINFOW 等）二次注册即抛「Duplicate type name」。
// jiti/loader 下模块可能被多次加载，顶层直接注册会崩；故统一惰性注册（ensureTypes 幂等），
// 且 win32 原语只在真正使用（bindings 调用 / Windows 自检 / runner 子进程）时才注册。
let PVOID!: Ptr;
let PPVOID!: Ptr;
let STARTUPINFOW!: KoffiStruct;
let PROCESS_INFORMATION!: KoffiStruct;
let typesEnsured = false;

function ensureTypes(): void {
  if (typesEnsured) return;
  typesEnsured = true;
  PVOID = koffi.pointer("void");
  PPVOID = koffi.pointer(PVOID);
  STARTUPINFOW = koffi.struct("PIB_STARTUPINFOW", {
    cb: "uint32",
    lpReserved: "str16",
    lpDesktop: "str16",
    lpTitle: "str16",
    dwX: "uint32",
    dwY: "uint32",
    dwXSize: "uint32",
    dwYSize: "uint32",
    dwXCountChars: "uint32",
    dwYCountChars: "uint32",
    dwFillAttribute: "uint32",
    dwFlags: "uint32",
    wShowWindow: "uint16",
    cbReserved2: "uint16",
    lpReserved2: koffi.pointer("uint8"),
    hStdInput: PVOID,
    hStdOutput: PVOID,
    hStdError: PVOID,
  });
  PROCESS_INFORMATION = koffi.struct("PIB_PROCESS_INFORMATION", {
    hProcess: PVOID,
    hThread: PVOID,
    dwProcessId: "uint32",
    dwThreadId: "uint32",
  });
  /* v8 ignore start -- ABI 守卫由原生头探针固定。 */
  if (STARTUPINFOW.size !== abi.STARTUPINFOW_SIZE) {
    throw new Error(`STARTUPINFOW layout mismatch: koffi computed ${STARTUPINFOW.size}, expected ${abi.STARTUPINFOW_SIZE}`);
  }
  if (PROCESS_INFORMATION.size !== abi.PROCESS_INFORMATION_SIZE) {
    throw new Error(`PROCESS_INFORMATION layout mismatch: koffi computed ${PROCESS_INFORMATION.size}, expected ${abi.PROCESS_INFORMATION_SIZE}`);
  }
  /* v8 ignore stop */
}

/* ------------------------------ 错误 ------------------------------ */

/** Win32 调用失败（精确 API 名 + 错误码）。 */
export class Win32Error extends Error {
  readonly api: string;
  readonly win32Code: number;

  constructor(api: string, win32Code: number, detail?: string) {
    super(`${api} failed (Win32 ${win32Code})${detail === undefined ? "" : `: ${detail}`}`);
    this.name = "Win32Error";
    this.api = api;
    this.win32Code = win32Code;
  }
}

/* ------------------------------ 结构（koffi struct） ------------------------------ */

/** STARTUPINFOW 字段（用于继承/管道 stdio）。 */
export interface StartupInfoInput {
  cb: number;
  dwFlags: number;
  hStdInput: NativePtr;
  hStdOutput: NativePtr;
  hStdError: NativePtr;
}

/** 解码后的 PROCESS_INFORMATION。 */
export interface ProcessInfoOutput {
  hProcess: NativePtr | null;
  hThread: NativePtr | null;
  dwProcessId: number;
  dwThreadId: number;
}

/** koffi STARTUPINFOW 布局（x64，原生探针验证）。参见 ensureTypes() 惰性注册。 */
/** koffi PROCESS_INFORMATION 布局（x64）。参见 ensureTypes() 惰性注册。 */

/* ------------------------------ 绑定表接口 ------------------------------ */

/** 通用 Win32 进程/令牌/ACL 调用（被受限令牌沙箱消耗）。 */
export interface Win32Bindings {
  // 进程/句柄
  closeHandle(handle: NativePtr): number;
  getLastError(): number;
  formatMessageW(
    flags: number,
    source: null,
    messageId: number,
    languageId: number,
    buffer: Buffer,
    size: number,
    args: null,
  ): number;

  // 管道
  createPipe(readHandle: NativePtr, writeHandle: NativePtr, attributes: null, size: number): number;
  setHandleInformation(handle: NativePtr, mask: number, flags: number): number;
  readFile(file: NativePtr, buffer: Buffer, count: number, bytesRead: NativePtr, overlapped: null): number;
  peekNamedPipe(
    pipe: NativePtr,
    buffer: null,
    size: number,
    bytesRead: NativePtr | null,
    totalAvail: NativePtr,
    leftThisMessage: NativePtr | null,
  ): number;

  // 进程创建（受限令牌）
  createProcessWithTokenW(
    token: NativePtr,
    logonFlags: number,
    applicationName: string | null,
    commandLine: string,
    creationFlags: number,
    environment: null,
    currentDirectory: string | null,
    startupInfo: NativePtr,
    processInfo: NativePtr,
  ): number;
  createProcessAsUserW(
    token: NativePtr,
    applicationName: string | null,
    commandLine: string,
    processAttributes: null,
    threadAttributes: null,
    inheritHandles: number,
    creationFlags: number,
    environment: null,
    currentDirectory: string | null,
    startupInfo: NativePtr,
    processInfo: NativePtr,
  ): number;

  // 等待/退出
  waitForSingleObject(handle: NativePtr, milliseconds: number): number;
  getExitCodeProcess(process: NativePtr, exitCode: NativePtr): number;
  terminateProcess(process: NativePtr, exitCode: number): number;

  // Job
  createJobObjectW(attributes: null, name: null): NativePtr;
  setInformationJobObject(job: NativePtr, cls: number, information: Buffer, length: number): number;
  assignProcessToJobObject(job: NativePtr, process: NativePtr): number;
  resumeThread(thread: NativePtr): number;
  getStdHandle(stdHandle: number): NativePtr;

  // 令牌
  openProcess(desiredAccess: number, inheritHandle: number, pid: number): NativePtr;
  openProcessToken(process: NativePtr, desiredAccess: number, tokenHandle: NativePtr): number;
  duplicateTokenEx(
    existing: NativePtr,
    desiredAccess: number,
    attributes: null,
    impersonationLevel: number,
    tokenType: number,
    newToken: NativePtr,
  ): number;
  adjustTokenPrivileges(
    token: NativePtr,
    disableAll: number,
    newState: Buffer,
    bufferLength: number,
    previousState: NativePtr,
    returnLength: NativePtr,
  ): number;
  lookupPrivilegeValueW(systemName: string | null, name: string, luid: NativePtr): number;

  // SID
  convertStringSidToSidW(stringSid: string, sid: NativePtr): number;
  createWellKnownSid(type: number, domainSid: null, sid: NativePtr, size: NativePtr): number;
  isValidSid(sid: NativePtr): number;
  getLengthSid(sid: NativePtr): number;
  copySid(length: number, destination: NativePtr, source: NativePtr): number;

  // 令牌信息
  getTokenInformation(token: NativePtr, cls: number, info: Buffer | null, length: number, needed: NativePtr): number;
  setTokenInformation(token: NativePtr, cls: number, info: Buffer, length: number): number;
  createRestrictedToken(
    existing: NativePtr,
    flags: number,
    disableCount: number,
    disableSids: null,
    deletePrivilegeCount: number,
    privilegesToDelete: null,
    restrictCount: number,
    restrictingSids: Buffer,
    newToken: NativePtr,
  ): number;

  // 内存
  localAlloc(flags: number, bytes: number): NativePtr;
  localFree(memory: NativePtr): NativePtr;

  // ACL
  setEntriesInAclW(count: number, entries: Buffer, oldAcl: NativePtr | null, newAcl: NativePtr): number;
  setNamedSecurityInfoW(
    path: string,
    objectType: number,
    information: number,
    owner: null,
    group: null,
    dacl: NativePtr | null,
    sacl: null,
  ): number;
  getNamedSecurityInfoW(
    path: string,
    objectType: number,
    information: number,
    owner: NativePtr,
    group: NativePtr,
    dacl: NativePtr,
    sacl: NativePtr,
    descriptor: NativePtr,
  ): number;

  // 路径/temp
  getTempPathW(length: number, buffer: Buffer): number;
  setEnvironmentVariableW(name: string, value: string): number;

  // 文件锁
  createFileW(
    fileName: string,
    desiredAccess: number,
    shareMode: number,
    attributes: null,
    creationDisposition: number,
    flagsAndAttributes: number,
    templateFile: null,
  ): NativePtr;
  lockFileEx(
    file: NativePtr,
    flags: number,
    reserved: number,
    bytesLow: number,
    bytesHigh: number,
    overlapped: NativePtr,
  ): number;
  unlockFileEx(file: NativePtr, reserved: number, bytesLow: number, bytesHigh: number, overlapped: NativePtr): number;
}

/* ------------------------------ alloc / decode ------------------------------ */

/** 分配一个指针大小的 out 参数槽。 */
export function allocPtrSlot(): NativePtr {
  return koffi.alloc(PVOID, 1) as NativePtr;
}

/** 分配一个 uint32 out 参数槽。 */
export function allocUint32(): NativePtr {
  return koffi.alloc("uint32", 1) as NativePtr;
}

/** 分配一块原始字节。 */
export function allocBytes(length: number): NativePtr {
  return koffi.alloc("uint8", length) as NativePtr;
}

/** 分配一块全零 x64 OVERLAPPED（32 字节）。 */
export function allocOverlapped(): NativePtr {
  return allocBytes(32);
}

/** 解码指针 out 参数。 */
export function decodePtr(slot: NativePtr): NativePtr | null {
  const value = koffi.decode(slot, PVOID) as NativePtr | null;
  return isNullPtr(value) ? null : value;
}

/** 解码 uint32 out 参数。 */
export function decodeUint32(slot: NativePtr): number {
  return koffi.decode(slot, "uint32") as number;
}

/** 从 Buffer 字段解码一个指针值。 */
export function decodePtrAt(buffer: Buffer, offset: number): NativePtr | null {
  const value = koffi.decode(buffer, offset, PVOID) as NativePtr | null;
  return isNullPtr(value) ? null : value;
}

/** 从原生记录字段解码 uint8。 */
export function decodeUint8At(ptr: NativePtr, offset: number): number {
  return koffi.decode(ptr, offset, "uint8") as number;
}

/** 从原生记录字段解码 uint16。 */
export function decodeUint16At(ptr: NativePtr, offset: number): number {
  return koffi.decode(ptr, offset, "uint16") as number;
}

/** 从原生记录字段解码 uint32。 */
export function decodeUint32At(ptr: NativePtr, offset: number): number {
  return koffi.decode(ptr, offset, "uint32") as number;
}

/** 将 uint32 编码进分配的槽。 */
export function encodeUint32(slot: NativePtr, value: number): void {
  koffi.encode(slot, "uint32", value);
}

/** 返回 koffi 指针的数字地址。 */
export function ptrAddress(ptr: NativePtr): bigint {
  return koffi.address(ptr);
}

/** 分配一个全零 STARTUPINFOW。 */
export function allocStartupInfo(): NativePtr {
  return koffi.alloc(STARTUPINFOW, 1) as NativePtr;
}

/** 编码需要 stdio 的 STARTUPINFOW 字段。 */
export function encodeStartupInfo(startupInfo: NativePtr, fields: StartupInfoInput): void {
  koffi.encode(startupInfo, STARTUPINFOW, fields);
}

/** 分配一个全零 PROCESS_INFORMATION。 */
export function allocProcessInfo(): NativePtr {
  return koffi.alloc(PROCESS_INFORMATION, 1) as NativePtr;
}

/** 解码 PROCESS_INFORMATION。 */
export function decodeProcessInfo(processInfo: NativePtr): ProcessInfoOutput {
  return koffi.decode(processInfo, PROCESS_INFORMATION) as ProcessInfoOutput;
}

/** 是否为本机指针。 */
export function isNullPtr(value: NativePtr | null | undefined): value is null | undefined {
  return value === null || value === undefined || (value as bigint) === 0n;
}

/** 是否无效句柄（null/0/全 1 哨兵）。 */
export function isInvalidHandle(handle: NativePtr | null | undefined): boolean {
  if (isNullPtr(handle)) return true;
  return (handle as bigint) === 0xffffffffffffffffn || (handle as bigint) === -1n;
}

/* ------------------------------ SID 比较 ------------------------------ */

/** 比较两个内存中的 SID 记录，不分配字符串。 */
export function sameSidAt(left: NativePtr, leftOffset: number, right: NativePtr, rightOffset: number): boolean {
  if (decodeUint8At(left, leftOffset) !== decodeUint8At(right, rightOffset)) return false;
  const leftCount = decodeUint8At(left, leftOffset + 1);
  const rightCount = decodeUint8At(right, rightOffset + 1);
  if (leftCount !== rightCount || leftCount > abi.SID_MAX_SUB_AUTHORITIES) return false;
  for (let index = 0; index < 6; index += 1) {
    if (decodeUint8At(left, leftOffset + 2 + index) !== decodeUint8At(right, rightOffset + 2 + index)) {
      return false;
    }
  }
  for (let index = 0; index < leftCount; index += 1) {
    if (decodeUint32At(left, leftOffset + 8 + index * 4) !== decodeUint32At(right, rightOffset + 8 + index * 4)) {
      return false;
    }
  }
  return true;
}

/* ------------------------------ 绑定表缓存 ------------------------------ */

let cached: Win32Bindings | undefined;

function bindings(): Win32Bindings {
  if (cached !== undefined) return cached;
  ensureTypes();
  const kernel32 = koffi.load("kernel32.dll");
  const advapi32 = koffi.load("advapi32.dll");
  const bind = (lib: ReturnType<typeof koffi.load>, name: string, result: Ptr | string, args: Array<Ptr | string>): unknown =>
    lib.func("__stdcall", name, result, args);
  cached = {
    // 进程/句柄
    closeHandle: bind(kernel32, "CloseHandle", "int", [PVOID]),
    getLastError: bind(kernel32, "GetLastError", "uint32", []),
    formatMessageW: bind(kernel32, "FormatMessageW", "uint32", [
      "uint32", PVOID, "uint32", "uint32", PVOID, "uint32", PVOID,
    ]),
    // 管道
    createPipe: bind(kernel32, "CreatePipe", "int", [PPVOID, PPVOID, PVOID, "uint32"]),
    setHandleInformation: bind(kernel32, "SetHandleInformation", "int", [PVOID, "uint32", "uint32"]),
    readFile: bind(kernel32, "ReadFile", "int", [PVOID, PVOID, "uint32", koffi.pointer("uint32"), PVOID]),
    peekNamedPipe: bind(kernel32, "PeekNamedPipe", "int", [
      PVOID, PVOID, "uint32", koffi.pointer("uint32"), koffi.pointer("uint32"), koffi.pointer("uint32"),
    ]),
    // 进程创建（受限令牌）
    createProcessWithTokenW: bind(advapi32, "CreateProcessWithTokenW", "int", [
      PVOID, "uint32", "str16", "str16", "uint32", PVOID, "str16",
      koffi.pointer(STARTUPINFOW), koffi.pointer(PROCESS_INFORMATION),
    ]),
    createProcessAsUserW: bind(advapi32, "CreateProcessAsUserW", "int", [
      PVOID, "str16", "str16", PVOID, PVOID, "int", "uint32", PVOID, "str16",
      koffi.pointer(STARTUPINFOW), koffi.pointer(PROCESS_INFORMATION),
    ]),
    // 等待/退出
    waitForSingleObject: bind(kernel32, "WaitForSingleObject", "uint32", [PVOID, "uint32"]),
    getExitCodeProcess: bind(kernel32, "GetExitCodeProcess", "int", [PVOID, koffi.pointer("uint32")]),
    terminateProcess: bind(kernel32, "TerminateProcess", "int", [PVOID, "uint32"]),
    // Job
    createJobObjectW: bind(kernel32, "CreateJobObjectW", PVOID, [PVOID, "str16"]),
    setInformationJobObject: bind(kernel32, "SetInformationJobObject", "int", [PVOID, "int", PVOID, "uint32"]),
    assignProcessToJobObject: bind(kernel32, "AssignProcessToJobObject", "int", [PVOID, PVOID]),
    resumeThread: bind(kernel32, "ResumeThread", "uint32", [PVOID]),
    getStdHandle: bind(kernel32, "GetStdHandle", PVOID, ["int"]),
    // 令牌
    openProcess: bind(kernel32, "OpenProcess", PVOID, ["uint32", "int", "uint32"]),
    openProcessToken: bind(advapi32, "OpenProcessToken", "int", [PVOID, "uint32", PPVOID]),
    duplicateTokenEx: bind(advapi32, "DuplicateTokenEx", "int", [PVOID, "uint32", PVOID, "int", "int", PPVOID]),
    adjustTokenPrivileges: bind(advapi32, "AdjustTokenPrivileges", "int", [
      PVOID, "int", PVOID, "uint32", PVOID, PVOID,
    ]),
    lookupPrivilegeValueW: bind(advapi32, "LookupPrivilegeValueW", "int", ["str16", "str16", koffi.pointer("uint64")]),
    // SID
    convertStringSidToSidW: bind(advapi32, "ConvertStringSidToSidW", "int", ["str16", PPVOID]),
    createWellKnownSid: bind(advapi32, "CreateWellKnownSid", "int", [
      "int", PVOID, PVOID, koffi.pointer("uint32"),
    ]),
    isValidSid: bind(advapi32, "IsValidSid", "int", [PVOID]),
    getLengthSid: bind(advapi32, "GetLengthSid", "uint32", [PVOID]),
    copySid: bind(advapi32, "CopySid", "int", ["uint32", PVOID, PVOID]),
    // 令牌信息
    getTokenInformation: bind(advapi32, "GetTokenInformation", "int", [
      PVOID, "int", PVOID, "uint32", koffi.pointer("uint32"),
    ]),
    setTokenInformation: bind(advapi32, "SetTokenInformation", "int", [PVOID, "int", PVOID, "uint32"]),
    createRestrictedToken: bind(advapi32, "CreateRestrictedToken", "int", [
      PVOID, "uint32", "uint32", PVOID, "uint32", PVOID, "uint32", PVOID, PPVOID,
    ]),
    // 内存
    localAlloc: bind(kernel32, "LocalAlloc", PVOID, ["uint32", "size_t"]),
    localFree: bind(kernel32, "LocalFree", PVOID, [PVOID]),
    // ACL
    setEntriesInAclW: bind(advapi32, "SetEntriesInAclW", "uint32", ["uint32", PVOID, PVOID, PPVOID]),
    setNamedSecurityInfoW: bind(advapi32, "SetNamedSecurityInfoW", "uint32", [
      "str16", "int", "uint32", PVOID, PVOID, PVOID, PVOID,
    ]),
    getNamedSecurityInfoW: bind(advapi32, "GetNamedSecurityInfoW", "uint32", [
      "str16", "int", "uint32", PPVOID, PPVOID, PPVOID, PPVOID, PPVOID,
    ]),
    // 路径/temp
    getTempPathW: bind(kernel32, "GetTempPathW", "uint32", ["uint32", PVOID]),
    setEnvironmentVariableW: bind(kernel32, "SetEnvironmentVariableW", "int", ["str16", "str16"]),
    // 文件锁
    createFileW: bind(kernel32, "CreateFileW", PVOID, [
      "str16", "uint32", "uint32", PVOID, "uint32", "uint32", PVOID,
    ]),
    lockFileEx: bind(kernel32, "LockFileEx", "int", [
      PVOID, "uint32", "uint32", "uint32", "uint32", PVOID,
    ]),
    unlockFileEx: bind(kernel32, "UnlockFileEx", "int", [
      PVOID, "uint32", "uint32", "uint32", PVOID,
    ]),
  } as unknown as Win32Bindings;
  return cached;
}

/** 缓存绑定表（异步返回）。 */
export function win32(): Promise<Win32Bindings> {
  return Promise.resolve(bindings());
}

/** 缓存绑定表（同步返回）。 */
export function win32Sync(): Win32Bindings {
  return bindings();
}

/* ------------------------------ 错误文本 / 抛出 ------------------------------ */

/** 通过 FormatMessageW 格式化 Win32 错误码。 */
export function errorText(api: Win32Bindings, win32Code: number): string {
  const buffer = Buffer.alloc(1024);
  const length = api.formatMessageW(
    abi.FORMAT_MESSAGE_FROM_SYSTEM | abi.FORMAT_MESSAGE_IGNORE_INSERTS,
    null,
    win32Code,
    0,
    buffer,
    buffer.length / 2,
    null,
  );
  return length === 0 ? "" : buffer.subarray(0, length * 2).toString("utf16le").trim();
}

/** 抛出当前 GetLastError 值。 */
export function throwLastError(api: Win32Bindings, name: string, detail?: string): never {
  const win32Code = api.getLastError();
  throw new Win32Error(name, win32Code, detail ?? errorText(api, win32Code));
}

/** 抛出显式捕获的 Win32 错误码。 */
export function throwWin32(api: Win32Bindings, name: string, win32Code: number, detail?: string): never {
  throw new Win32Error(name, win32Code, detail ?? errorText(api, win32Code));
}

/** 返回当前 Windows 临时目录。 */
export function getTempPath(api: Win32Bindings): string {
  const buffer = Buffer.alloc((abi.MAX_PATH + 1) * 2);
  const length = api.getTempPathW(buffer.length / 2, buffer);
  if (length === 0) throwLastError(api, "GetTempPathW");
  if (length > buffer.length / 2) {
    throw new Win32Error(
      "GetTempPathW",
      abi.ERROR_INSUFFICIENT_BUFFER,
      `required ${length} chars exceed the ${buffer.length / 2}-char buffer; nothing was written`,
    );
  }
  return buffer.subarray(0, length * 2).toString("utf16le");
}
