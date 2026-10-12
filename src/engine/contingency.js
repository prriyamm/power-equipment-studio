/* ============================================================================
 * N-1 branch contingency screening on top of the Newton-Raphson load flow.
 * Each branch is outaged in turn; outages that island the network are reported
 * as "islanding" and not solved. Others are solved warm-started from the base
 * case, then checked for voltage and loading violations.
 * ========================================================================== */
import { runLoadFlow } from "./loadflow.js";

// Does the network stay connected (from the first bus) with branch `skip` removed?
function isConnectedWithout(data, skip) {
  const adj = new Map(data.buses.map((b) => [b.id, []]));
  data.branches.forEach((br, k) => {
    if (k === skip) return;
    adj.get(br.from).push(br.to); adj.get(br.to).push(br.from);
  });
  const seen = new Set([data.buses[0].id]), st = [data.buses[0].id];
  while (st.length) for (const n of adj.get(st.pop())) if (!seen.has(n)) { seen.add(n); st.push(n); }
  return seen.size === data.buses.length;
}

/**
 * @param caseData load-flow case
 * @param opts     { vMin=0.95, vMax=1.05, overloadPct=100, enforceQLimits, tol, maxIter }
 * @returns { base, rows } rows sorted by severity (worst first; islanding outages last)
 * Row: { branch, from, to, converged, islanding, min_v, max_v, v_violations:[bus id],
 *        overloads:[{branch, from, to, loading_pct}], max_loading_pct, severity }
 * Severity = 100·Σ voltage excursion (pu) + Σ overload excess (% over the limit)/10; +1000 if not converged.
 */
export function screenN1(caseData, opts = {}) {
  const vMin = opts.vMin ?? 0.95, vMax = opts.vMax ?? 1.05, ovl = opts.overloadPct ?? 100;
  const solveOpts = { tol: opts.tol, maxIter: opts.maxIter, enforceQLimits: opts.enforceQLimits, vMin, vMax };
  const base = runLoadFlow(caseData, solveOpts);
  if (!base.converged) return { base, rows: [], message: "Base case did not converge: " + base.message };
  const init = { vm: base.buses.map((b) => b.v), va: base.buses.map((b) => (b.angle_deg * Math.PI) / 180) };
  const rows = caseData.branches.map((br, k) => {
    const row = { branch: k, from: br.from, to: br.to, converged: false, islanding: false, min_v: null, max_v: null,
      v_violations: [], overloads: [], max_loading_pct: null, severity: 0 };
    if (!isConnectedWithout(caseData, k)) { row.islanding = true; row.severity = -1; return row; }
    const branches = caseData.branches.filter((_, j) => j !== k);
    const orig = caseData.branches.map((_, j) => j).filter((j) => j !== k);
    const r = runLoadFlow({ ...caseData, branches }, { ...solveOpts, init });
    row.converged = !!r.converged;
    if (!r.converged) { row.severity = 1000; return row; }
    const vs = r.buses.map((b) => b.v);
    row.min_v = Math.min(...vs); row.max_v = Math.max(...vs);
    let sev = 0;
    for (const b of r.buses) {
      if (b.v < vMin) { row.v_violations.push(b.id); sev += 100 * (vMin - b.v); }
      else if (b.v > vMax) { row.v_violations.push(b.id); sev += 100 * (b.v - vMax); }
    }
    for (const b of r.branches) {
      if (b.loading_pct == null) continue;
      row.max_loading_pct = Math.max(row.max_loading_pct ?? 0, b.loading_pct);
      if (b.loading_pct > ovl) {
        row.overloads.push({ branch: orig[b.index], from: b.from, to: b.to, loading_pct: b.loading_pct });
        sev += (b.loading_pct - ovl) / 10;
      }
    }
    row.severity = sev;
    return row;
  });
  rows.sort((a, b) => b.severity - a.severity || a.branch - b.branch);
  return { base, rows };
}

// Case data with one branch removed (for opening an outage as its own scenario).
export function outageCase(caseData, k) {
  const c = JSON.parse(JSON.stringify(caseData));
  c.branches.splice(k, 1);
  return c;
}
