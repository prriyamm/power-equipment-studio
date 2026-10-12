/* ============================================================================
 * GridBench engine — balanced load flow, pure JS, no dependencies.
 * Mirrors loadflow/solver.py (Python CLI) field-for-field so both tools share
 * one JSON case format and one result format.
 *
 * Study registry at the bottom: Phase 2/3 studies plug in there.
 * ========================================================================== */
import { screenN1 } from "./contingency.js";
import { lfShortCircuit } from "./lfshortcircuit.js";
const DEG = Math.PI / 180;

/* ---------- canonical field order (matches the Python case files) ---------- */
const BUS_FIELDS = ["id", "type", "v", "angle", "p_gen", "q_gen", "p_load", "q_load",
  "shunt_g", "shunt_b", "q_min", "q_max"];
const BRANCH_FIELDS = ["from", "to", "r", "x", "b", "tap", "shift", "rate_a"];
const INT_FIELDS = new Set(["id", "from", "to"]);

/* ---------- Python-compatible JSON serialiser ---------- */
// Reproduces Python's float repr (shortest round-trip digits, exponent
// outside 1e-4 <= |x| < 1e16, at least two exponent digits, "100.0").
function pyFloat(x) {
  if (!isFinite(x)) return x > 0 ? "Infinity" : x < 0 ? "-Infinity" : "NaN";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const sign = x < 0 ? "-" : "";
  const [mant, e] = Math.abs(x).toExponential().split("e");
  const exp = parseInt(e, 10);
  const digits = mant.replace(".", "");
  if (exp < -4 || exp >= 16) {
    const m = digits[0] + (digits.length > 1 ? "." + digits.slice(1) : "");
    return sign + m + "e" + (exp < 0 ? "-" : "+") + String(Math.abs(exp)).padStart(2, "0");
  }
  if (exp >= 0) {
    if (digits.length > exp + 1) return sign + digits.slice(0, exp + 1) + "." + digits.slice(exp + 1);
    return sign + digits + "0".repeat(exp + 1 - digits.length) + ".0";
  }
  return sign + "0." + "0".repeat(-exp - 1) + digits;
}
function pyValue(key, v) {
  if (typeof v === "number") return INT_FIELDS.has(key) && Number.isInteger(v) ? String(v) : pyFloat(v);
  if (typeof v === "string" || typeof v === "boolean" || v === null) return JSON.stringify(v).replace(/^true$/, "true");
  if (Array.isArray(v)) return "[" + v.map((x) => pyValue("", x)).join(", ") + "]";
  return "{" + Object.keys(v).map((k) => JSON.stringify(k) + ": " + pyValue(k, v[k])).join(", ") + "}";
}
function pyObject(obj, order) {
  const keys = order.filter((k) => k in obj).concat(Object.keys(obj).filter((k) => !order.includes(k)));
  return "{" + keys.map((k) => JSON.stringify(k) + ": " + pyValue(k, obj[k])).join(", ") + "}";
}
// Same layout as cases/*.json in the Python repo.
function serializeCase(data) {
  const top = Object.keys(data).filter((k) => !["base_mva", "buses", "branches"].includes(k));
  let s = '{"base_mva": ' + pyFloat(Number(data.base_mva ?? 100)) + ",\n";
  for (const k of top) s += " " + JSON.stringify(k) + ": " + pyValue(k, data[k]) + ",\n";
  s += ' "buses": [\n' + (data.buses || []).map((b) => "  " + pyObject(b, BUS_FIELDS)).join(",\n") + "\n ],\n";
  s += ' "branches": [\n' + (data.branches || []).map((b) => "  " + pyObject(b, BRANCH_FIELDS)).join(",\n") + "\n ]}\n";
  return s;
}
// Python json.dump(res, indent=2) layout for results (CLI --out format).
function serializeResult(res) {
  const ind = (n) => " ".repeat(n);
  const val = (k, v, d) => {
    if (Array.isArray(v)) return "[\n" + v.map((x) => ind(d + 2) + val("", x, d + 2)).join(",\n") + "\n" + ind(d) + "]";
    if (v && typeof v === "object")
      return "{\n" + Object.keys(v).map((kk) => ind(d + 2) + JSON.stringify(kk) + ": " + val(kk, v[kk], d + 2)).join(",\n") + "\n" + ind(d) + "}";
    if (typeof v === "number") return (k === "iterations" || INT_FIELDS.has(k)) && Number.isInteger(v) ? String(v) : pyFloat(v);
    return JSON.stringify(v);
  };
  return val("", toCliResult(res), 0);
}

/* ---------- validation ---------- */
function num(v) { return typeof v === "number" && isFinite(v); }
function validateCase(data) {
  const issues = [];
  const add = (level, kind, index, field, msg) => issues.push({ level, kind, index, field, msg });
  if (!data || typeof data !== "object") { add("error", "case", -1, null, "Case is not a JSON object."); return issues; }
  if (!num(Number(data.base_mva ?? 100)) || Number(data.base_mva ?? 100) <= 0) add("error", "case", -1, "base_mva", "base_mva must be a positive number.");
  const buses = Array.isArray(data.buses) ? data.buses : [];
  const branches = Array.isArray(data.branches) ? data.branches : [];
  if (!buses.length) add("error", "case", -1, "buses", "The case has no buses.");
  const ids = new Map();
  let slack = 0;
  buses.forEach((b, i) => {
    if (!Number.isInteger(b.id)) add("error", "bus", i, "id", "Bus id must be an integer.");
    else if (ids.has(b.id)) add("error", "bus", i, "id", `Duplicate bus id ${b.id}.`);
    else ids.set(b.id, i);
    const t = String(b.type ?? "PQ").toUpperCase();
    if (!["SLACK", "PV", "PQ"].includes(t)) add("error", "bus", i, "type", `Unknown bus type "${b.type}".`);
    if (t === "SLACK") slack++;
    for (const f of BUS_FIELDS.slice(2)) if (f in b && !num(b[f])) add("error", "bus", i, f, `${f} must be a number.`);
    if ("v" in b && num(b.v) && (b.v <= 0.5 || b.v > 1.5)) add("warn", "bus", i, "v", `Voltage setpoint ${b.v} pu is outside 0.5–1.5.`);
    if (num(b.q_min) && num(b.q_max) && b.q_min > b.q_max) add("error", "bus", i, "q_min", "q_min is above q_max.");
  });
  if (buses.length && slack === 0) add("error", "case", -1, "type", "No slack bus. Set exactly one bus to type slack.");
  if (slack > 1) add("error", "case", -1, "type", `${slack} slack buses. This solver supports exactly one.`);
  branches.forEach((br, i) => {
    if (!ids.has(br.from)) add("error", "branch", i, "from", `From-bus ${br.from} does not exist.`);
    if (!ids.has(br.to)) add("error", "branch", i, "to", `To-bus ${br.to} does not exist.`);
    if (br.from === br.to) add("error", "branch", i, "to", "Branch connects a bus to itself.");
    for (const f of BRANCH_FIELDS.slice(2)) if (f in br && !num(br[f])) add("error", "branch", i, f, `${f} must be a number.`);
    if (num(br.r ?? 0) && num(br.x ?? 0) && (br.r ?? 0) === 0 && (br.x ?? 0) === 0) add("error", "branch", i, "x", "r and x are both zero.");
    if ("tap" in br && num(br.tap) && br.tap <= 0) add("error", "branch", i, "tap", "Tap must be positive.");
    if (num(br.r) && br.r < 0) add("warn", "branch", i, "r", "Negative resistance.");
  });
  // islands
  if (buses.length && !issues.some((x) => x.level === "error")) {
    const adj = new Map(buses.map((b) => [b.id, []]));
    branches.forEach((br) => { adj.get(br.from).push(br.to); adj.get(br.to).push(br.from); });
    const seen = new Set([buses[0].id]); const st = [buses[0].id];
    while (st.length) for (const n of adj.get(st.pop())) if (!seen.has(n)) { seen.add(n); st.push(n); }
    if (seen.size < buses.length) {
      const iso = buses.filter((b) => !seen.has(b.id)).map((b) => b.id);
      add("error", "case", -1, null, `Network is split into islands. Not connected to bus ${buses[0].id}: ${iso.join(", ")}.`);
    }
  }
  return issues;
}

/* ---------- network model ---------- */
function loadNetwork(data) {
  const base = Number(data.base_mva ?? 100);
  const idToIdx = new Map();
  const buses = data.buses.map((b, i) => {
    const t = String(b.type ?? "PQ").toUpperCase();
    idToIdx.set(b.id, i);
    return {
      idx: i, id: b.id, kind: t === "SLACK" ? "slack" : t,
      vSpec: b.v ?? 1.0, aSpec: (b.angle ?? 0) * DEG,
      pSpec: ((b.p_gen ?? 0) - (b.p_load ?? 0)) / base,
      qSpec: ((b.q_gen ?? 0) - (b.q_load ?? 0)) / base,
      gs: b.shunt_g ?? 0, bs: b.shunt_b ?? 0,   // bus shunt — do NOT drop (IEEE-14 bus 9)
      pLoad: b.p_load ?? 0, qLoad: b.q_load ?? 0,
      qMin: b.q_min, qMax: b.q_max,
    };
  });
  const branches = (data.branches || []).map((br, k) => {
    const r = br.r ?? 0, x = br.x ?? 0, d = r * r + x * x;
    const tap = br.tap ?? 1.0, sh = (br.shift ?? 0) * DEG;
    return {
      k, f: idToIdx.get(br.from), t: idToIdx.get(br.to), from: br.from, to: br.to,
      yr: r / d, yi: -x / d, b: br.b ?? 0,
      tr: tap * Math.cos(sh), ti: tap * Math.sin(sh), rate: br.rate_a,
    };
  });
  return { base, buses, branches, idToIdx };
}

/* ---------- tiny complex helpers on [re, im] ---------- */
const cmul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cdiv = (a, b) => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; };
const conj = (a) => [a[0], -a[1]];

// Two-port admittances of one branch (tap at from-side).
function branchPrims(br) {
  const y = [br.yr, br.yi], tau = [br.tr, br.ti];
  const t2 = br.tr * br.tr + br.ti * br.ti;
  const yff = [y[0] / t2, y[1] / t2 + br.b / 2];
  const yft = cdiv([-y[0], -y[1]], conj(tau));
  const ytf = cdiv([-y[0], -y[1]], tau);
  const ytt = [y[0], y[1] + br.b / 2];
  return { yff, yft, ytf, ytt };
}

function buildYbus(net) {
  const n = net.buses.length;
  const G = Array.from({ length: n }, () => new Float64Array(n));
  const B = Array.from({ length: n }, () => new Float64Array(n));
  net.buses.forEach((b, i) => { G[i][i] += b.gs; B[i][i] += b.bs; });
  for (const br of net.branches) {
    const p = branchPrims(br);
    G[br.f][br.f] += p.yff[0]; B[br.f][br.f] += p.yff[1];
    G[br.f][br.t] += p.yft[0]; B[br.f][br.t] += p.yft[1];
    G[br.t][br.f] += p.ytf[0]; B[br.t][br.f] += p.ytf[1];
    G[br.t][br.t] += p.ytt[0]; B[br.t][br.t] += p.ytt[1];
  }
  return { G, B, n };
}

// Dense Gaussian elimination with partial pivoting. A (array of rows) and b are overwritten.
function solveLinear(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c, best = Math.abs(A[c][c]);
    for (let r = c + 1; r < n; r++) { const v = Math.abs(A[r][c]); if (v > best) { best = v; p = r; } }
    if (best < 1e-14) throw new Error("Jacobian is singular. Check for isolated buses or zero-impedance loops.");
    if (p !== c) { const t = A[p]; A[p] = A[c]; A[c] = t; const tb = b[p]; b[p] = b[c]; b[c] = tb; }
    const piv = A[c][c], rc = A[c];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / piv; if (f === 0) continue;
      const rr = A[r];
      for (let k = c; k < n; k++) rr[k] -= f * rc[k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]; const rr = A[r];
    for (let k = r + 1; k < n; k++) s -= rr[k] * x[k];
    x[r] = s / rr[r];
  }
  return x;
}

function injections(Y, vm, va) {
  const n = vm.length, P = new Float64Array(n), Q = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let p = 0, q = 0;
    for (let k = 0; k < n; k++) {
      const g = Y.G[i][k], bb = Y.B[i][k];
      if (g === 0 && bb === 0) continue;
      const d = va[i] - va[k], c = Math.cos(d), s = Math.sin(d);
      p += vm[k] * (g * c + bb * s);
      q += vm[k] * (g * s - bb * c);
    }
    P[i] = vm[i] * p; Q[i] = vm[i] * q;
  }
  return { P, Q };
}

/* ---------- polar Newton-Raphson ---------- */
function solveNR(net, Y, opts = {}) {
  const tol = opts.tol ?? 1e-8, maxIter = opts.maxIter ?? 50;
  const n = net.buses.length;
  // Start point matches the Python solver: case magnitudes (PQ default 1.0) and case angles.
  const vm = opts.init ? Float64Array.from(opts.init.vm) : Float64Array.from(net.buses, (b) => b.vSpec);
  const va = opts.init ? Float64Array.from(opts.init.va) : Float64Array.from(net.buses, (b) => b.aSpec);
  if (opts.init) for (const b of net.buses) if (b.kind !== "PQ") vm[b.idx] = b.vSpec;
  const ang = net.buses.filter((b) => b.kind !== "slack").map((b) => b.idx);
  const pq = net.buses.filter((b) => b.kind === "PQ").map((b) => b.idx);
  const na = ang.length, nq = pq.length, N = na + nq;
  const history = [];
  const { G, B } = Y;
  let it = 0, maxMis = Infinity;
  for (it = 0; it <= maxIter; it++) {
    const { P, Q } = injections(Y, vm, va);
    const mis = new Float64Array(N);
    maxMis = 0;
    for (let a = 0; a < na; a++) { const i = ang[a]; mis[a] = net.buses[i].pSpec - P[i]; maxMis = Math.max(maxMis, Math.abs(mis[a])); }
    for (let a = 0; a < nq; a++) { const i = pq[a]; mis[na + a] = net.buses[i].qSpec - Q[i]; maxMis = Math.max(maxMis, Math.abs(mis[na + a])); }
    history.push(maxMis);
    if (maxMis < tol) return { vm, va, iterations: it, maxMismatch: maxMis, converged: true, history };
    if (it === maxIter || !isFinite(maxMis)) break;
    const J = Array.from({ length: N }, () => new Float64Array(N));
    const colA = new Map(ang.map((i, a) => [i, a]));
    const colQ = new Map(pq.map((i, a) => [i, na + a]));
    // Row blocks: dP rows for ang buses, dQ rows for PQ buses. Columns: dθ (ang), d|V| (pq).
    const fill = (row, i, isQ) => {
      for (let k = 0; k < n; k++) {
        const g = G[i][k], bb = B[i][k];
        if (k !== i && g === 0 && bb === 0) continue;
        const ca = colA.get(k), cv = colQ.get(k);
        if (k === i) {
          if (!isQ) {
            if (ca !== undefined) row[ca] = -Q[i] - B[i][i] * vm[i] * vm[i];
            if (cv !== undefined) row[cv] = P[i] / vm[i] + G[i][i] * vm[i];
          } else {
            if (ca !== undefined) row[ca] = P[i] - G[i][i] * vm[i] * vm[i];
            if (cv !== undefined) row[cv] = Q[i] / vm[i] - B[i][i] * vm[i];
          }
        } else {
          const d = va[i] - va[k], c = Math.cos(d), s = Math.sin(d);
          if (!isQ) {
            if (ca !== undefined) row[ca] = vm[i] * vm[k] * (g * s - bb * c);
            if (cv !== undefined) row[cv] = vm[i] * (g * c + bb * s);
          } else {
            if (ca !== undefined) row[ca] = -vm[i] * vm[k] * (g * c + bb * s);
            if (cv !== undefined) row[cv] = vm[i] * (g * s - bb * c);
          }
        }
      }
    };
    for (let a = 0; a < na; a++) fill(J[a], ang[a], false);
    for (let a = 0; a < nq; a++) fill(J[na + a], pq[a], true);
    const dx = solveLinear(J, mis);
    for (let a = 0; a < na; a++) va[ang[a]] += dx[a];
    for (let a = 0; a < nq; a++) vm[pq[a]] += dx[na + a];
  }
  return { vm, va, iterations: Math.min(it, maxIter), maxMismatch: maxMis, converged: false, history };
}

/* ---------- full load-flow run ---------- */
function runLoadFlow(data, opts = {}) {
  const issues = validateCase(data);
  const errors = issues.filter((x) => x.level === "error");
  if (errors.length) return { ok: false, converged: false, issues, message: errors[0].msg };
  const t0 = (typeof performance !== "undefined" ? performance : Date).now();
  const net = loadNetwork(data);
  const Y = buildYbus(net);
  let sol;
  let switching = null, outerIterations = 0;
  try {
    sol = solveNR(net, Y, opts);
    if (opts.enforceQLimits && sol.converged) {
      // MATPOWER-style outer loop: PV buses beyond q_min/q_max become PQ at the limit; a switched bus
      // returns to PV when its voltage crosses back over the setpoint (limit no longer binding).
      switching = [];
      const TOL = 1e-6, maxOuter = opts.maxOuter ?? 10;
      for (outerIterations = 1; outerIterations <= maxOuter && sol.converged; outerIterations++) {
        const { Q } = injections(Y, sol.vm, sol.va);
        let changed = false;
        const justSwitched = new Set();
        for (const b of net.buses) {
          if (b.kind !== "PV") continue;
          const qg = Q[b.idx] * net.base + b.qLoad;
          const hi = num(b.qMax) && qg > b.qMax + TOL, lo = !hi && num(b.qMin) && qg < b.qMin - TOL;
          if (!hi && !lo) continue;
          const lim = hi ? b.qMax : b.qMin;
          b.kind = "PQ"; b.switched = hi ? "q_max" : "q_min"; b.qSpec = (lim - b.qLoad) / net.base;
          switching.push({ bus: b.id, from: "PV", to: "PQ", limit: b.switched, q_mvar: lim, v: sol.vm[b.idx] });
          justSwitched.add(b.idx); changed = true;
        }
        for (const b of net.buses) {
          if (!b.switched || justSwitched.has(b.idx)) continue;
          const v = sol.vm[b.idx];
          if ((b.switched === "q_max" && v > b.vSpec + 1e-9) || (b.switched === "q_min" && v < b.vSpec - 1e-9)) {
            switching.push({ bus: b.id, from: "PQ", to: "PV", limit: b.switched, q_mvar: b.switched === "q_max" ? b.qMax : b.qMin, v });
            b.kind = "PV"; b.switched = null; changed = true;
          }
        }
        if (!changed) break;
        sol = solveNR(net, Y, { ...opts, init: { vm: sol.vm, va: sol.va } });
      }
      outerIterations = Math.min(outerIterations, maxOuter);
    }
  } catch (e) { return { ok: false, converged: false, issues, message: e.message }; }
  const { vm, va } = sol;
  const { P, Q } = injections(Y, vm, va);
  const base = net.base;
  const V = Array.from(vm, (m, i) => [m * Math.cos(va[i]), m * Math.sin(va[i])]);
  const buses = net.buses.map((b, i) => {
    const p = P[i] * base, q = Q[i] * base;
    const pg = p + b.pLoad, qg = q + b.qLoad;
    const vflag = vm[i] < (opts.vMin ?? 0.95) ? "low" : vm[i] > (opts.vMax ?? 1.05) ? "high" : "ok";
    const qflag = b.kind !== "PQ" && ((num(b.qMax) && qg > b.qMax + 1e-6) ? "qmax" : (num(b.qMin) && qg < b.qMin - 1e-6) ? "qmin" : null);
    return { id: b.id, type: b.kind, v: vm[i], angle_deg: va[i] / DEG, p_mw: p, q_mvar: q,
      p_gen_mw: pg, q_gen_mvar: qg, p_load_mw: b.pLoad, q_load_mvar: b.qLoad, vflag, qflag,
      ...(switching ? { switched: !!b.switched, switched_limit: b.switched || null } : {}) };
  });
  let tl = [0, 0];
  const branches = net.branches.map((br) => {
    const pr = branchPrims(br);
    const vf = V[br.f], vt = V[br.t];
    const If = [cmul(pr.yff, vf)[0] + cmul(pr.yft, vt)[0], cmul(pr.yff, vf)[1] + cmul(pr.yft, vt)[1]];
    const It = [cmul(pr.ytf, vf)[0] + cmul(pr.ytt, vt)[0], cmul(pr.ytf, vf)[1] + cmul(pr.ytt, vt)[1]];
    const Sf = cmul(vf, conj(If)), St = cmul(vt, conj(It));
    const loss = [Sf[0] + St[0], Sf[1] + St[1]];
    tl = [tl[0] + loss[0], tl[1] + loss[1]];
    const sfm = Math.hypot(Sf[0], Sf[1]) * base, stm = Math.hypot(St[0], St[1]) * base;
    const loading = num(br.rate) && br.rate > 0 ? (Math.max(sfm, stm) / br.rate) * 100 : null;
    return { from: br.from, to: br.to, p_from_mw: Sf[0] * base, q_from_mvar: Sf[1] * base,
      p_to_mw: St[0] * base, q_to_mvar: St[1] * base, p_loss_mw: loss[0] * base, q_loss_mvar: loss[1] * base,
      i_from_pu: Math.hypot(If[0], If[1]), s_from_mva: sfm, s_to_mva: stm, loading_pct: loading, index: br.k };
  });
  const sumP = P.reduce((a, x) => a + x, 0);
  return {
    ok: sol.converged, converged: sol.converged, issues,
    message: sol.converged ? `Converged in ${sol.iterations} iterations` : `No convergence in ${opts.maxIter ?? 50} iterations (max mismatch ${sol.maxMismatch.toExponential(2)} pu)`,
    base_mva: base, iterations: sol.iterations, max_mismatch_pu: sol.maxMismatch, history: sol.history,
    total_p_loss_mw: tl[0] * base, total_q_loss_mvar: tl[1] * base,
    total_gen_mw: buses.reduce((a, b) => a + b.p_gen_mw, 0), total_load_mw: buses.reduce((a, b) => a + b.p_load_mw, 0),
    total_gen_mvar: buses.reduce((a, b) => a + b.q_gen_mvar, 0), total_load_mvar: buses.reduce((a, b) => a + b.q_load_mvar, 0),
    balance_residual_pu: Math.abs(sumP - tl[0]),
    ...(switching ? { q_limits_enforced: true, switching, outer_iterations: outerIterations } : {}),
    buses, branches, solve_ms: (typeof performance !== "undefined" ? performance : Date).now() - t0,
  };
}

// Strip to exactly what `loadflow case.json --out` writes.
function toCliResult(r) {
  return {
    base_mva: r.base_mva, iterations: r.iterations, max_mismatch_pu: r.max_mismatch_pu,
    total_p_loss_mw: r.total_p_loss_mw, total_q_loss_mvar: r.total_q_loss_mvar,
    buses: r.buses.map((b) => ({ id: b.id, v: b.v, angle_deg: b.angle_deg, p_mw: b.p_mw, q_mvar: b.q_mvar })),
    branches: r.branches.map((b) => ({ from: b.from, to: b.to, p_from_mw: b.p_from_mw, q_from_mvar: b.q_from_mvar,
      p_to_mw: b.p_to_mw, q_to_mvar: b.q_to_mvar, p_loss_mw: b.p_loss_mw, q_loss_mvar: b.q_loss_mvar })),
  };
}

/* ---------- built-in cases + self-test reference ---------- */
const CASES = {
  demo3: { name: "3-bus demo", note: "Slack, one PQ load, one PV generator. Loads instantly.",
    data: { base_mva: 100.0,
      buses: [{ id: 1, type: "slack", v: 1.0, angle: 0.0 }, { id: 2, type: "PQ", p_load: 100.0, q_load: 50.0 }, { id: 3, type: "PV", v: 1.02, p_gen: 80.0 }],
      branches: [{ from: 1, to: 2, r: 0.02, x: 0.06, b: 0.03 }, { from: 1, to: 3, r: 0.01, x: 0.04, b: 0.02 }, { from: 2, to: 3, r: 0.0125, x: 0.03, b: 0.025 }] },
    layout: { 1: [260, 170], 2: [500, 470], 3: [740, 170] } },
  ieee14: { name: "IEEE 14-bus", note: "Standard test system. 5 generators, 3 transformers, bus 9 shunt capacitor.",
    data: { base_mva: 100.0,
      buses: [
        { id: 1, type: "slack", v: 1.06, angle: 0.0 }, { id: 2, type: "PV", v: 1.045, p_gen: 40.0, p_load: 21.7, q_load: 12.7 },
        { id: 3, type: "PV", v: 1.01, p_load: 94.2, q_load: 19.0 }, { id: 4, type: "PQ", p_load: 47.8, q_load: -3.9 },
        { id: 5, type: "PQ", p_load: 7.6, q_load: 1.6 }, { id: 6, type: "PV", v: 1.07, p_load: 11.2, q_load: 7.5 },
        { id: 7, type: "PQ" }, { id: 8, type: "PV", v: 1.09 },
        { id: 9, type: "PQ", p_load: 29.5, q_load: 16.6, shunt_b: 0.19 }, { id: 10, type: "PQ", p_load: 9.0, q_load: 5.8 },
        { id: 11, type: "PQ", p_load: 3.5, q_load: 1.8 }, { id: 12, type: "PQ", p_load: 6.1, q_load: 1.6 },
        { id: 13, type: "PQ", p_load: 13.5, q_load: 5.8 }, { id: 14, type: "PQ", p_load: 14.9, q_load: 5.0 }],
      branches: [
        { from: 1, to: 2, r: 0.01938, x: 0.05917, b: 0.0528 }, { from: 1, to: 5, r: 0.05403, x: 0.22304, b: 0.0492 },
        { from: 2, to: 3, r: 0.04699, x: 0.19797, b: 0.0438 }, { from: 2, to: 4, r: 0.05811, x: 0.17632, b: 0.034 },
        { from: 2, to: 5, r: 0.05695, x: 0.17388, b: 0.0346 }, { from: 3, to: 4, r: 0.06701, x: 0.17103, b: 0.0128 },
        { from: 4, to: 5, r: 0.01335, x: 0.04211, b: 0.0 }, { from: 4, to: 7, r: 0.0, x: 0.20912, tap: 0.978 },
        { from: 4, to: 9, r: 0.0, x: 0.55618, tap: 0.969 }, { from: 5, to: 6, r: 0.0, x: 0.25202, tap: 0.932 },
        { from: 6, to: 11, r: 0.09498, x: 0.1989, b: 0.0 }, { from: 6, to: 12, r: 0.12291, x: 0.25581, b: 0.0 },
        { from: 6, to: 13, r: 0.06615, x: 0.13027, b: 0.0 }, { from: 7, to: 8, r: 0.0, x: 0.17615, b: 0.0 },
        { from: 7, to: 9, r: 0.0, x: 0.11001, b: 0.0 }, { from: 9, to: 10, r: 0.03181, x: 0.0845, b: 0.0 },
        { from: 9, to: 14, r: 0.12711, x: 0.27038, b: 0.0 }, { from: 10, to: 11, r: 0.08205, x: 0.19207, b: 0.0 },
        { from: 12, to: 13, r: 0.22092, x: 0.19988, b: 0.0 }, { from: 13, to: 14, r: 0.17093, x: 0.34802, b: 0.0 }] },
    layout: { 1: [110, 470], 2: [270, 600], 3: [620, 610], 4: [600, 440], 5: [330, 400], 6: [330, 250], 7: [760, 360],
      8: [920, 360], 9: [740, 230], 10: [600, 150], 11: [450, 170], 12: [150, 120], 13: [340, 70], 14: [800, 80] } },
};
// Same network with tight generator Q limits (MATPOWER case14 limits, bus 2 q_max 30, bus 3 q_max 15)
// so that Q-limit enforcement has something to do. Not a published reference case.
CASES.ieee14q = {
  name: "IEEE 14-bus, tight Q limits", note: "IEEE 14-bus with generator Q limits that bind at buses 2 and 3. Try the Studies tab.",
  data: JSON.parse(JSON.stringify(CASES.ieee14.data)), layout: CASES.ieee14.layout,
};
for (const [id, lo, hi] of [[2, -40, 30], [3, 0, 15], [6, -6, 24], [8, -6, 24]]) {
  const b = CASES.ieee14q.data.buses.find((x) => x.id === id); b.q_min = lo; b.q_max = hi;
}
const IEEE14_REF = {
  v: [1.06, 1.045, 1.01, 1.017671, 1.019514, 1.07, 1.06152, 1.09, 1.055932, 1.050985, 1.056907, 1.055189, 1.050382, 1.03553],
  angle: [0, -4.982589, -12.7251, -10.312901, -8.773854, -14.220946, -13.359627, -13.359627, -14.938521, -15.097288, -14.790622, -15.075584, -15.156276, -16.033644],
  loss: 13.393, tol: 1e-4,
};

function verifySolver() {
  const r = runLoadFlow(CASES.ieee14.data);
  const rows = r.buses.map((b, i) => {
    const dv = b.v - IEEE14_REF.v[i], da = b.angle_deg - IEEE14_REF.angle[i];
    return { id: b.id, vRef: IEEE14_REF.v[i], v: b.v, dv, aRef: IEEE14_REF.angle[i], a: b.angle_deg, da,
      pass: Math.abs(dv) <= IEEE14_REF.tol && Math.abs(da) <= IEEE14_REF.tol };
  });
  const dLoss = r.total_p_loss_mw - IEEE14_REF.loss;
  // Regression guard for the bug that bit the Python version: drop the bus 9 shunt and show the damage.
  const noShunt = JSON.parse(JSON.stringify(CASES.ieee14.data));
  delete noShunt.buses[8].shunt_b;
  const r2 = runLoadFlow(noShunt);
  const shuntShift = Math.max(...r2.buses.map((b, i) => Math.abs(b.v - r.buses[i].v)));
  const maxDv = Math.max(...rows.map((x) => Math.abs(x.dv))), maxDa = Math.max(...rows.map((x) => Math.abs(x.da)));
  return {
    pass: r.converged && rows.every((x) => x.pass) && Math.abs(dLoss) < 5e-4,
    rows, iterations: r.iterations, mismatch: r.max_mismatch_pu, loss: r.total_p_loss_mw, lossRef: IEEE14_REF.loss, dLoss,
    maxDv, maxDa, balance: r.balance_residual_pu, shuntShift, ms: r.solve_ms, tol: IEEE14_REF.tol,
  };
}

/* ---------- auto-layout (deterministic force-directed) ---------- */
function autoLayout(data, W = 1000, H = 680) {
  const ids = data.buses.map((b) => b.id), n = ids.length;
  const pos = ids.map((_, i) => [W / 2 + 0.35 * W * Math.cos((2 * Math.PI * i) / n), H / 2 + 0.35 * H * Math.sin((2 * Math.PI * i) / n)]);
  const idx = new Map(ids.map((id, i) => [id, i]));
  const edges = (data.branches || []).map((b) => [idx.get(b.from), idx.get(b.to)]).filter((e) => e[0] !== undefined && e[1] !== undefined);
  const k = Math.sqrt((W * H) / Math.max(n, 1)) * 0.7;
  let temp = W / 8;
  for (let it = 0; it < 400; it++) {
    const d = pos.map(() => [0, 0]);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      let dx = pos[i][0] - pos[j][0], dy = (pos[i][1] - pos[j][1]) * 1.6; // favour vertical separation: bus bars are wide
      const dist = Math.max(Math.hypot(dx, dy), 1), f = (k * k) / dist;
      dx /= dist; dy /= dist;
      d[i][0] += dx * f; d[i][1] += dy * f; d[j][0] -= dx * f; d[j][1] -= dy * f;
    }
    for (const [a, b] of edges) {
      let dx = pos[a][0] - pos[b][0], dy = pos[a][1] - pos[b][1];
      const dist = Math.max(Math.hypot(dx, dy), 1), f = (dist * dist) / k;
      dx /= dist; dy /= dist;
      d[a][0] -= dx * f; d[a][1] -= dy * f; d[b][0] += dx * f; d[b][1] += dy * f;
    }
    for (let i = 0; i < n; i++) {
      const m = Math.max(Math.hypot(d[i][0], d[i][1]), 1e-9), s = Math.min(m, temp) / m;
      pos[i][0] += d[i][0] * s; pos[i][1] += d[i][1] * s;
    }
    temp *= 0.985;
  }
  // fit into frame
  const xs = pos.map((p) => p[0]), ys = pos.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const sx = (W - 200) / Math.max(x1 - x0, 1), sy = (H - 160) / Math.max(y1 - y0, 1);
  const out = {};
  ids.forEach((id, i) => { out[id] = [Math.round(100 + (pos[i][0] - x0) * sx), Math.round(80 + (pos[i][1] - y0) * sy)]; });
  return out;
}

/* ---------- study registry: phases 2–3 slot in here ---------- */
const STUDIES = [
  { key: "loadflow", phase: 1, name: "Load flow", detail: "Polar Newton-Raphson, 1e-8 pu", run: runLoadFlow },
  { key: "qlimits", phase: 2, name: "Q-limit enforcement", detail: "PV→PQ switching when q_min/q_max is hit", run: (data, opts = {}) => runLoadFlow(data, { ...opts, enforceQLimits: true }) },
  { key: "contingency", phase: 2, name: "N−1 screening", detail: "Outage each branch, rank by overloads and voltage violations", run: (data, opts) => screenN1(data, opts) },
  { key: "shortcircuit", phase: 2, name: "Short circuit", detail: "IEC 60909-style Thevenin fault currents per bus", run: (data, opts) => lfShortCircuit(data, opts) },
  { key: "timeseries", phase: 3, name: "Time series", detail: "Load-duration and profile runs", run: null },
  { key: "report", phase: 3, name: "Report", detail: "PDF study report export", run: null },
];

export { runLoadFlow, validateCase, loadNetwork, buildYbus, solveNR, solveLinear, serializeCase, serializeResult, toCliResult, pyFloat, verifySolver, autoLayout, CASES, IEEE14_REF, STUDIES, BUS_FIELDS, BRANCH_FIELDS };
