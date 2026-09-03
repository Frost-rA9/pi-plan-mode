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

console.log("✅ bridge: classifyPodmanWrite / safety / formatPlanSummary");
