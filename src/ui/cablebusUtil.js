/* Pure helpers for the Cable bus workspace (no DOM, no React): unit-tested in tests/cablebusUi.test.mjs. */
import * as cond from "../engine/pecalc/conductors.js";
import { libraryEntries, cableSpec, figure3Patterns, patternPositions } from "../engine/pecalc/cablebus.js";

/* Cable type choices in the Check form. "dlo_2000v" takes its sizes from the cable library (data/dlo_cables.json). */
export const CABLE_TYPE_CHOICES = [
  ["standard", "Standard building wire"],
  ["dlo_2000v", "DLO 2000 V (Southwire; AWC 1111 kcmil)"],
  ["mv_construction", "Existing MV construction"],
];
export const DLO_DEFAULT_ID = "southwire_dlo_2000v:444.4";

/* Conductor label and diameter for results and the 3D view: a library cable carries its own values. */
export function conductorLabel(inp, cableData) { return cableData ? cableData.size_label : cond.sizeLabel(inp.size); }
export function conductorDiameterMm(inp, cableData) { return cableData ? cableData.diameter_mm : cond.diameterMm(inp.size); }

/* Library rows for the DLO size select. */
export function libraryOptions() {
  return libraryEntries().map((e) => ({ id: e.cable_id, label: `${e.size_label} · ${e.manufacturer}` }));
}

/* Engine errors name a library cable by its id and the input field ("southwire_dlo_2000v:444.4 is rated 2000 V;
   voltage_v 2400 ..."). The form shows the cable as the user picked it and the field by its label. */
export function libraryErrorText(msg, f) {
  if (f.cable_type !== "dlo_2000v" || !f.cable_id) return msg;
  let spec;
  try { spec = cableSpec(f.cable_id); } catch { return msg; }
  return msg.split(spec.cable_id).join(`${spec.manufacturer} DLO ${spec.size_label}`)
    .replace(/\bvoltage_v\b/g, "system voltage").replace(/\binsulation_temp_c\b/g, "insulation rating");
}

/* Form state after a cable type change. DLO forces copper, the 90 C rating and a non-calculated ampacity method
   (the engine refuses calculated ampacity for library cables). Leaving DLO clears the library id. */
export function applyCableType(f, type) {
  if (type === "dlo_2000v") {
    const id = f.cable_type === "dlo_2000v" && f.cable_id ? f.cable_id : DLO_DEFAULT_ID;
    const spec = cableSpec(id);
    return { ...f, cable_type: type, cable_id: id, size: spec.size, material: "Cu", insulation_temp_c: 90,
      ampacity_method: f.ampacity_method === "calculated" ? "auto" : f.ampacity_method };
  }
  // Back to a building-wire size: a library size (e.g. 444.4) is not in the standard list, so use 750 kcmil.
  const size = cond.SIZES.includes(f.size) ? f.size : "750";
  return { ...f, cable_type: type, cable_id: null, size };
}

/* Layouts follow CSA C22.2 No. 273 Figure 3: 1 to 10 conductors per phase, at most 3 tiers. */
export const MAX_TIERS = 3;
export const TIER_CHOICES = [1, 2, 3];
/* Conductors-per-phase choices in the Check form. */
export const COUNT_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/* Tier counts Figure 3 has for n per phase. */
export function figure3Tiers(n) {
  return [...new Set(figure3Patterns(n).map((p) => p.split("/").length))].sort((a, b) => a - b);
}

/* Arrangement choices for the form: [pattern, label]; "auto" is the best Figure 3 arrangement (with the chosen
   tier count). Labels use the figure's own order, e.g. "3-2 · +ABCA/BCABC". */
export function arrangementChoices(n, tiers) {
  const all = figure3Patterns(n);
  return [["auto", "Best (Figure 3)"], ...all.map((p, k) => [p, `${n}-${k + 1} · ${p}`])
    .filter(([p]) => tiers === null || tiers === undefined || p.split("/").length === tiers)];
}

/* Whether Figure 3 has an arrangement for n per phase in `tiers` tiers (null = any). The engine raises otherwise
   (candidate_patterns); `valid` lists the conductor counts that have this tier count. */
export function tierCompat(n, tiers) {
  const any = tiers === null || tiers === undefined;
  const valid = any ? COUNT_CHOICES : COUNT_CHOICES.filter((c) => figure3Tiers(c).includes(tiers));
  if (!Number.isInteger(n) || n < 1 || (!any && (!Number.isInteger(tiers) || tiers < 1))) {
    return { ok: false, valid, message: "Conductors per phase and tiers must be whole numbers of at least 1." };
  }
  const have = figure3Tiers(n);
  if (!have.length) return { ok: false, valid, message: `CSA 273 Figure 3 covers 1 to 10 conductors per phase (got ${n}).` };
  if (any || have.includes(tiers)) return { ok: true, valid, message: null };
  return { ok: false, valid,
    message: `CSA 273 Figure 3 has no ${tiers}-tier arrangement for ${n} per phase (it has ${have.join(" or ")} tiers).` };
}

/* Largest Figure 3 tier count <= `tiers` for n per phase, or null (any) when there is none. */
export function fittingTiers(n, tiers) {
  const have = figure3Tiers(n).filter((t) => tiers === null || tiers === undefined || t <= tiers);
  return have.length ? have[have.length - 1] : null;
}

/* Layout envelope in pitches for the enclosure auto-size: widest span and most tiers over the arrangements the
   engine may pick (one given pattern, or every Figure 3 arrangement with the chosen tier count). */
export function layoutEnvelope(n, tiers, pattern = "auto") {
  let pats = pattern && pattern !== "auto" ? [pattern] : figure3Patterns(n, tiers);
  if (!pats.length) pats = figure3Patterns(n);
  if (!pats.length) return { span: 3 * n - 1, tiers: 1 };
  try {
    return { span: Math.max(...pats.map((p) => Math.max(...patternPositions(p).map((q) => q[0])))),
      tiers: Math.max(...pats.map((p) => p.split("/").length)) };
  } catch { return { span: 3 * n - 1, tiers: 1 }; }
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
