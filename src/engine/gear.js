/* ============================================================================
 * Switchgear lineup builder: assigns the incoming and outgoing circuits of a
 * gear bus to breaker cubicles, sizes breaker frames and trip ratings from the
 * load-flow currents, and checks conductor protection.
 *
 *   NEC 240.6(A)   standard ampere ratings
 *   NEC 240.4(B)   next higher standard rating allowed up to 800 A
 *   NEC 240.4(C)   above 800 A the conductor ampacity must be ≥ the device rating
 *   NEC 215.3      feeder OCPD ≥ 125 % of continuous load (unless 100 % rated)
 * Frame sizes follow common ANSI C37.13 LV power breaker and C37.06 MV ratings;
 * they are typical values, not a specific manufacturer's catalogue.
 * ========================================================================== */
import { EQUIPMENT, CONNECTORS } from "./system.js";

export const NEC_240_6 = [15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500,
  600, 700, 800, 1000, 1200, 1600, 2000, 2500, 3000, 4000, 5000, 6000];
export const LV_FRAMES = [800, 1600, 2000, 3200, 4000, 5000];
export const MV_FRAMES = [1200, 2000, 3000];
// typical section geometry, inches (W × H × D)
export const SECTION_IN = { lv: { w: 22, wMain: 30, h: 90, d: 60, perSection: 3 }, mv: { w: 36, wMain: 36, h: 95, d: 96, perSection: 2 } };

export const nextStandard = (a) => NEC_240_6.find((r) => r >= a - 1e-9) ?? null;
export const frameFor = (trip, mv) => (mv ? MV_FRAMES : LV_FRAMES).find((f) => f >= trip) ?? null;

/**
 * @param sys       system model
 * @param analysis  result of analyseSystem
 * @param gearId    id of a switchgear / mcc / panel
 * @param opts      { continuous: share of load treated as continuous (default 1), rated100: false }
 */
export function buildLineup(sys, analysis, gearId, opts = {}) {
  const raw = sys.equipment.find((e) => e.id === gearId);
  if (!raw) throw new Error(`No equipment "${gearId}"`);
  const g = { ...EQUIPMENT[raw.type].defaults, ...raw };
  const mv = g.kv > 1;
  const geo = mv ? SECTION_IN.mv : SECTION_IN.lv;
  const cont = opts.continuous ?? 1, factor = opts.rated100 ? 1 : 1.25;
  const er = analysis?.equipment?.[gearId];
  const busKey = `${gearId}.${EQUIPMENT[g.type].terminals[0]}`;

  const circuits = [];
  for (const c0 of sys.connectors) {
    if (c0.from !== busKey && c0.to !== busKey) continue;
    const c = { ...CONNECTORS[c0.kind].defaults, ...c0 };
    const farEnd = c.from === busKey ? c.to : c.from;
    const farId = farEnd.split(".")[0];
    const far = sys.equipment.find((e) => e.id === farId);
    const res = analysis?.connectors?.[c.id];
    // incoming when power flows into this bus (or the far end is a source / transformer secondary)
    let incoming;
    if (res && !res.open && res.dir != null) incoming = (c.to === busKey) === (res.dir > 0);
    else incoming = far && (far.type === "utility" || far.type === "generator" || (far.type === "transformer" && farEnd.endsWith(".lv")));
    const load_a = res && !res.open ? res.i_a : 0;
    const amp = res?.ampacity_a ?? null;
    let trip = nextStandard(Math.max(load_a * (incoming ? 1 : 1 + (factor - 1) * cont), 15));
    // incoming mains are sized to the bus (or the transformer secondary) rather than today's load
    if (incoming) {
      const src = far?.type === "transformer" ? ({ ...EQUIPMENT.transformer.defaults, ...far }) : null;
      const fla = src ? (src.kva / (Math.sqrt(3) * g.kv)) : g.bus_a;
      trip = nextStandard(Math.min(Math.max(fla, load_a), g.bus_a)) ?? g.bus_a;
    }
    const checks = [];
    if (amp != null && !incoming) {
      const ok = trip <= 800 ? trip <= nextStandard(amp) : amp >= trip;
      checks.push({ name: trip <= 800 ? "Conductor protected (240.4(B) next size up)" : "Conductor ampacity ≥ trip (240.4(C))", ok, value: amp, limit: trip });
    }
    if (!incoming) checks.push({ name: `Trip ≥ ${opts.rated100 ? "100" : "125"} % of load (215.3)`, ok: trip >= load_a * factor * cont - 1e-9, value: trip, limit: load_a * factor * cont });
    const frame = frameFor(trip, mv);
    if (frame == null) checks.push({ name: "Frame available", ok: false, value: trip, limit: (mv ? MV_FRAMES : LV_FRAMES).at(-1) });
    circuits.push({ tag: c.id, kind: incoming ? "main" : "feeder", to: far ? (far.name || far.id) : farId, toId: farId, conductor: c.kind === "direct" ? "close-coupled" : `${c.sets}×3×${c.size} ${c.material}`,
      load_a, ampacity_a: amp, trip, frame, open: c.closed === false, checks, ok: checks.every((k) => k.ok) });
  }
  // place: mains first (one per section on LV, own section), then feeders filling sections top-down
  const mains = circuits.filter((c) => c.kind === "main"), feeders = circuits.filter((c) => c.kind === "feeder");
  const sections = [];
  for (const m of mains) sections.push({ main: true, width_in: geo.wMain, cubicles: [{ ...m, pos: 0, size: mv ? 1 : 2 }] });
  let cur = null;
  for (const f of feeders.sort((a, b) => b.frame - a.frame)) {
    const size = !mv && f.frame >= 3200 ? 2 : 1;
    if (!cur || cur.used + size > geo.perSection) { cur = { main: false, width_in: geo.w, cubicles: [], used: 0 }; sections.push(cur); }
    cur.cubicles.push({ ...f, pos: cur.used, size }); cur.used += size;
  }
  const want = Math.max(g.sections ?? 1, sections.length);
  while (sections.length < want) sections.push({ main: false, width_in: geo.w, cubicles: [], used: 0 });
  for (const s of sections) {
    const used = s.cubicles.reduce((a, c) => a + c.size, 0);
    for (let p = used; p < geo.perSection; p++) s.cubicles.push({ kind: "spare", tag: "SPACE", pos: p, size: 1 });
  }
  const width_in = sections.reduce((a, s) => a + s.width_in, 0);
  return {
    gear: { id: g.id, name: g.name || g.id, kv: g.kv, bus_a: g.bus_a, sc_ka: g.sc_ka, mv, type: g.type },
    result: er, sections, circuits, geometry: { ...geo, width_in, sections: sections.length },
    ok: circuits.every((c) => c.ok) && (er?.sc_duty_pct == null || er.sc_duty_pct <= 100) && (er?.loading_pct == null || er.loading_pct <= 100),
    notes: [
      "Trip ratings: NEC 240.6(A) standard sizes; feeders at 125 % of load (215.3) unless the device is 100 % rated.",
      "Frames are typical ANSI C37.13 (LV) / C37.06 (MV) sizes, not a specific manufacturer's catalogue.",
      "Section widths and heights are typical; confirm against the manufacturer's layout rules.",
    ],
  };
}
