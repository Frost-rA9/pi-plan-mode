/**
 * pi-planbuild v4（路线 X）· winacl：管道原语 + 流式排空。
 * 来源：dsh `subprocess/win32-process/src/process.ts`（createPipe/drainPipe），
 * 本方案把 drainPipe 改为流式（onData 按块回调），供 session.exec 驱动。
 */

import koffi from "koffi";
import * as abi from "./abi.ts";
import {
  allocPtrSlot, allocUint32, decodePtr, decodeUint32, isNullPtr, throwLastError,
  type NativePtr, type Win32Bindings,
} from "./ffi.ts";

/** 一对管道端点（读/写）。 */
export interface PipePair {
  read: NativePtr;
  write: NativePtr;
}

/** 创建一个匿名管道。 */
export function createPipe(api: Win32Bindings): PipePair {
  const readSlot = allocPtrSlot();
  const writeSlot = allocPtrSlot();
  if (api.createPipe(readSlot, writeSlot, null, 0) === 0) throwLastError(api, "CreatePipe");
  const read = decodePtr(readSlot);
  const write = decodePtr(writeSlot);
  if (read === null || write === null) {
    if (read !== null) api.closeHandle(read);
    if (write !== null) api.closeHandle(write);
    throwLastError(api, "CreatePipe", "null pipe handle");
  }
  return { read, write };
}

/** 使句柄可继承（子进程经 STARTF_USESTDHANDLES 接管）。 */
export function setInherit(api: Win32Bindings, handle: NativePtr): void {
  if (api.setHandleInformation(handle, abi.HANDLE_FLAG_INHERIT, abi.HANDLE_FLAG_INHERIT) === 0) {
    throwLastError(api, "SetHandleInformation", "pipe handle inherit");
  }
}

/** 关闭一个管道端（best-effort）。 */
export function closeBestEffort(api: Win32Bindings, handle: NativePtr | null | undefined): void {
  if (!isNullPtr(handle)) api.closeHandle(handle);
}

/**
 * 流式排空 `handle` 直到写端关闭，块到达即调 `onData`，总是关闭句柄。
 * @returns 读到的总字节数。
 */
export async function drainPipe(
  api: Win32Bindings,
  handle: NativePtr,
  onData: (data: Buffer) => void,
): Promise<number> {
  let total = 0;
  let countSlot: NativePtr | undefined;
  try {
    countSlot = allocUint32();
    for (;;) {
      const peeked = api.peekNamedPipe(handle, null, 0, null, countSlot, null);
      if (peeked === 0) {
        const win32Code = api.getLastError();
        if (win32Code === abi.ERROR_BROKEN_PIPE || win32Code === abi.ERROR_NO_DATA) break;
        throwLastError(api, "PeekNamedPipe", `drain failure after ${total} byte(s)`);
      }
      const available = decodeUint32(countSlot);
      if (available > 0) {
        const chunk = Buffer.alloc(available);
        if (api.readFile(handle, chunk, chunk.length, countSlot, null) === 0) {
          throwLastError(api, "ReadFile", `drain failure after ${total} byte(s)`);
        }
        const readLen = decodeUint32(countSlot);
        const slice = chunk.subarray(0, readLen);
        total += readLen;
        onData(slice);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    return total;
  } finally {
    if (countSlot !== undefined) koffi.free(countSlot);
    api.closeHandle(handle);
  }
}
