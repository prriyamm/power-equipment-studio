/* Pure animation state for the virtual short-circuit lab test (no THREE, no DOM; unit-tested).

   Everything the 3D / SVG views draw is a function of the calculated run (engine/scLabTest.js runLabTest) and the
   playback time t (test seconds). The failure time and mode come from the calculation; the effects (conductor
   deflection, fragments, arc flash, sparks, smoke, shake) are illustrative and driven by "effect time"
   e = (t - t_fail) x slow-motion factor, i.e. screen seconds since the failure.
   Scene frame: metres, x across the enclosure, y up, z along the run. */

export const TIER_BUDGET = {
  low: { fragments: 3, sparks: 0, smoke: 0, shake: false, light: false },
  medium: { fragments: 6, sparks: 300, smoke: 4, shake: true, light: true },
  high: { fragments: 10, sparks: 900, smoke: 8, shake: true, light: true },
};
export const budgetFor = (tier) => TIER_BUDGET[tier] || TIER_BUDGET.medium;

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
/** Small deterministic generator (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Linear interpolation of a uniformly sampled series at time t. */
export function sampleAt(arr, t, dt) {
  const n = arr.length;
  const x = clamp(t / dt, 0, n - 1);
  const k = Math.min(n - 2, Math.floor(x));
  if (n < 2) return arr[0];
  const f = x - k;
  return arr[k] * (1 - f) + arr[k + 1] * f;
}

/* ------------------------------------------------------------------ layout */
/** Specimen geometry in metres from a buildContext() result. */
export function labLayout(ctx, n_spans = 3, base = 0.4) {
  const inp = ctx.inp, od = ctx.od;
  const rows = ctx.phase_idx.map((i) => ({ i, phase: ctx.cs[i].group, x_mm: ctx.cs[i].x_mm, y_mm: ctx.cs[i].y_mm }));
  const xs = rows.map((r) => r.x_mm), ys = rows.map((r) => r.y_mm);
  const xc = (Math.min(...xs) + Math.max(...xs)) / 2, yc = (Math.min(...ys) + Math.max(...ys)) / 2;
  const w_in = inp.enclosure_width_mm || Math.max(...xs) - Math.min(...xs) + 2 * od + 50;
  const h_in = inp.enclosure_height_mm || Math.max(...ys) - Math.min(...ys) + 2 * od + 70;
  const ts = inp.side_thickness_mm, tc = inp.cover_thickness_mm;
  const W = w_in + 2 * ts, H = h_in + 2 * tc;
  const bx = (r) => (ts + w_in / 2 + (r.x_mm - xc)) / 1000, by = (r) => (tc + h_in / 2 + (r.y_mm - yc)) / 1000;
  const cables = rows.map((r) => ({ i: r.i, phase: r.phase, x: bx(r), y: by(r) + base }));
  const tiers = [...new Set(rows.map((r) => r.y_mm))].sort((a, b) => a - b);
  const lip = 14, thick = 25.4;
  const plates = tiers.map((ty) => {
    const tr = rows.filter((r) => r.y_mm === ty);
    const yt = by(tr[0]) * 1000 + base * 1000;
    return {
      x0: ts / 1000, x1: (W - ts) / 1000, y0: (yt - od / 2 - lip) / 1000, y1: (yt + od / 2 + lip) / 1000, d: thick / 1000,
      holes: tr.map((r) => ({ x: bx(r), y: by(r) + base, r: (od / 2 + 0.5) / 1000 })),
    };
  });
  const span = inp.support_span_m;
  const zs = Array.from({ length: n_spans + 1 }, (_, k) => k * span);
  return { od: od / 1000, W: W / 1000, H: H / 1000, ts: ts / 1000, tc: tc / 1000, cables, plates, zs, span, n_spans, L: n_spans * span, tiers: tiers.length, base };
}

/* ------------------------------------------------------------------ shapes */
/** Normalised fixed-fixed deflection shape, peak 1 at mid span (s in 0..1). */
export const spanShape = (s) => (s <= 0 || s >= 1 ? 0 : 16 * s * s * (1 - s) * (1 - s));

/** Deflection weight at z. After the failure the two spans next to the failed block act as one long span. */
export function shapeWeight(z, zs, failedBlock = null) {
  const n = zs.length - 1;
  if (z <= zs[0] || z >= zs[n]) return 0;
  let a = 0;
  while (a < n - 1 && z > zs[a + 1]) a++;
  let z0 = zs[a], z1 = zs[a + 1];
  if (failedBlock !== null && failedBlock > 0 && failedBlock < n && (a === failedBlock - 1 || a === failedBlock)) {
    z0 = zs[failedBlock - 1]; z1 = zs[failedBlock + 1];
  }
  return spanShape((z - z0) / (z1 - z0));
}

/* ------------------------------------------------------------------ colours */
const lerp = (a, b, f) => a.map((v, k) => v + (b[k] - v) * f);
const GREEN = [63, 174, 90], AMBER = [232, 179, 74], RED = [224, 69, 58];
/** Block tint by utilisation: green to amber at 60 %, red at 100 %. rgb 0..255. */
export function utilColor(u) {
  const x = clamp(u, 0, 1.2);
  if (x <= 0.6) return lerp(GREEN, AMBER, x / 0.6);
  return lerp(AMBER, RED, clamp((x - 0.6) / 0.4, 0, 1));
}

/* ------------------------------------------------------------------ fragments */
/** Split a block plate into nx x ny jittered cells (they tile the plate). Cells carry launch velocity and spin. */
export function fragmentCells(plate, z, nx, ny, seed = 7) {
  const r = rng(seed);
  const cut = (n) => { const a = [0]; for (let k = 1; k < n; k++) a.push(k / n + (r() - 0.5) * 0.5 / n); a.push(1); return a; };
  const xs = cut(nx), ys = cut(ny);
  const cx0 = (plate.x0 + plate.x1) / 2;
  const out = [];
  for (let a = 0; a < nx; a++) for (let b = 0; b < ny; b++) {
    const w = (xs[a + 1] - xs[a]) * (plate.x1 - plate.x0), h = (ys[b + 1] - ys[b]) * (plate.y1 - plate.y0);
    const x = plate.x0 + (xs[a] + xs[a + 1]) / 2 * (plate.x1 - plate.x0), y = plate.y0 + (ys[b] + ys[b + 1]) / 2 * (plate.y1 - plate.y0);
    out.push({
      size: [w, h, plate.d], p0: [x, y, z],
      v: [(x - cx0) * (1.6 + r()) + (r() - 0.5) * 0.8, 1.2 + r() * 2.8 + (b / Math.max(1, ny - 1)) * 0.8, (r() - 0.5) * 2.4],
      om: [(r() - 0.5) * 14, (r() - 0.5) * 14, (r() - 0.5) * 14],
    });
  }
  return out;
}
const G_EFFECT = 5.0;
/** Ballistic pose of a fragment at effect time e (s): position, Euler rotation; rests on the floor (y = 0). */
export function fragmentPose(f, e) {
  const ee = Math.max(0, e);
  const half = Math.min(f.size[1], f.size[2]) / 2;
  const a = 0.5 * G_EFFECT, b = -f.v[1], c = half - f.p0[1];
  const tl = c >= 0 && f.v[1] <= 0 ? 0 : (-b + Math.sqrt(Math.max(0, b * b - 4 * a * c))) / (2 * a); // first floor contact
  const landed = ee >= tl;
  const te = Math.min(ee, tl);
  const y = landed ? half : f.p0[1] + f.v[1] * ee - a * ee * ee;
  const slide = landed ? 0.12 * (1 - Math.exp(-(ee - tl) / 0.3)) : 0; // skids to a stop
  return {
    pos: [f.p0[0] + f.v[0] * (te + slide), y, f.p0[2] + f.v[2] * (te + slide)],
    rot: [f.om[0] * te, f.om[1] * te, f.om[2] * te], landed,
  };
}

/* ------------------------------------------------------------------ sparks, smoke, flash */
const SPARK_G = 6.0;
/** Fill position / colour buffers of `count` sparks at effect time e. Returns the number alive. */
export function fillSparks(pos, col, count, e, origin, seed = 11) {
  const r = rng(seed);
  let alive = 0;
  for (let i = 0; i < count; i++) {
    const th = r() * Math.PI * 2, el = -0.15 + r() * 1.15, sp = 1.5 + r() * 5.5, delay = r() * 0.12, life = 0.5 + r() * 1.3;
    const age = e - delay;
    const j = i * 3;
    if (age < 0 || age > life) { pos[j] = origin[0]; pos[j + 1] = origin[1]; pos[j + 2] = origin[2]; col[j] = col[j + 1] = col[j + 2] = 0; continue; }
    const ce = Math.cos(el), vx = Math.cos(th) * ce * sp, vy = Math.sin(el) * sp, vz = Math.sin(th) * ce * sp;
    pos[j] = origin[0] + vx * age;
    pos[j + 1] = Math.max(0.01, origin[1] + vy * age - 0.5 * SPARK_G * age * age);
    pos[j + 2] = origin[2] + vz * age;
    const a = 1 - age / life, hot = clamp(1 - age / (life * 0.6), 0, 1);
    col[j] = a; col[j + 1] = a * (0.35 + 0.55 * hot); col[j + 2] = a * (0.1 + 0.6 * hot * hot);
    alive++;
  }
  return alive;
}

/** Smoke billboards (up to n) at effect time e. */
export function smokePuffs(e, origin, n, seed = 5) {
  const r = rng(seed), out = [];
  for (let i = 0; i < n; i++) {
    const delay = 0.05 + i * 0.1, age = e - delay;
    const dx = (r() - 0.5) * 0.25, dz = (r() - 0.5) * 0.25;
    if (age <= 0) { out.push({ pos: origin, size: 0, opacity: 0 }); continue; }
    out.push({
      pos: [origin[0] + dx * age * 3, origin[1] + 0.05 + 0.3 * age, origin[2] + dz * age * 3],
      size: 0.18 + 0.55 * age, opacity: 0.45 * Math.min(1, age / 0.25) * clamp(1 - age / 3.4, 0, 1),
    });
  }
  return out;
}

/** Arc flash intensity 0..1 and colour mix (0 white-blue, 1 orange) at effect time e. */
export function flashAt(e) {
  if (e < 0) return { i: 0, mix: 0 };
  const rise = Math.min(1, e / 0.015);
  return { i: rise * Math.exp(-e / 0.13), mix: clamp(e / 0.45, 0, 1) };
}
/** Camera shake offset (m) at effect time e. */
export function shakeAt(e) {
  if (e < 0 || e > 1.2) return [0, 0, 0];
  const a = 0.018 * Math.exp(-e / 0.16);
  return [a * Math.sin(e * 83), a * Math.cos(e * 71), a * 0.6 * Math.sin(e * 59 + 1)];
}

/** Whip amplitude multiplier (of the visual deflection) after the failure: release, overshoot, ring-down. */
export function whipAt(e) {
  if (e <= 0) return 0;
  return 5.5 * (1 - Math.exp(-e / 0.14)) * (1 + 0.35 * Math.cos((2 * Math.PI * e) / 0.9) * Math.exp(-e / 2)) * Math.exp(-e / 9);
}

/* ------------------------------------------------------------------ state */
const fragCache = new WeakMap();
function fragmentsFor(run, layout, budget) {
  const key = layout;
  let m = fragCache.get(key);
  if (!m) { m = new Map(); fragCache.set(key, m); }
  const k = `${run.failure.block_index}:${budget.fragments}`;
  if (!m.has(k)) {
    const nx = Math.max(2, budget.fragments), ny = budget.fragments >= 10 ? 2 : 1;
    const z = layout.zs[Math.min(run.failure.block_index, layout.zs.length - 1)];
    m.set(k, layout.plates.flatMap((p, pi) => fragmentCells(p, z, nx, ny, 31 + pi * 17)));
  }
  return m.get(k);
}

/** Failure location (arc flash origin): the failed block, at the failed conductor. */
export function failureOrigin(run, layout) {
  const c = layout.cables.find((x) => x.i === run.failure.conductor_index) || layout.cables[0];
  return [c.x, c.y, layout.zs[Math.min(run.failure.block_index, layout.zs.length - 1)]];
}

/**
 * State at test time t_s (s). opts: { scale (slow-motion factor, default 100), tier }.
 * Returns the cursor, per-conductor deflection (m, visual scale) and temperature fraction, block utilisation,
 * and, only after the failure, fragments, flash, sparks/smoke parameters and shake.
 */
export function labState(run, layout, t_s, opts = {}) {
  const { scale = 100, tier = "medium" } = opts;
  const budget = budgetFor(tier);
  const dt = run.t_s[1] - run.t_s[0];
  const t = clamp(t_s, 0, run.t_s[run.t_s.length - 1]);
  const fail = run.failure;
  const failed = !!fail && t >= fail.t_s;
  const since = failed ? t - fail.t_s : 0;
  const e = failed ? since * scale : -1;
  const fpk = run.peak_force_n_per_m || 1;
  const vis = (run.deflection.visual_mm || 15) / 1000;
  const util = Math.max(0, sampleAt(run.utilisation, t, dt));
  const blockU = run.block_ratio ? sampleAt(run.block_ratio, t, dt) : 0;
  const span = run.limits.damage_c - run.limits.t0;
  const whip = failed ? whipAt(e) : 0;
  const conductors = layout.cables.map((c) => {
    const fx = sampleAt(run.fx[c.i], t, dt), fy = sampleAt(run.fy[c.i], t, dt);
    let dx = (fx / fpk) * vis, dy = (fy / fpk) * vis;
    if (failed) {
      // after release the merged span flexes more and the conductor whips along the force direction it had at failure
      const f0x = sampleAt(run.fx[c.i], fail.t_s, dt), f0y = sampleAt(run.fy[c.i], fail.t_s, dt), m0 = Math.hypot(f0x, f0y) || 1;
      dx = dx * 2.2 + (f0x / m0) * vis * whip; dy = dy * 2.2 + (f0y / m0) * vis * whip;
    }
    const T = sampleAt(run.temp_c[c.i], t, dt);
    return { i: c.i, dx, dy, temp_c: T, temp_frac: clamp((T - run.limits.t0) / span, 0, 1.5) };
  });
  const st = {
    t, k: t / dt, failed, since, e, util, block_util: blockU, scale, tier, budget,
    blocks: layout.zs.map((_, b) => ({ util: failed && b === fail.block_index ? 1 : blockU, broken: failed && b === fail.block_index })),
    conductors, failed_block: failed ? fail.block_index : null, whip,
    fragments: [], flash: { i: 0, mix: 0 }, shake: [0, 0, 0], origin: null,
  };
  if (failed) {
    st.origin = failureOrigin(run, layout);
    st.fragments = fragmentsFor(run, layout, budget).map((f) => ({ ...fragmentPose(f, e), size: f.size }));
    st.flash = flashAt(e);
    st.shake = budget.shake ? shakeAt(e) : [0, 0, 0];
  }
  return st;
}

/** Time the animation is worth playing to: the end of the test, or a few screen seconds after the failure. */
export function playEnd(run, scale, post_s = 4) {
  const end = run.t_s[run.t_s.length - 1];
  return run.failure ? Math.min(end, run.failure.t_s + post_s / scale) : end;
}
/** Time of the "final state image" used when animations are off. */
export function stillTime(run, scale) {
  if (run.failure) return Math.min(run.t_s[run.t_s.length - 1], run.failure.t_s + 0.9 / scale);
  const u = run.utilisation; let k = 0;
  for (let j = 0; j < u.length; j++) if (u[j] > u[k]) k = j;
  return run.t_s[k];
}
