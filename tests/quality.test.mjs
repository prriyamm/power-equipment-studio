import { test } from "node:test";
import assert from "node:assert/strict";
import { detectTier, tierSettings, resolveQuality, TIERS, MODES } from "../src/ui/quality.js";

const ANGLE = (s) => `ANGLE (${s} Direct3D11 vs_5_0 ps_5_0, D3D11)`;

test("no WebGL or a software rasteriser is always low", () => {
  assert.equal(detectTier({ webgl: false, cores: 16, memory: 32 }).tier, "low");
  for (const r of [
    "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
    "llvmpipe (LLVM 15.0.7, 256 bits)",
    ANGLE("Microsoft, Microsoft Basic Render Driver"),
    "Google SwiftShader",
  ]) assert.equal(detectTier({ webgl: true, renderer: r, cores: 16, memory: 32 }).tier, "low", r);
});

test("hard floors: 2 cores or 2 GB memory are low", () => {
  assert.equal(detectTier({ renderer: ANGLE("NVIDIA, NVIDIA GeForce RTX 3060"), cores: 2, memory: 16 }).tier, "low");
  assert.equal(detectTier({ renderer: ANGLE("NVIDIA, NVIDIA GeForce RTX 3060"), cores: 8, memory: 2 }).tier, "low");
});

test("discrete GPU with plenty of cores and memory is high", () => {
  const caps = { renderer: ANGLE("NVIDIA, NVIDIA GeForce RTX 3060"), cores: 12, memory: 8, dpr: 1, screenW: 1920, screenH: 1080 };
  assert.equal(detectTier(caps).tier, "high");
  assert.equal(detectTier({ ...caps, renderer: "Apple M2" }).tier, "high");
  assert.equal(detectTier({ ...caps, renderer: ANGLE("AMD, AMD Radeon RX 6700 XT") }).tier, "high");
});

test("typical office laptop with integrated graphics is medium", () => {
  const caps = { renderer: ANGLE("Intel, Intel(R) UHD Graphics 620"), cores: 8, memory: 8, dpr: 1.25, screenW: 1920, screenH: 1080 };
  assert.equal(detectTier(caps).tier, "medium");
  assert.equal(detectTier({ ...caps, renderer: ANGLE("AMD, AMD Radeon(TM) Graphics") }).tier, "medium");
  // unknown memory (Firefox/Safari have no deviceMemory) and an unknown GPU string stay medium
  assert.equal(detectTier({ cores: 4, dpr: 1 }).tier, "medium");
});

test("weak machines score low even above the hard floors", () => {
  assert.equal(detectTier({ renderer: ANGLE("Intel, Intel(R) HD Graphics 4000"), cores: 4, memory: 4, dpr: 2, screenW: 2560, screenH: 1600 }).tier, "low");
  assert.equal(detectTier({ renderer: "Mali-G52", cores: 3, memory: 3 }).tier, "low");
});

test("a 4K-class backing store costs one step", () => {
  const caps = { renderer: ANGLE("NVIDIA, NVIDIA GeForce GTX 1650"), cores: 8, memory: 8, dpr: 1, screenW: 1920, screenH: 1080 };
  assert.equal(detectTier(caps).tier, "high");
  const big = detectTier({ ...caps, dpr: 2, screenW: 3840, screenH: 2160 });
  assert.equal(big.tier, "medium");
  assert.ok(big.reasons.some((r) => /large/.test(r)));
});

test("empty capability object does not throw and lands on medium", () => {
  assert.equal(detectTier().tier, "medium");
  assert.equal(detectTier({}).tier, "medium");
});

test("tier settings map to the documented renderer configuration", () => {
  assert.deepEqual(tierSettings("low"), { tier: "low", antialias: false, maxPixelRatio: 1, shadows: false, shadowMapSize: 0, softShadows: false, env: false, particles: false });
  assert.deepEqual(tierSettings("medium"), { tier: "medium", antialias: true, maxPixelRatio: 1.5, shadows: true, shadowMapSize: 1024, softShadows: false, env: false, particles: true });
  assert.deepEqual(tierSettings("high"), { tier: "high", antialias: true, maxPixelRatio: 2, shadows: true, shadowMapSize: 2048, softShadows: true, env: true, particles: true });
  assert.equal(tierSettings("bogus").tier, "high");
  assert.deepEqual(TIERS, ["low", "medium", "high"]);
  assert.deepEqual(MODES, ["auto", "low", "medium", "high"]);
});

test("resolveQuality: auto follows detection, overrides win, reduced motion only sets the default", () => {
  assert.equal(resolveQuality({}, "low").tier, "low");
  assert.equal(resolveQuality({ mode: "auto" }, "high").tier, "high");
  assert.equal(resolveQuality({ mode: "medium" }, "high").tier, "medium");
  assert.equal(resolveQuality({ mode: "nonsense" }, "low").mode, "auto");
  assert.equal(resolveQuality({}, "high").settings.shadowMapSize, 2048);
  assert.equal(resolveQuality({}, "medium", false).animations, true);
  assert.equal(resolveQuality({}, "medium", true).animations, false);
  assert.equal(resolveQuality({ animations: true }, "medium", true).animations, true);
  assert.equal(resolveQuality({ animations: false }, "medium", false).animations, false);
  assert.equal(resolveQuality(undefined).tier, "medium");
});
