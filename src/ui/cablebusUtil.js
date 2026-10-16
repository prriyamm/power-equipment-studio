/* Pure helpers for the Cable bus workspace (no DOM, no React): unit-tested in tests/cablebusUi.test.mjs. */

/* Stacked tiers the workspace offers. The engine lays out any number of tiers (candidate_patterns builds one
   row of complete A-B-C sets per tier); 4 is the limit asked for, not an engine limit. */
export const MAX_TIERS = 4;
export const TIER_CHOICES = [1, 2, 3, 4];
/* Conductors-per-phase choices in the Check form. */
export const COUNT_CHOICES = [1, 2, 3, 4, 5, 6, 8, 9, 10, 12];

/* Every tier must hold complete A-B-C sets: 3n conductors in `tiers` tiers, each a multiple of 3, which is
   the same as n being a multiple of tiers (Python cablebus.candidate_patterns raises otherwise). */
export function tierCompat(n, tiers) {
  const total = 3 * n;
  const valid = COUNT_CHOICES.filter((c) => c % tiers === 0);
  if (!Number.isInteger(n) || !Number.isInteger(tiers) || n < 1 || tiers < 1) {
    return { ok: false, per_tier: null, valid, message: "Conductors per phase and tiers must be whole numbers of at least 1." };
  }
  if (n % tiers === 0) return { ok: true, per_tier: total / tiers, valid, message: null };
  const list = valid.length ? valid.join(", ") : "none of the listed values";
  const why = total % tiers
    ? `${total} conductors (3 phases x ${n}) cannot be split evenly into ${tiers} tiers`
    : `${total / tiers} conductors per tier is not a multiple of 3`;
  return { ok: false, per_tier: total / tiers, valid,
    message: `${tiers} tiers need conductors per phase divisible by ${tiers} so every tier holds complete A-B-C sets (${list}). ${n} per phase: ${why}.` };
}

/* Largest tier count <= `tiers` that fits n conductors per phase (always >= 1). */
export function fittingTiers(n, tiers) {
  for (let t = Math.min(tiers, MAX_TIERS); t > 1; t--) if (n % t === 0) return t;
  return 1;
}

/* Simulate tab: the first-cycle phase-current peak at the selected closing angle, found from the plotted
   waveforms (peak over phases, with the phase that carries it), next to the worst case over all closing
   angles that the engine reports (peak_current_ka). The two differ whenever the selected angle is not the
   angle that maximises the current peak (the default angle maximises force, not current). */
export function peakSummary(sc) {
  const t = sc.t_s, dt = t.length > 1 ? t[1] - t[0] : 0;
  const n1 = Math.min(t.length, dt > 0 && sc.frequency_hz ? Math.round(1 / (sc.frequency_hz * dt)) + 1 : t.length);
  let best = { v: 0, k: 0, p: "A" };
  for (const p of ["A", "B", "C"]) {
    for (let k = 0; k < n1; k++) { const v = sc.phase_current_a[p][k]; if (Math.abs(v) > Math.abs(best.v)) best = { v, k, p }; }
  }
  return {
    selected: { ka: Math.abs(best.v) / 1000, phase: best.p, k: best.k, v: best.v, angle_deg: sc.closing_angle_deg },
    worst: { ka: sc.peak_current_ka, phase: sc.peak_current_phase, angle_deg: sc.peak_current_angle_deg },
  };
}

/* Let-through I2t tile: without a clearing time the engine integrates over the whole simulation window, so the
   tile must not present that as the let-through energy of a fault. */
export function i2tInfo(sc) {
  const window_s = sc.t_s[sc.t_s.length - 1];
  return sc.clearing_s
    ? { has_clearing: true, duration_s: sc.clearing_s, window_s }
    : { has_clearing: false, duration_s: null, window_s };
}
