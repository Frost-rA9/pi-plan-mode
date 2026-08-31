/**
 * pi-planbuild v4（路线 X）· winacl：受限令牌子进程 + Job kill-on-close。
 * 来源：dsh `subprocess/win32-process/src/process.ts`，本方案把 `CreateProcessAsUserW`
 * （**实测本机 CreateProcessWithTokenW 恒 ERROR_ACCESS_DENIED**，Creator 用 AsUserW 等效）。
 *
 * 每个 Win32 失败即 throw —— **child is never spawned unrestricted**（对齐 dsh）。
 */

import koffi from "koffi";
import * as abi from "./abi.ts";
import {
  allocUint32, allocProcessInfo, allocStartupInfo,
  decodeProcessInfo, decodeUint32, encodeStartupInfo, isNullPtr, throwLastError, throwWin32,
  type NativePtr, type Win32Bindings,
} from "./ffi.ts";
import { closeBestEffort, createPipe } from "./stdio.ts";

/** 受限令牌进程创建的输入。 */
export interface RestrictedProcessSpawnOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  token: NativePtr;
}

/** 管道 stdio 子进程资源。 */
export interface SpawnedPipedProcess {
  pid: number;
  process: NativePtr;
  stdoutRead: NativePtr;
  stderrRead: NativePtr;
}

/** 挂到 kill-on-close Job 的子进程资源。 */
export interface SpawnedJobProcess {
  pid: number;
  process: NativePtr;
  job: NativePtr;
}

/** 按 CommandLineToArgvW 规则引用一个参数。 */
export function quoteArg(argument: string): string {
  if (argument === "") return '""';
  if (!/[\s"]/u.test(argument)) return argument;
  let quoted = '"';
  for (let index = 0; index < argument.length; index += 1) {
    let backslashes = 0;
    while (index < argument.length && argument.charAt(index) === "\\") {
      backslashes += 1;
      index += 1;
    }
    if (index === argument.length) {
      quoted += "\\".repeat(backslashes * 2);
    } else if (argument.charAt(index) === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
    } else {
      quoted += "\\".repeat(backslashes) + argument.charAt(index);
    }
  }
  return quoted + '"';
}

/** 构建 CreateProcess 接受的可变命令行。 */
export function buildCommandLine(program: string, args: readonly string[]): string {
  return [program, ...args].map(quoteArg).join(" ");
}

/** 创建受限进程函数（AsUserW 惰性绑定）。 */
function createRestrictedProcess(
  api: Win32Bindings,
  options: RestrictedProcessSpawnOptions,
  commandLine: string,
  creationFlags: number,
  startupInfo: NativePtr,
  processInfo: NativePtr,
): number {
  // 受限令牌下显式 env block 会被 CreateProcessAsUserW 以 ERROR_INVALID_PARAMETER 拒绝 → lpEnvironment=null。
  return api.createProcessAsUserW(
    options.token,
    null,
    commandLine,
    null,
    null,
    1,
    creationFlags,
    null,
    options.cwd,
    startupInfo,
    processInfo,
  );
}

/**
 * 以匿名管道 stdout/stderr 生成受限进程（stdin 立即 EOF）。
 * @returns 调用者所有的进程与管道读句柄。
 */
export function spawnPipedProcess(api: Win32Bindings, options: RestrictedProcessSpawnOptions): SpawnedPipedProcess {
  const owned = new Set<NativePtr>();
  let startupInfo: NativePtr | undefined;
  let processInfo: NativePtr | undefined;
  const closeAll = (): void => {
    for (const handle of owned) api.closeHandle(handle);
    owned.clear();
  };
  try {
    const stdIn = createPipe(api);
    const stdOut = createPipe(api);
    const stdErr = createPipe(api);
    owned.add(stdIn.read); owned.add(stdIn.write);
    owned.add(stdOut.read); owned.add(stdOut.write);
    owned.add(stdErr.read); owned.add(stdErr.write);
    // 仅子端（stdin 读、stdout 写、stderr 写）可继承。
    for (const [handle, label] of [
      [stdIn.read, "stdin read end"],
      [stdOut.write, "stdout write end"],
      [stdErr.write, "stderr write end"],
    ] as const) {
      if (api.setHandleInformation(handle, abi.HANDLE_FLAG_INHERIT, abi.HANDLE_FLAG_INHERIT) === 0) {
        throwLastError(api, "SetHandleInformation", label);
      }
    }
    startupInfo = allocStartupInfo();
    encodeStartupInfo(startupInfo, {
      cb: abi.STARTUPINFOW_SIZE,
      dwFlags: abi.STARTF_USESTDHANDLES,
      hStdInput: stdIn.read,
      hStdOutput: stdOut.write,
      hStdError: stdErr.write,
    });
    processInfo = allocProcessInfo();
    const created = createRestrictedProcess(
      api, options, buildCommandLine(options.command, options.args), 0, startupInfo, processInfo,
    );
    if (created === 0) {
      const win32Code = api.getLastError();
      throwWin32(api, "CreateProcessAsUserW", win32Code, `command: ${options.command}, cwd: ${options.cwd}`);
    }
    const info = decodeProcessInfo(processInfo);
    if (info.hProcess === null || info.hThread === null) {
      if (info.hProcess !== null) api.terminateProcess(info.hProcess, 1);
      closeBestEffort(api, info.hThread);
      closeBestEffort(api, info.hProcess);
      throw new Error(`CreateProcessAsUserW succeeded but returned null process/thread handles (pid ${info.dwProcessId})`);
    }
    // 关闭本进程持有的写端/读端剩余句柄（子端随 child 副本关闭）。
    closeBestEffort(api, stdIn.read);
    closeBestEffort(api, stdIn.write);
    closeBestEffort(api, stdOut.write);
    closeBestEffort(api, stdErr.write);
    closeBestEffort(api, info.hThread);
    owned.clear();
    return { pid: info.dwProcessId, process: info.hProcess, stdoutRead: stdOut.read, stderrRead: stdErr.read };
  } catch (error) {
    closeAll();
    throw error;
  } finally {
    if (processInfo !== undefined) koffi.free(processInfo);
    if (startupInfo !== undefined) koffi.free(startupInfo);
  }
}

function koffiFree(ptr: NativePtr): void {
  koffi.free(ptr);
}

/** 等待进程并总是关闭其句柄。 */
export function waitForProcessExit(api: Win32Bindings, process: NativePtr): number {
  let exitCodeSlot: NativePtr | undefined;
  try {
    if (api.waitForSingleObject(process, abi.INFINITE) === 0xffffffff) {
      throwLastError(api, "WaitForSingleObject");
    }
    exitCodeSlot = allocUint32();
    if (api.getExitCodeProcess(process, exitCodeSlot) === 0) throwLastError(api, "GetExitCodeProcess");
    return decodeUint32(exitCodeSlot);
  } finally {
    if (exitCodeSlot !== undefined) koffiFree(exitCodeSlot);
    api.closeHandle(process);
  }
}

/** 暂停的子进程挂到 kill-on-close Job 后继续。 */
export function spawnInheritedJobProcess(api: Win32Bindings, options: RestrictedProcessSpawnOptions): SpawnedJobProcess {
  const job = createKillOnCloseJob(api);
  const getStdHandle = (selector: number, label: string): NativePtr => {
    const handle = api.getStdHandle(selector);
    if (!isNullPtr(handle)) return handle;
    const win32Code = api.getLastError();
    api.closeHandle(job);
    throwWin32(api, "GetStdHandle", win32Code, `null ${label} handle`);
  };
  const stdIn = getStdHandle(abi.STD_INPUT_HANDLE, "stdin");
  const stdOut = getStdHandle(abi.STD_OUTPUT_HANDLE, "stdout");
  const stdErr = getStdHandle(abi.STD_ERROR_HANDLE, "stderr");
  const enabled: NativePtr[] = [];
  let startupInfo: NativePtr | undefined;
  let processInfo: NativePtr | undefined;
  let created = 0;
  let createFailureCode = 0;
  try {
    for (const [handle, label] of [
      [stdIn, "stdin"], [stdOut, "stdout"], [stdErr, "stderr"],
    ] as const) {
      if (api.setHandleInformation(handle, abi.HANDLE_FLAG_INHERIT, abi.HANDLE_FLAG_INHERIT) === 0) {
        throwLastError(api, "SetHandleInformation", `${label} (enable inherit)`);
      }
      enabled.push(handle);
    }
    startupInfo = allocStartupInfo();
    encodeStartupInfo(startupInfo, {
      cb: abi.STARTUPINFOW_SIZE, dwFlags: abi.STARTF_USESTDHANDLES,
      hStdInput: stdIn, hStdOutput: stdOut, hStdError: stdErr,
    });
    processInfo = allocProcessInfo();
    created = createRestrictedProcess(api, options, buildCommandLine(options.command, options.args), abi.CREATE_SUSPENDED, startupInfo, processInfo);
    if (created === 0) createFailureCode = api.getLastError();
  } catch (error) {
    if (processInfo !== undefined) koffiFree(processInfo);
    api.closeHandle(job);
    throw error;
  } finally {
    if (startupInfo !== undefined) koffiFree(startupInfo);
    for (const handle of enabled) {
      api.setHandleInformation(handle, abi.HANDLE_FLAG_INHERIT, 0);
    }
  }
  if (created === 0) {
    if (processInfo !== undefined) koffiFree(processInfo);
    api.closeHandle(job);
    throwWin32(api, "CreateProcessAsUserW", createFailureCode, `command: ${options.command}, cwd: ${options.cwd}`);
  }
  let info: ReturnType<typeof decodeProcessInfo>;
  try {
    info = decodeProcessInfo(processInfo!);
  } finally {
    if (processInfo !== undefined) koffiFree(processInfo);
  }
  if (info.hProcess === null || info.hThread === null) {
    if (info.hProcess !== null) api.terminateProcess(info.hProcess, 1);
    api.closeHandle(job);
    closeBestEffort(api, info.hThread);
    closeBestEffort(api, info.hProcess);
    throw new Error(`CreateProcessAsUserW succeeded but returned null handles (pid ${info.dwProcessId})`);
  }
  if (api.assignProcessToJobObject(job, info.hProcess) === 0) {
    const win32Code = api.getLastError();
    api.terminateProcess(info.hProcess, 1);
    closeBestEffort(api, info.hThread);
    closeBestEffort(api, info.hProcess);
    api.closeHandle(job);
    throwWin32(api, "AssignProcessToJobObject", win32Code, `pid ${info.dwProcessId}`);
  }
  if (api.resumeThread(info.hThread) === 0xffffffff) {
    const win32Code = api.getLastError();
    closeBestEffort(api, info.hThread);
    closeBestEffort(api, info.hProcess);
    api.closeHandle(job);
    throwWin32(api, "ResumeThread", win32Code, `pid ${info.dwProcessId}`);
  }
  closeBestEffort(api, info.hThread);
  return { pid: info.dwProcessId, process: info.hProcess, job };
}

function createKillOnCloseJob(api: Win32Bindings): NativePtr {
  const job = api.createJobObjectW(null, null);
  if (isNullPtr(job)) throwLastError(api, "CreateJobObjectW");
  const information = Buffer.alloc(abi.JOBOBJECT_EXTENDED_LIMIT_SIZE);
  information.writeUInt32LE(abi.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, abi.JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET);
  if (api.setInformationJobObject(job, abi.JobObjectExtendedLimitInformation, information, information.length) === 0) {
    const win32Code = api.getLastError();
    api.closeHandle(job);
    throwWin32(api, "SetInformationJobObject", win32Code);
  }
  return job;
}
