/**
 * pi-planbuild v4（路线 X）· winacl：受限令牌构造。
 * 来源：dsh `token.ts`（openCurrentProcessToken/findLogonSid/createRestrictedToken/setTokenDefaultDaclGrant）。
 *
 * 关键（Win11 26200 实测，与 dsh 一致）：logon SID + Everyone keep-alive 组必须进入 restricting 列表，
 * 否则早期 DLL 初始化以 0xC0000142 死于 STATUS_DLL_INIT_FAILED、CNG（`\Device\CNG` 写 trustee）使 pwsh
 * 崩溃 0xE0434352。写 SID 只在 verify 档进入 restricting（readonly 不携带 → 旧 standing 写 ACE 惰性）。
 */

import * as abi from "./abi.ts";
import {
  allocBytes, allocPtrSlot, allocUint32, decodePtr, decodePtrAt, decodeUint32,
  encodeUint32, isNullPtr, ptrAddress, throwLastError, throwWin32,
  type NativePtr, type Win32Bindings,
} from "./ffi.ts";
import { buildExplicitAccess } from "./acl.ts";

/** 打开当前进程令牌（AskAssignPrimary 供 CreateProcessAsUserW）。 */
export function openCurrentProcessToken(api: Win32Bindings): NativePtr {
  const processHandle = api.openProcess(abi.PROCESS_QUERY_INFORMATION, 0, process.pid);
  if (isNullPtr(processHandle)) throwLastError(api, "OpenProcess", `pid ${process.pid}`);

  const tokenSlot = allocPtrSlot();
  const opened = api.openProcessToken(
    processHandle,
    abi.TOKEN_QUERY | abi.TOKEN_DUPLICATE | abi.TOKEN_ADJUST_DEFAULT | abi.TOKEN_ASSIGN_PRIMARY,
    tokenSlot,
  );
  if (opened === 0) {
    const win32Code = api.getLastError();
    api.closeHandle(processHandle);
    throwWin32(api, "OpenProcessToken", win32Code, `pid ${process.pid}`);
  }
  if (api.closeHandle(processHandle) === 0) throwLastError(api, "CloseHandle", "OpenProcess process handle");
  const token = decodePtr(tokenSlot);
  if (token === null) throwWin32(api, "OpenProcessToken", api.getLastError(), "null token handle");
  return token;
}

/** 查找并复制令牌的登录会话 SID（S-1-5-5-x-y，SE_GROUP_LOGON_ID）。 */
export function findLogonSid(api: Win32Bindings, token: NativePtr): NativePtr {
  const neededSlot = allocUint32();
  api.getTokenInformation(token, abi.TokenGroups, null, 0, neededSlot);
  const needed = decodeUint32(neededSlot);
  if (needed === 0) throwLastError(api, "GetTokenInformation", "TokenGroups size query");
  if (needed < abi.TOKEN_GROUPS_OFFSET) {
    throwWin32(api, "GetTokenInformation", api.getLastError(), `implausible TokenGroups size ${needed}`);
  }

  const groups = Buffer.alloc(needed);
  if (api.getTokenInformation(token, abi.TokenGroups, groups, groups.length, neededSlot) === 0) {
    throwLastError(api, "GetTokenInformation", "TokenGroups");
  }
  const groupCount = groups.readUInt32LE(0);
  for (let index = 0; index < groupCount; index += 1) {
    const sidPtr = decodePtrAt(groups, abi.TOKEN_GROUPS_OFFSET + index * abi.SID_AND_ATTRIBUTES_SIZE);
    const attributes = groups.readUInt32LE(abi.TOKEN_GROUPS_OFFSET + index * abi.SID_AND_ATTRIBUTES_SIZE + 8);
    const isLogonId = ((attributes & abi.SE_GROUP_LOGON_ID) >>> 0) === (abi.SE_GROUP_LOGON_ID >>> 0);
    if (sidPtr === null || !isLogonId) continue;
    const sidLength = api.getLengthSid(sidPtr);
    if (sidLength === 0) throwLastError(api, "GetLengthSid", `logon SID group ${index}`);
    const copy = allocBytes(sidLength);
    if (api.copySid(sidLength, copy, sidPtr) === 0) throwLastError(api, "CopySid", `logon SID group ${index}`);
    return copy;
  }
  throw new Error(`CreateRestrictedToken prerequisite failed: no logon SID found among ${groupCount} token groups`);
}

/** 返回令牌的当前用户 SID（S-1-5-21-...，TokenUser），复制为新分配。 */
export function currentUserSid(api: Win32Bindings, token: NativePtr): NativePtr {
  const neededSlot = allocUint32();
  api.getTokenInformation(token, abi.TokenUser, null, 0, neededSlot);
  const needed = decodeUint32(neededSlot);
  if (needed === 0) throwLastError(api, "GetTokenInformation", "TokenUser size query");
  const buffer = Buffer.alloc(needed);
  if (api.getTokenInformation(token, abi.TokenUser, buffer, buffer.length, neededSlot) === 0) {
    throwLastError(api, "GetTokenInformation", "TokenUser");
  }
  const sidPtr = decodePtrAt(buffer, 0);
  if (sidPtr === null) throwLastError(api, "GetTokenInformation", "TokenUser: null user SID");
  const sidLength = api.getLengthSid(sidPtr);
  if (sidLength === 0) throwLastError(api, "GetLengthSid", "current user SID");
  const copy = allocBytes(sidLength);
  if (api.copySid(sidLength, copy, sidPtr) === 0) throwLastError(api, "CopySid", "current user SID");
  return copy;
}

/** 创建一个 well-known SID（68 字节缓冲），断言其合法。 */
export function makeWellKnownSid(api: Win32Bindings, type: number): NativePtr {
  const sid = allocBytes(abi.SECURITY_MAX_SID_SIZE);
  const sizeSlot = allocUint32();
  encodeUint32(sizeSlot, abi.SECURITY_MAX_SID_SIZE);
  if (api.createWellKnownSid(type, null, sid, sizeSlot) === 0) {
    throwLastError(api, "CreateWellKnownSid", `type ${type}`);
  }
  if (api.isValidSid(sid) === 0) throwLastError(api, "IsValidSid", `CreateWellKnownSid type ${type}`);
  return sid;
}

/** 合并一个 full-access allow ACE 进令牌默认 DACL（新建对象通过写 pass-2）。 */
export function setTokenDefaultDaclGrant(api: Win32Bindings, token: NativePtr, sidPtr: NativePtr): void {
  const neededSlot = allocUint32();
  api.getTokenInformation(token, abi.TokenDefaultDacl, null, 0, neededSlot);
  const needed = decodeUint32(neededSlot);
  if (needed === 0) throwLastError(api, "GetTokenInformation", "TokenDefaultDacl size query");
  const buffer = Buffer.alloc(needed);
  if (api.getTokenInformation(token, abi.TokenDefaultDacl, buffer, buffer.length, neededSlot) === 0) {
    throwLastError(api, "GetTokenInformation", "TokenDefaultDacl");
  }
  const currentDacl = decodePtrAt(buffer, 0);
  if (currentDacl === null) {
    throw new Error("setTokenDefaultDaclGrant: the token carries no default DACL to extend");
  }
  const newDaclSlot = allocPtrSlot();
  const result = api.setEntriesInAclW(
    1,
    buildExplicitAccess(sidPtr, abi.GRANT_ACCESS, abi.FILE_ALL_ACCESS),
    currentDacl,
    newDaclSlot,
  );
  if (result !== abi.ERROR_SUCCESS) throwWin32(api, "SetEntriesInAclW", result, "default DACL merge");
  const newDacl = decodePtr(newDaclSlot);
  if (newDacl === null) throwWin32(api, "SetEntriesInAclW", result, "null merged default DACL");
  const info = Buffer.alloc(8);
  info.writeBigUInt64LE(BigInt(newDacl as unknown as number), 0);
  if (api.setTokenInformation(token, abi.TokenDefaultDacl, info, info.length) === 0) {
    const win32Code = api.getLastError();
    api.localFree(newDacl);
    throwWin32(api, "SetTokenInformation", win32Code, "TokenDefaultDacl");
  }
  api.localFree(newDacl);
}

/** 打包 `SID_AND_ATTRIBUTES[count]`（16 字节步进；Attributes=0）。 */
function buildRestrictingSids(sids: readonly NativePtr[]): Buffer {
  const buffer = Buffer.alloc(abi.SID_AND_ATTRIBUTES_SIZE * sids.length);
  sids.forEach((sid, index) => {
    buffer.writeBigUInt64LE(ptrAddress(sid), abi.SID_AND_ATTRIBUTES_SIZE * index);
  });
  return buffer;
}

/** 每个受限令牌的 restricting 列表里 always 进入的 well-known SID。 */
export interface RestrictingSidSet {
  world: NativePtr;
}

/**
 * 创建写受限令牌。`writeSids` 在 verify 档进入（readonly 为空）。每 API 失败即 throw，
 * **决不无限制 spawn**。logon SID + Everyone keep-alive 组两档共享。
 * @param profile "readonly" | "verify"（写 SID 只在 verify 进入 restricting）
 */
export function createRestrictedToken(
  api: Win32Bindings,
  currentToken: NativePtr,
  logonSid: NativePtr,
  writeSids: readonly NativePtr[],
  known: RestrictingSidSet,
  profile: "readonly" | "verify",
  denySids: readonly NativePtr[] = [],
): NativePtr {
  const restrictingSids = buildRestrictingSids(
    profile === "readonly"
      ? [logonSid, known.world, ...denySids]
      : writeSids.length === 0
        ? (() => { throw new Error("createRestrictedToken: verify restricting list requires at least one write SID") })()
        : [logonSid, known.world, ...writeSids, ...denySids],
  );
  const tokenSlot = allocPtrSlot();
  const created = api.createRestrictedToken(
    currentToken,
    abi.DISABLE_MAX_PRIVILEGE | abi.LUA_TOKEN | abi.WRITE_RESTRICTED,
    0, null, 0, null,
    restrictingSids.length / abi.SID_AND_ATTRIBUTES_SIZE,
    restrictingSids,
    tokenSlot,
  );
  if (created === 0) {
    throwLastError(api, "CreateRestrictedToken", `restricting SIDs: ${restrictingSids.length / abi.SID_AND_ATTRIBUTES_SIZE}`);
  }
  const token = decodePtr(tokenSlot);
  if (token === null) throwWin32(api, "CreateRestrictedToken", api.getLastError(), "null token handle");
  return token;
}
