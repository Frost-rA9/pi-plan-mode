/**
 * pi-planbuild v4（路线 X）· winacl：ACL 编辑助手。
 * 来源：dsh `acl.ts`（grantWrite/revokeWrite），本方案增补 `denyWrite` / `denyRead`。
 *
 * 基于 `GetNamedSecurityInfoW` + `SetEntriesInAclW` + `SetNamedSecurityInfoW` 合并，ACE 命名
 * **capability / 用户 SID**（免提权）。每个 Win32 调用检查并在失败时以精确 API+码抛出。
 *
 * 生命周期：grant/deny 一次会话内建立，`dispose` 逐撤销（**不留持久 ACL 残渣**——弃 dsh
 * standing 缓存，每个会话重建+撤销）。ACE 的 exact 存在性跳过（避免大树上重复扩展）。
 */

import koffi from "koffi";
import * as abi from "./abi.ts";
import {
  allocPtrSlot, decodePtr, decodeUint8At, decodeUint16At, decodeUint32At,
  isNullPtr, ptrAddress, sameSidAt, throwLastError, throwWin32,
  type NativePtr, type Win32Bindings,
} from "./ffi.ts";

/** 打包一个 EXPLICIT_ACCESS_W（48 字节，x64 布局 由 abi 探针验证）。 */
export function buildExplicitAccess(sidPtr: NativePtr, mode: number, permissions: number): Buffer {
  const entry = Buffer.alloc(abi.EXPLICIT_ACCESS_W_SIZE);
  entry.writeUInt32LE(permissions, 0); // grfAccessPermissions
  entry.writeUInt32LE(mode, 4); // grfAccessMode: GRANT=1 / DENY=3 / REVOKE=4
  entry.writeUInt32LE(abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT, 8); // OI|CI
  entry.writeUInt32LE(abi.NO_MULTIPLE_TRUSTEE, 24);
  entry.writeUInt32LE(abi.TRUSTEE_IS_SID, 28);
  entry.writeUInt32LE(abi.TRUSTEE_IS_UNKNOWN, 32);
  entry.writeBigUInt64LE(ptrAddress(sidPtr), 40);
  return entry;
}

/** 读取目录的当前显式 DACL（指针驻留在描述符分配内——只可 LocalFree 描述符）。 */
function readCurrentDacl(api: Win32Bindings, path: string): { oldAcl: NativePtr | null; descriptor: NativePtr | null } {
  const ownerSlot = allocPtrSlot();
  const groupSlot = allocPtrSlot();
  const daclSlot = allocPtrSlot();
  const saclSlot = allocPtrSlot();
  const descriptorSlot = allocPtrSlot();
  const readResult = api.getNamedSecurityInfoW(
    path, abi.SE_FILE_OBJECT, abi.DACL_SECURITY_INFORMATION,
    ownerSlot, groupSlot, daclSlot, saclSlot, descriptorSlot,
  );
  if (readResult !== abi.ERROR_SUCCESS) throwWin32(api, "GetNamedSecurityInfoW", readResult, path);
  return { oldAcl: decodePtr(daclSlot), descriptor: decodePtr(descriptorSlot) };
}

/** 合并 `entry` 进 `oldAcl`（null=无显式 DACL），应用后释放描述符与新 ACL。 */
function mergeAndApply(
  api: Win32Bindings,
  path: string,
  entry: Buffer,
  oldAcl: NativePtr | null,
  descriptor: NativePtr | null,
  label: string,
): void {
  const newAclSlot = allocPtrSlot();
  const mergeResult = api.setEntriesInAclW(1, entry, oldAcl, newAclSlot);
  if (mergeResult !== abi.ERROR_SUCCESS) {
    if (descriptor !== null) api.localFree(descriptor);
    throwWin32(api, "SetEntriesInAclW", mergeResult, `${label}(${path})`);
  }
  const newAcl = decodePtr(newAclSlot);
  if (newAcl === null) {
    if (descriptor !== null) api.localFree(descriptor);
    throwWin32(api, "SetEntriesInAclW", api.getLastError(), `${label}(${path}): null new ACL`);
  }
  // 描述符在合并后失效——应用前释放。
  const freedDescriptor = descriptor !== null ? api.localFree(descriptor) : null;
  const applyResult = api.setNamedSecurityInfoW(
    path, abi.SE_FILE_OBJECT, abi.DACL_SECURITY_INFORMATION,
    null, null, newAcl, null,
  );
  const freedNew = api.localFree(newAcl);
  if (applyResult !== abi.ERROR_SUCCESS) throwWin32(api, "SetNamedSecurityInfoW", applyResult, `${label}(${path})`);
  if (freedDescriptor !== null && !isNullPtr(freedDescriptor)) {
    throwLastError(api, "LocalFree", `${label}(${path}) descriptor`);
  }
  if (!isNullPtr(freedNew)) throwLastError(api, "LocalFree", `${label}(${path}) new ACL`);
}

/** 显式 DACL 是否已携带 EXACT 的 allow ACE（grant mask + capability SID）。 */
function hasExactGrant(oldAcl: NativePtr, sidPtr: NativePtr, mask: number): boolean {
  const aclSize = decodeUint16At(oldAcl, 2);
  const aceCount = decodeUint16At(oldAcl, 4);
  if (aclSize < 8 || aclSize > 1_048_576) return false;
  let offset = 8;
  for (let index = 0; index < aceCount; index += 1) {
    const aceSize = decodeUint16At(oldAcl, offset + 2);
    if (aceSize < 8 || offset + aceSize > aclSize) return false;
    const exact = decodeUint8At(oldAcl, offset) === abi.ACCESS_ALLOWED_ACE_TYPE
      && decodeUint8At(oldAcl, offset + 1) === abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT
      && decodeUint32At(oldAcl, offset + 4) === mask;
    if (exact && sameSidAt(oldAcl, offset + 8, sidPtr, 0)) return true;
    offset += aceSize;
  }
  return false;
}

/**
 * 授予 `mask` 给 capability SID 于 `path`（OI|CI 继承至子容器/对象）。幂等：
 * 已存在 exact ACE 时跳过（避免大树上重复扩展）。
 */
export function grantAcl(api: Win32Bindings, path: string, sidPtr: NativePtr, mask: number, label: string): void {
  const { oldAcl, descriptor } = readCurrentDacl(api, path);
  if (oldAcl !== null && hasExactGrant(oldAcl, sidPtr, mask)) {
    if (descriptor !== null) {
      const freed = api.localFree(descriptor);
      if (!isNullPtr(freed)) throwLastError(api, "LocalFree", `${label}(${path}) descriptor`);
    }
    return;
  }
  mergeAndApply(api, path, buildExplicitAccess(sidPtr, abi.GRANT_ACCESS, mask), oldAcl, descriptor, label);
}

/** 授予 GRANT_MASK（写+删）给 `dir`。 */
export function grantWrite(api: Win32Bindings, path: string, sidPtr: NativePtr): void {
  grantAcl(api, path, sidPtr, abi.GRANT_MASK, "grantWrite");
}

/** 移除 `path` 上命名 `sidPtr` 的全部 ACE（REVOKE_ACCESS 合并），返回是否尝试过移除。 */
export function revokeSid(api: Win32Bindings, path: string, sidPtr: NativePtr): boolean {
  const { oldAcl, descriptor } = readCurrentDacl(api, path);
  if (oldAcl === null) {
    if (descriptor !== null) {
      const freed = api.localFree(descriptor);
      if (!isNullPtr(freed)) throwLastError(api, "LocalFree", `revokeSid(${path}) descriptor`);
    }
    return false;
  }
  mergeAndApply(api, path, buildExplicitAccess(sidPtr, abi.REVOKE_ACCESS, 0), oldAcl, descriptor, "revokeSid");
  return true;
}

/**
 * 拒绝读（deny-read）给 `sidPtr`，应用于敏感叶子/目录（CODE-x deny_read 语义）。
 * 使用 DENY_ACCESS（3）+ GENERIC_READ。敏感目录因子路径 deny.read 向下继承。
 */
export function denyRead(api: Win32Bindings, path: string, sidPtr: NativePtr): void {
  const { oldAcl, descriptor } = readCurrentDacl(api, path);
  mergeAndApply(api, path, buildExplicitAccess(sidPtr, abi.DENY_ACCESS, abi.GENERIC_READ), oldAcl, descriptor, "denyRead");
}

/** 捕获 path 当前显式 DACL 的原始字节（供 dispose 精确恢复；无显式 DACL 时返回 null）。 */
export function saveAcl(api: Win32Bindings, path: string): Buffer | null {
  const { oldAcl, descriptor } = readCurrentDacl(api, path);
  let saved: Buffer | null = null;
  if (oldAcl !== null) {
    const aclSize = decodeUint16At(oldAcl, 2);
    const arr = koffi.decode(oldAcl, 0, koffi.array("uint8", aclSize)) as Uint8Array;
    saved = Buffer.from(arr);
  }
  if (descriptor !== null) {
    const freed = api.localFree(descriptor);
    if (!isNullPtr(freed)) throwLastError(api, "LocalFree", `saveAcl(${path}) descriptor`);
  }
  return saved;
}

/** 把保存的原 DACL 字节写回 path（精确恢复；不留修改残渣）。 */
export function applyAcl(api: Win32Bindings, path: string, original: Buffer): void {
  const result = api.setNamedSecurityInfoW(
    path, abi.SE_FILE_OBJECT, abi.DACL_SECURITY_INFORMATION,
    null, null, original as unknown as NativePtr, null,
  );
  if (result !== abi.ERROR_SUCCESS) throwWin32(api, "SetNamedSecurityInfoW", result, `applyAcl(${path})`);
}

/** 拒绝写给 `sidPtr`（verify 档保护 .git/.pi）。 */
export function denyWrite(api: Win32Bindings, path: string, sidPtr: NativePtr): void {
  const { oldAcl, descriptor } = readCurrentDacl(api, path);
  mergeAndApply(api, path, buildExplicitAccess(sidPtr, abi.DENY_ACCESS, abi.GRANT_MASK), oldAcl, descriptor, "denyWrite");
}
