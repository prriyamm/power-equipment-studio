/* ============================================================================
 * Cable reactance for the System model: NEC Chapter 9 Table 9 plus DERIVED
 * values for sizes the table does not list.
 *
 * Table 9 has no rows for 700, 800 or 900 kcmil and stops at 1000 kcmil, but the
 * System's resistance (pecalc conductor model) and ampacity (NEC 310.16/310.17
 * data) cover 700–2000 kcmil. This module fills the reactance gap so those sizes
 * can be modelled. The Table 9 data file (pecalc/data/reactance_nec_table9.json)
 * is NOT changed: it must stay identical to the Python pecalc data.
 *
 * Every value produced here for a size missing from Table 9 is DERIVED, not a
 * published value, and is flagged as such (derived: true) to callers.
 *
 * Method, per conduit column (pvc, aluminum, steel):
 *   XL per conductor ∝ ln(GMD / GMR), and both GMD (cable OD) and GMR scale
 *   roughly with conductor diameter ∝ sqrt(kcmil). So XL is close to linear in
 *   ln(kcmil), and that is the variable used for interpolation/extrapolation.
 *   - 700, 800, 900 kcmil: linear in ln(kcmil) between the neighbouring table rows
 *     (600–750 and 750–1000).
 *   - 1250–2000 kcmil: linear in ln(kcmil) extrapolated from the 750 and 1000 rows,
 *     clamped at a floor (below).
 *
 * Floor: three cables in a conduit can never be closer together than touching.
 * The positive-sequence reactance of three touching cables (GMD = cable OD, GMR =
 * 0.7788 r of the conductor) is therefore a physical lower bound for cable in a
 * non-magnetic raceway, and steel conduit only adds reactance on top of it. The
 * floor for each size is that touching-cable reactance, computed from the pecalc
 * conductor geometry (bare diameter + typical 600 V insulation wall). At 1000 kcmil
 * it is about 0.025 Ω/1000 ft against Table 9's 0.037, so it only binds if a
 * steep extrapolation would otherwise run below what the geometry allows.
 * ========================================================================== */
import TABLE9 from "./pecalc/data/reactance_nec_table9.json" with { type: "json" };
import { reactanceOhmPerM, cableOdMm } from "./pecalc/conductors.js";

export const DERIVED_META = {
  status: "DERIVED — UNVERIFIED (interpolated/extrapolated from NEC Table 9, not a published value)",
  method: "Linear in ln(kcmil): interpolated between neighbouring Table 9 rows (700, 800, 900 kcmil); extrapolated from the 750 and 1000 kcmil rows (1250–2000 kcmil), floored at the touching-cable reactance from the conductor geometry.",
  units: "ohm per 1000 ft per conductor, 60 Hz",
  table9_status: TABLE9._meta.status,
};
export const RACEWAYS = ["pvc", "aluminum", "steel"];
const INTERP = { "700": ["600", "750"], "800": ["750", "1000"], "900": ["750", "1000"] };
const EXTRAP = ["1250", "1500", "1750", "2000"];
export const DERIVED_SIZES = [...Object.keys(INTERP), ...EXTRAP];

/** Touching-cable reactance (ohm / 1000 ft): the lower bound used as the extrapolation floor. */
export function reactanceFloorPer1000ft(size) {
  return reactanceOhmPerM(size, cableOdMm(size)) * 304.8;
}

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const lnLerp = (s, a, b, xa, xb) => xa + ((Math.log(+s) - Math.log(+a)) / (Math.log(+b) - Math.log(+a))) * (xb - xa);

function build() {
  const out = {};
  for (const rw of RACEWAYS) {
    const col = TABLE9[rw], row = {};
    for (const [s, [a, b]] of Object.entries(INTERP)) row[s] = r4(lnLerp(s, a, b, col[a], col[b]));
    for (const s of EXTRAP) row[s] = r4(Math.max(lnLerp(s, "750", "1000", col["750"], col["1000"]), reactanceFloorPer1000ft(s)));
    out[rw] = row;
  }
  return out;
}
/** The derived values, per raceway and size (ohm / 1000 ft). Never Table 9 values. */
export const DERIVED_XL = build();

/**
 * XL per conductor, ohm per 1000 ft, for cable in the given raceway.
 * Returns { xl, derived } — derived is true when the value is not from NEC Table 9 — or null for an unknown size.
 */
export function reactancePer1000ft(size, raceway = "steel") {
  const rw = TABLE9[raceway] ? raceway : "steel";
  const s = String(size);
  if (TABLE9[rw][s] != null) return { xl: TABLE9[rw][s], derived: false };
  if (DERIVED_XL[rw][s] != null) return { xl: DERIVED_XL[rw][s], derived: true };
  return null;
}
export const isDerivedReactance = (size) => DERIVED_SIZES.includes(String(size));
