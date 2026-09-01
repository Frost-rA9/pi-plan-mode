/**
 * pi-plan-mode · 包根入口（pi.extensions 指向此处）。
 *
 * 仅 re-export Route A 宿主（packages/core/src/index.ts）。包根入口保证 pi 的
 * /config 资源选择器按「父目录/文件名」推导显示名为 `pi-plan-mode/index.ts`
 * （与 pi-mcp-bridge 同构）；若直接指向 packages/core/src/index.ts 会显示成 `src/index.ts`。
 */
export { default } from "./packages/core/src/index.ts";
