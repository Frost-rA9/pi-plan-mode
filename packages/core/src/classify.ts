/**
 * pi-planbuild v4 · 命令分类：只读 / 写面 / 未知（supervised/strict 门控用）。
 */
import {
  GIT_READ_ONLY,
  READONLY_COMMAND_NAMES,
  WRITE_ARG_PATTERNS,
  WRITE_COMMAND_PATTERNS,
} from "./config.ts";

export type BashClass = "read" | "write" | "unknown";

/** 按语法分割命令为命令行段：`;` `&&` `||` `|`（尊重引号，不拆引号内）。 */
export function scanPipeline(command: string): string[] {
  const segments: string[] = [];
  let buf = "";
  let quote: string | null = null;
  const push = () => {
    const seg = buf.trim();
    if (seg) segments.push(seg);
    buf = "";
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ";") { push(); continue; }
    if (ch === "&" && command[i + 1] === "&") { push(); i++; continue; }
    if (ch === "|" && command[i + 1] === "|") { push(); i++; continue; }
    if (ch === "|") { push(); continue; }
    buf += ch;
  }
  push();
  return segments;
}

/** 是否命中写面命令模式（正则基于行首/分隔符定位） */
function matchesWriteCommand(segment: string): boolean {
  return WRITE_COMMAND_PATTERNS.some((re) => re.test(segment));
}

/** 是否命中写面参数模式（如 curl -o、sed -i、python -c） */
function matchesWriteArgs(segment: string): boolean {
  return WRITE_ARG_PATTERNS.some(([cmdRe, argRe]) => {
    const head = segment.trim().split(/\s+/)[0];
    if (!cmdRe.test(head)) return false;
    return argRe.test(segment);
  });
}

/** 分类单个语法段：只读 / 写面 / 未知 */
export function classifySegment(segment: string): BashClass {
  const seg = segment.trim();
  if (!seg) return "unknown";
  const head = seg.split(/\s+/)[0];
  if (READONLY_COMMAND_NAMES.has(head)) return "read";
  if (head === "git") {
    const rest = seg.slice(4).trim();
    if (!rest || GIT_READ_ONLY.test(rest)) return "read";
    return "write";
  }
  if (matchesWriteCommand(seg)) return "write";
  if (matchesWriteArgs(seg)) return "write";
  return "unknown";
}

/** 整条命令分类：任一段写面 → write；否则全只读 → read；含未知 → unknown */
export function classifyBash(command: string): BashClass {
  const segments = scanPipeline(command);
  let sawUnknown = false;
  for (const seg of segments) {
    const cls = classifySegment(seg);
    if (cls === "write") return "write";
    if (cls === "unknown") sawUnknown = true;
  }
  return sawUnknown ? "unknown" : "read";
}
