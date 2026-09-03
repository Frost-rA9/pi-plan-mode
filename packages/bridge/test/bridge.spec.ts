/**
 * pi-plan-bridge 测试：classifyPodmanWrite / requiresSandbox / isSafetyMode / formatPlanSummary（纯函数）。
 * 运行：node --experimental-strip-types test/bridge.spec.ts
 */
import assert from "node:assert/strict";
import {
  classifyPodmanWrite,
  requiresSandbox,
  isSafetyMode,
  isSandboxedProfile,
  formatPlanSummary,
  SAFETY_MODE_CATALOG,
  safetyModeInfo,
  safetyModeAvailability,
} from "../src/index.ts";

assert.equal(requiresSandbox("readonly"), true);
assert.equal(requiresSandbox("verify"), true);
assert.equal(requiresSandbox("supervised"), false);
assert.equal(requiresSandbox("strict"), false);

assert.equal(isSandboxedProfile("verify"), true);
assert.equal(isSandboxedProfile("supervised"), false);

assert.equal(isSafetyMode("readonly"), true);
assert.equal(isSafetyMode("bogus"), false);

// podman 控制面：只读放行（false=非写面），写/未知拦截（true=写面）
assert.equal(classifyPodmanWrite("podman ps"), false);
assert.equal(classifyPodmanWrite("podman compose ps"), false);
assert.equal(classifyPodmanWrite("podman pod exists foo"), false);
assert.equal(classifyPodmanWrite("podman network ls"), false);
assert.equal(classifyPodmanWrite("podman rm -f x"), true);
assert.equal(classifyPodmanWrite("podman exec foo"), true); // 未知 → fail-closed
assert.equal(classifyPodmanWrite("podman play kube dev.yaml"), true); // 写面（部署核心）
assert.equal(classifyPodmanWrite("podman pod create foo"), true); // 写面
assert.equal(classifyPodmanWrite("podman build -t x ."), true); // 写面
assert.equal(classifyPodmanWrite("podman"), true);

const fmt = formatPlanSummary({ title: "计划", bullets: ["a", "b"], steps: 2, lines: 4 });
assert.ok(fmt.includes("## 目标：计划"));
assert.ok(fmt.includes("- a"));
assert.ok(fmt.includes("2 步 / 4 行"));

/* -------------------- 档位目录（SAFETY_MODE_CATALOG / safetyModeAvailability） -------------------- */

// 目录：四档固定序，requiresSandbox 与 requiresSandbox() 一致。
assert.equal(SAFETY_MODE_CATALOG.length, 4);
assert.equal(SAFETY_MODE_CATALOG[0].mode, "readonly");
assert.equal(SAFETY_MODE_CATALOG[1].mode, "verify");
assert.equal(SAFETY_MODE_CATALOG[2].mode, "supervised");
assert.equal(SAFETY_MODE_CATALOG[3].mode, "strict");
for (const entry of SAFETY_MODE_CATALOG) {
  assert.equal(entry.requiresSandbox, requiresSandbox(entry.mode)); // 目录与判定函数一致
}

// safetyModeInfo：按 id 查条目。
assert.equal(safetyModeInfo("readonly")?.description, "OS 只读沙箱 + 零确认（bwrap / winacl+pwsh）");
assert.equal(safetyModeInfo("bogus" as any), undefined);

// safetyModeAvailability：沙箱档跟随后端可用性；交互层档恒可用。
assert.deepEqual(safetyModeAvailability("readonly", true), { allowed: true });
assert.deepEqual(safetyModeAvailability("verify", true), { allowed: true });
assert.equal(safetyModeAvailability("readonly", false).allowed, false);
assert.ok(safetyModeAvailability("readonly", false).reason); // 有原因文案
assert.equal(safetyModeAvailability("readonly", false, "bwrap 缺失").reason, "bwrap 缺失");
assert.equal(safetyModeAvailability("supervised", false).allowed, true); // 无沙箱档不依赖后端
assert.equal(safetyModeAvailability("strict", false).allowed, true);

console.log("✅ bridge: classifyPodmanWrite / safety / formatPlanSummary / safetyCatalog");
