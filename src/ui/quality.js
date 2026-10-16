/* Graphics quality tiers for the 3D / animated views.

   Pure part (unit-tested): detectTier(caps) picks low | medium | high from a capability object, and
   tierSettings(tier) maps a tier to renderer settings. Browser part: a tiny store that probes the
   machine once, keeps the user's override (Auto / Low / Medium / High plus an Animations switch) in
   localStorage when storage works, and notifies subscribers (viewers, the QualityMenu) on change.
   Nothing touches window/document at import time, so Node tests can import this file. */

export const TIERS = ["low", "medium", "high"];
export const MODES = ["auto", ...TIERS];

const SOFTWARE_GPU = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|mesa offscreen|lavapipe/i;
const DISCRETE_GPU = /nvidia|geforce|quadro|rtx|gtx|radeon (rx|pro|vii)|\brx ?\d{3,4}|apple m\d|arc a\d/i;
const INTEGRATED_GPU = /intel|uhd|iris|hd graphics|mali|adreno|powervr|videocore|radeon(\(tm\))? graphics|vega \d+ graphics/i;

/* caps: { webgl, renderer, cores, memory, dpr, screenW, screenH } (any field may be missing).
   Returns { tier, reasons[] }. Hard floors first (no WebGL, software rasteriser, 2 cores, <= 2 GB),
   then a small score: cores, memory, GPU class, minus a point for very large backing stores. */
export function detectTier(caps = {}) {
  const { webgl = true, renderer = "", cores, memory, dpr = 1, screenW = 0, screenH = 0 } = caps;
  const reasons = [];
  if (!webgl) return { tier: "low", reasons: ["no WebGL"] };
  if (renderer && SOFTWARE_GPU.test(renderer)) return { tier: "low", reasons: [`software renderer (${renderer})`] };
  if (cores != null && cores <= 2) return { tier: "low", reasons: [`${cores} CPU cores`] };
  if (memory != null && memory <= 2) return { tier: "low", reasons: [`${memory} GB memory`] };

  let score = 0;
  if (cores == null) { score += 1; reasons.push("cores unknown"); }
  else if (cores >= 8) { score += 2; reasons.push(`${cores} cores`); }
  else if (cores >= 4) { score += 1; reasons.push(`${cores} cores`); }
  else reasons.push(`${cores} cores`);

  if (memory == null) { score += 1; reasons.push("memory unknown"); }
  else if (memory >= 8) { score += 2; reasons.push(`${memory} GB`); }
  else if (memory >= 4) { score += 1; reasons.push(`${memory} GB`); }
  else reasons.push(`${memory} GB`);

  const gpu = !renderer ? "unknown" : DISCRETE_GPU.test(renderer) ? "discrete" : INTEGRATED_GPU.test(renderer) ? "integrated" : "unknown";
  score += gpu === "discrete" ? 2 : gpu === "unknown" ? 1 : 0;
  reasons.push(`${gpu} GPU`);

  // a 4K-class backing store (e.g. 2560x1440 at DPR 1.5+) costs fill rate on any GPU
  const px = screenW * screenH * dpr * dpr;
  if (px > 8.3e6) { score -= 1; reasons.push("large high-DPI display"); }

  const tier = score >= 6 ? "high" : score <= 1 ? "low" : "medium";
  return { tier, reasons };
}

/* Renderer settings per tier. high is the original behaviour of three/viewer.js. */
export function tierSettings(tier) {
  switch (tier) {
    case "low": return { tier: "low", antialias: false, maxPixelRatio: 1, shadows: false, shadowMapSize: 0, softShadows: false, env: false, particles: false };
    case "medium": return { tier: "medium", antialias: true, maxPixelRatio: 1.5, shadows: true, shadowMapSize: 1024, softShadows: false, env: false, particles: true };
    default: return { tier: "high", antialias: true, maxPixelRatio: 2, shadows: true, shadowMapSize: 2048, softShadows: true, env: true, particles: true };
  }
}

/* Cells across the magnetic-field map (Cable bus Check tab); every zoom step recomputes this many cells on the
   visible window, so the tier sets how much work a step costs. */
export function fieldGridNx(tier) {
  return tier === "low" ? 48 : tier === "high" ? 96 : 64;
}

/* Resolve the effective state from stored prefs + detection. Pure. */
export function resolveQuality({ mode = "auto", animations = null } = {}, autoTier = "medium", reducedMotion = false) {
  const m = MODES.includes(mode) ? mode : "auto";
  const tier = m === "auto" ? autoTier : m;
  const anim = typeof animations === "boolean" ? animations : !reducedMotion;
  return { mode: m, autoTier, tier, animations: anim, reducedMotion, settings: tierSettings(tier) };
}

/* --------------------------------------------------------------- browser store */
const KEY = "psw.graphics";

function readPrefs() {
  try {
    const raw = window.localStorage.getItem(KEY);
    const p = raw ? JSON.parse(raw) : null;
    return p && typeof p === "object" ? { mode: p.mode, animations: p.animations } : {};
  } catch (e) { return {}; }
}
function writePrefs(p) {
  try { window.localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) { /* storage blocked: session only */ }
}

/* One-off capability probe. The WebGL context is released right away. */
export function probeCaps() {
  const caps = { webgl: false, renderer: "" };
  try {
    caps.cores = navigator.hardwareConcurrency || undefined;
    caps.memory = navigator.deviceMemory || undefined;
    caps.dpr = window.devicePixelRatio || 1;
    caps.screenW = window.screen?.width || 0; caps.screenH = window.screen?.height || 0;
  } catch (e) { /* keep defaults */ }
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
    if (gl) {
      caps.webgl = true;
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      caps.renderer = String((dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || "");
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch (e) { /* no WebGL */ }
  return caps;
}

let state = null, detected = null, prefs = null;
const subs = new Set();
let mql = null;

function reducedMotionNow() {
  try { return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; }
}
function recompute() {
  state = resolveQuality(prefs, detected.tier, reducedMotionNow());
  try { document.documentElement.classList.toggle("gfx-no-anim", !state.animations); } catch (e) { /* no DOM */ }
}
function init() {
  if (state) return;
  detected = detectTier(probeCaps());
  prefs = readPrefs();
  recompute();
  try {
    mql = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    mql?.addEventListener?.("change", () => { recompute(); subs.forEach((f) => f(state)); });
  } catch (e) { /* old browser */ }
}

export const quality = {
  /* { mode, autoTier, tier, animations, reducedMotion, settings } */
  get() { init(); return state; },
  detection() { init(); return detected; },
  set(patch) {
    init();
    prefs = { ...prefs, ...patch };
    writePrefs(prefs);
    recompute();
    subs.forEach((f) => f(state));
  },
  subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
};

/* React hook (global UMD React). */
export function useQuality() {
  return React.useSyncExternalStore(quality.subscribe, quality.get);
}
