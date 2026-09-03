/**
 * pi-plan-mode · 能力注册：按需启用 + 惰性加载 + 可替换。
 *
 * Route A 增强：一个宿主（mode）+ N 个能力库，但能力为「可选依赖 + 动态 import」，由
 * `/plan-capabilities`（或启动 flag plan-capabilities）门控是否加载。
 * - 未启用 / 未安装 / 加载失败 → 该能力降级（绝不影响其它）。
 * - 替换：能力 id → 实现包名可由 `plan-capabilities-<id>` flag 覆盖（resolver），
 *   换一个实现同一契约的库包即可，无需改宿主逻辑。
 */
import type {
  CapabilityId,
  CapabilityRegistry,
  PreviewApi,
  QuestionApi,
  SandboxApi,
} from "pi-plan-bridge";

/** 交换点：能力 id → 默认实现包名。替换 = 改此处，或经 `plan-capabilities-<id>` flag 覆盖。 */
export const DEFAULT_CAPABILITY_MODULES: Record<CapabilityId, string> = {
  sandbox: "pi-plan-sandbox",
  preview: "pi-plan-preview",
  question: "pi-plan-question",
};

// 能力接口（SandboxApi/PreviewApi/QuestionApi/CapabilityRegistry）已上移 pi-plan-bridge 单源；
// 能力包实现同一契约，宿主经 loadCapabilities 消费，替换实现有编译期保证。
export type { SandboxBackendLike, SandboxApi, PreviewApi, QuestionApi, CapabilityRegistry } from "pi-plan-bridge";
/** 解析 plan-capabilities 值（默认全开；"none" 全关；逗号列表选择）。 */
export function parseEnabled(raw: unknown): Set<CapabilityId> {
  if (typeof raw !== "string") return new Set<CapabilityId>(["sandbox", "preview", "question"]);
  const v = raw.trim();
  if (v === "all" || v === "") return new Set<CapabilityId>(["sandbox", "preview", "question"]);
  if (v === "none") return new Set<CapabilityId>();
  return new Set(
    v
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is CapabilityId => s === "sandbox" || s === "preview" || s === "question"),
  );
}

/** 解析 flag：`plan-capabilities-<id>` 覆盖默认实现包名（替换点）。 */
function resolveModule(id: CapabilityId, flags: Record<string, unknown>): string {
  const override = flags[`plan-capabilities-${id}`];
  return typeof override === "string" && override.trim() ? override.trim() : DEFAULT_CAPABILITY_MODULES[id];
}

/**
 * 惰性加载能力：按启用门控 + resolver 包名动态 import。失败 → 该能力缺省（降级），不影响其它；
 * 降级原因记入 `errors`（`/plan-capabilities` 诊断可见化，不再静默）。
 */
/** 能力注册结果（loadCapabilities 返回：registry + 降级原因）。 */
export type LoadedCapabilities = CapabilityRegistry & {
  errors: Partial<Record<CapabilityId, string>>;
};

export async function loadCapabilities(
  flags: Record<string, unknown>,
): Promise<LoadedCapabilities> {
  const enabled = parseEnabled(flags["plan-capabilities"]);
  const reg: CapabilityRegistry = {};
  const errors: Partial<Record<CapabilityId, string>> = {};
  const ids: CapabilityId[] = ["sandbox", "preview", "question"];
  for (const id of ids) {
    if (!enabled.has(id)) continue; // 按需启用：被关掉则不加载
    try {
      const mod: Record<string, unknown> = await import(resolveModule(id, flags));
      if (id === "sandbox") {
        reg.sandbox = {
          selectBackend: mod.selectBackend as SandboxApi["selectBackend"],
          detectShellPath: mod.detectShellPath as SandboxApi["detectShellPath"],
        };
      } else if (id === "preview") {
        reg.preview = { summarize: mod.summarize as PreviewApi["summarize"] };
      } else if (id === "question") {
        reg.question = { registerQuestionTool: mod.registerQuestionTool as QuestionApi["registerQuestionTool"] };
      }
    } catch (error) {
      const message = `能力 ${id} 不可用，降级：${(error as Error)?.message ?? error}`;
      errors[id] = (error as Error)?.message ?? String(error);
      console.warn(`[pi-plan-mode] ${message}`);
    }
  }
  return { ...reg, errors };
}
