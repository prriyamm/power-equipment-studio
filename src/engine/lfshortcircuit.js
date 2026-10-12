/* ============================================================================
 * Short circuit for load-flow cases. Sources come from the slack and PV buses:
 * each gets a Thevenin source reactance x_source_pu (system base, default 0.1)
 * at the bus. Per-bus optional `kv` (default 1.0) converts to kA; without a kv
 * the results are in pu on base_mva (kV = 1 gives ibase = base/√3 "kA" per pu,
 * so the pu current is also returned directly).
 * Reuses shortCircuit() from shortcircuit.js (IEC 60909 equivalent voltage source).
 * ========================================================================== */
import { shortCircuit } from "./shortcircuit.js";

export function lfSources(caseData) {
  return caseData.buses
    .filter((b) => { const t = String(b.type ?? "PQ").toUpperCase(); return t === "SLACK" || t === "PV"; })
    .map((b) => ({ bus: b.id, r: 0, x: b.x_source_pu ?? 0.1, id: `G${b.id}`, kind: String(b.type).toUpperCase() === "SLACK" ? "utility" : "generator" }));
}

/**
 * @returns { method, buses:[{id, kv, kv_given, ik_ka, ik_pu, xr, kappa, ip_ka, ip_pu, sk_mva, c}], sources, base_mva }
 *   ik_pu is I″k in pu on the system base: c·1/|Z|.
 */
export function lfShortCircuit(caseData, opts = {}) {
  const kvs = caseData.buses.map((b) => (typeof b.kv === "number" && b.kv > 0 ? b.kv : 1.0));
  const sources = lfSources(caseData);
  if (!sources.length) throw new Error("No slack or PV bus: nothing to supply fault current.");
  const r = shortCircuit(caseData, kvs, sources, opts);
  const base = caseData.base_mva ?? 100;
  const buses = r.buses.map((b, i) => {
    const kvGiven = typeof caseData.buses[i].kv === "number" && caseData.buses[i].kv > 0;
    const ibase = base / (Math.sqrt(3) * b.kv);
    return { ...b, kv_given: kvGiven, ik_pu: b.ik_ka / ibase, ip_pu: b.ip_ka / ibase };
  });
  return { ...r, buses, base_mva: base };
}
