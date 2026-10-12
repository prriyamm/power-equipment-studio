/* ============================================================================
 * Three-phase bolted fault currents, IEC 60909 method (equivalent voltage source
 * c·Un/√3 at the fault, loads/shunts/line charging neglected, sources as
 * impedances). Works on a loadflow case plus a list of source impedances.
 * ========================================================================== */

const SQRT3 = Math.sqrt(3);

// IEC 60909-0 Table 1 voltage factor c_max: 1.05 for LV with +6 % tolerance, 1.10 above 1 kV.
export const cMax = (kv) => (kv <= 1 ? 1.05 : 1.1);
// IEC 60909-0 eq. (55): peak factor κ from R/X at the fault.
export const kappa = (rx) => 1.02 + 0.98 * Math.exp(-3 * rx);

// Complex Gauss-Jordan inverse of an n×n matrix given as separate re/im row arrays.
export function complexInverse(Gr, Gi) {
  const n = Gr.length;
  const ar = Gr.map((r) => Float64Array.from(r)), ai = Gi.map((r) => Float64Array.from(r));
  const br = Array.from({ length: n }, (_, i) => { const r = new Float64Array(n); r[i] = 1; return r; });
  const bi = Array.from({ length: n }, () => new Float64Array(n));
  for (let c = 0; c < n; c++) {
    let p = c, best = Math.hypot(ar[c][c], ai[c][c]);
    for (let r = c + 1; r < n; r++) { const m = Math.hypot(ar[r][c], ai[r][c]); if (m > best) { best = m; p = r; } }
    if (best < 1e-14) throw new Error("Network matrix is singular: a bus has no path to any fault source.");
    for (const M of [ar, ai, br, bi]) { const t = M[p]; M[p] = M[c]; M[c] = t; }
    const pr = ar[c][c], pi = ai[c][c], d = pr * pr + pi * pi, ir = pr / d, ii = -pi / d; // 1/pivot
    for (const [Mr, Mi] of [[ar, ai], [br, bi]]) {
      const rr = Mr[c], ri = Mi[c];
      for (let k = 0; k < n; k++) { const xr = rr[k], xi = ri[k]; rr[k] = xr * ir - xi * ii; ri[k] = xr * ii + xi * ir; }
    }
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const fr = ar[r][c], fi = ai[r][c];
      if (fr === 0 && fi === 0) continue;
      for (const [Mr, Mi] of [[ar, ai], [br, bi]]) {
        const sr = Mr[c], si = Mi[c], tr = Mr[r], ti = Mi[r];
        for (let k = 0; k < n; k++) { tr[k] -= fr * sr[k] - fi * si[k]; ti[k] -= fr * si[k] + fi * sr[k]; }
      }
    }
  }
  return { re: br, im: bi };
}

/**
 * @param lfCase   loadflow case (buses ordered, branches with r/x/tap in pu on base_mva)
 * @param kvs      nominal kV per bus (same order as lfCase.buses)
 * @param sources  [{bus (id), r, x (pu on base), id, kind: utility|generator|motor}]
 * @param opts     { motors: include motor contribution (default true) }
 */
export function shortCircuit(lfCase, kvs, sources, opts = {}) {
  const base = lfCase.base_mva ?? 100;
  const n = lfCase.buses.length;
  const idx = new Map(lfCase.buses.map((b, i) => [b.id, i]));
  const Gr = Array.from({ length: n }, () => new Float64Array(n)), Gi = Array.from({ length: n }, () => new Float64Array(n));
  for (const br of lfCase.branches) {
    const f = idx.get(br.from), t = idx.get(br.to);
    const r = br.r ?? 0, x = br.x ?? 0, d = r * r + x * x, yr = r / d, yi = -x / d;
    const tap = br.tap ?? 1;
    Gr[f][f] += yr / (tap * tap); Gi[f][f] += yi / (tap * tap);
    Gr[t][t] += yr; Gi[t][t] += yi;
    Gr[f][t] -= yr / tap; Gi[f][t] -= yi / tap;
    Gr[t][f] -= yr / tap; Gi[t][f] -= yi / tap;
  }
  const used = sources.filter((s) => opts.motors !== false || s.kind !== "motor");
  for (const s of used) {
    const i = idx.get(s.bus), d = s.r * s.r + s.x * s.x;
    Gr[i][i] += s.r / d; Gi[i][i] += -s.x / d;
  }
  const Z = complexInverse(Gr, Gi);
  const buses = lfCase.buses.map((b, i) => {
    const kv = kvs[i], zr = Z.re[i][i], zi = Z.im[i][i], zm = Math.hypot(zr, zi);
    const ibase = base / (SQRT3 * kv); // kA
    const c = cMax(kv);
    const ik = (c * ibase) / zm;
    const rx = zr / zi;
    return { id: b.id, kv, c, z_pu: [zr, zi], ik_ka: ik, xr: zi / zr, kappa: kappa(rx), ip_ka: kappa(rx) * Math.SQRT2 * ik, sk_mva: SQRT3 * kv * ik };
  });
  // source contribution to a fault at its own bus: I_s = V_fault_source_bus / Z_s with V = c (fault at that bus → 0, so use branch view)
  const srcOut = used.map((s) => {
    const i = idx.get(s.bus), kv = kvs[i];
    const zm = Math.hypot(s.r, s.x);
    return { id: s.id, kind: s.kind, bus: s.bus, ka_at_bus: (cMax(kv) * base) / (SQRT3 * kv) / zm };
  });
  return { method: "IEC 60909-0 equivalent voltage source, c_max", buses, sources: srcOut };
}
