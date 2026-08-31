/**
 * pi-planbuild v4（路线 X）· winacl 原生 runner（Node 子进程）。
 *
 * 为什么存在：pi 宿主是 **Bun**，无法在宿主进程内安全加载 koffi（原生 N-API 插件，
 * Bun 加载即 `napi_reference_unref` panic）。故把 winacl 的 koffi/Win32 逻辑整体挪到
 * **独立 Node 子进程**执行（如 dsh runner / codex 原生二进制模式），Bun 只经一条极薄的
 * IPC（stdin/stdout 一行一个 JSON）驱动。这样 koffi 读原生内存（ACL capture-restore /
 * 幂等）毫无问题，语义零变化。
 *
 * 两个模式：
 *  - `--probe`：执行 `winaclProbe()`（koffi + OpenProcessToken + CreateRestrictedToken +
 *    pwsh-under-token 冒烟），通过 exit 0，否则 exit 127（对齐 dsh `windows-acl-run` 契约）。
 *  - 默认：IPC 会话服务，宿主经 stdin 发送命令、stdout 返回事件。
 *
 * 失败契约：任何失败写 `windows-acl-run: <detail>` 到 stderr，exit 127；child 决不无限制 spawn。
 * @module pi-planbuild/win32-runner
 */
import { createInterface } from "node:readline";
import process from "node:process";
import { createWinaclSession, winaclProbe, type WinaclSession } from "./index.ts";

const SIGNATURE = "windows-acl-run";
const FAIL_EXIT = 127;

class RunnerFailure extends Error {}

/** 打印失败签名并从当前作用域退出。 */
function fail(detail: string): never {
  process.stderr.write(`${SIGNATURE}: ${detail}\n`);
  throw new RunnerFailure(detail);
}

function writeLine(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

/* ------------------------------ 会话宿主 ------------------------------ */

let session: WinaclSession | undefined;
let activeProfile: "readonly" | "verify" | undefined;
/** 当前 exec 的终止控制器；kill 中止它 → session.ts 对子进程 terminateProcess（不杀 runner）。 */
let activeExecAbort: AbortController | undefined;
/** 在途 exec 的 promise（dispose 前等待它结束，避免在 exec 中撕裂会话）。 */
let inflightExec: Promise<void> | undefined;

/** 打开（或复用）指定档位会话；profile 变化时重建（对齐宿主的 ensureSession）。 */
async function ensureSession(profile: "readonly" | "verify", cwd: string): Promise<WinaclSession> {
  if (session !== undefined && activeProfile === profile) return session;
  await session?.dispose().catch(() => undefined);
  const next = createWinaclSession({ cwd, profile, readState: () => ({}) });
  await next.init(profile);
  session = next;
  activeProfile = profile;
  return session;
}

/** 单条命令处理。 */
async function handle(cmd: Record<string, unknown>): Promise<void> {
  switch (cmd.cmd) {
    case "init": {
      const profile = cmd.profile as "readonly" | "verify";
      const cwd = cmd.cwd as string;
      if (profile !== "readonly" && profile !== "verify") fail("bad profile");
      if (typeof cwd !== "string" || cwd === "") fail("bad cwd");
      await ensureSession(profile, cwd);
      writeLine({ type: "ready", ok: true });
      return;
    }
    case "exec": {
      inflightExec = handleExec(cmd).finally(() => { inflightExec = undefined; });
      return;
    }
    case "kill": {
      // 中止当前 exec：session.ts 对子进程 terminateProcess，child 退出后随 done 上报（不杀 runner，避免孤儿）。
      activeExecAbort?.abort();
      return;
    }
    case "dispose": {
      // 等待在途 exec（带 3s 超时兜底），避免在 exec 中撕裂会话。
      if (inflightExec !== undefined) await Promise.race([inflightExec, new Promise((r) => setTimeout(r, 3_000))]);
      await session?.dispose().catch(() => undefined);
      session = undefined;
      activeProfile = undefined;
      writeLine({ type: "disposed" });
      return;
    }
    default:
      fail(`unknown command: ${String(cmd.cmd)}`);
  }
}

/** 后台执行一条沙箱命令（不阻塞读循环）。kill 经 activeExecAbort 中止其子进程。 */
async function handleExec(cmd: Record<string, unknown>): Promise<void> {
  try {
    if (session === undefined) fail("exec without init");
    if (!session.isSpawnable()) fail("session not spawnable (fail-closed)");
    const id = cmd.id as number;
    const command = cmd.command as string;
    const cwd = cmd.cwd as string;
    if (typeof command !== "string") fail("bad command");
    const ac = new AbortController();
    activeExecAbort = ac;
    try {
      const result = await session.exec(command, cwd, {
        onData: (chunk) => writeLine({ type: "data", id, chunk: chunk.toString("base64") }),
        signal: ac.signal,
        env: cmd.env as NodeJS.ProcessEnv | undefined,
      });
      writeLine({ type: "done", id, exitCode: result.exitCode });
    } finally {
      activeExecAbort = undefined;
    }
  } catch (error) {
    writeLine({ type: "error", message: error instanceof Error ? error.message : String(error) });
    process.stderr.write(`${SIGNATURE}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/* ------------------------------ 入口 ------------------------------ */

async function main(): Promise<void> {
  if (process.argv[2] === "--probe") {
    let ok: boolean;
    try {
      ok = winaclProbe();
    } catch {
      ok = false;
    }
    process.exit(ok ? 0 : FAIL_EXIT);
    return;
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let cmd: Record<string, unknown>;
    try {
      cmd = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      fail(`bad json: ${trimmed}`);
      continue;
    }
    try {
      await handle(cmd);
    } catch (error) {
      writeLine({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      process.stderr.write(`${SIGNATURE}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${SIGNATURE}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = FAIL_EXIT;
});
