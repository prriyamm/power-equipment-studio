/* ============================================================================
 * System protection code checks (JS-only system module).
 *
 *   Transformer overcurrent protection limits
 *     NEC 450.3(A) Table 450.3(A)   primary over 1000 V (any location / supervised)
 *     NEC 450.3(B) Table 450.3(B)   primary 1000 V and less
 *     CEC Rules 26-250 / 26-252 / 26-254 (over 750 V / 750 V or less)
 *   NEC 240.87     arc energy reduction for breakers with a highest continuous
 *                  trip setting at or above 1200 A
 *   NEC 110.16(B)  service equipment arc-flash label at 1000 A and above
 *
 * Device ratings come from the existing protective-device model (tcc.js
 * protectionPath with the gear lineup trips, plus any manual settings from the
 * Coordination view). Every limit lives in data/protection_code_checks.json
 * with its clause, source and status; all values are UNVERIFIED.
 * ========================================================================== */
import DATA from "./data/protection_code_checks.json" with { type: "json" };
import { EQUIPMENT, NODE_KINDS } from "./system.js";
import { buildLineup, nextStandard } from "./gear.js";
import { protectionPath, defaultSettings, deviceTimes } from "./tcc.js";
import { arcFlashStudy } from "./arcflash.js";

export const PROT_DATA = DATA;
export const PROT_DATA_STATUS = DATA._meta.status;
export const AER_METHODS = DATA.nec_240_87.methods;
export const CODES = ["NEC", "CEC"];
const SQ3 = Math.sqrt(3);

/** Transformer rated current, A: kVA / (sqrt(3) x kV). */
export const ratedCurrent = (kva, kv) => kva / (SQ3 * kv);

/* ------------------------------------------------------------- limits */
// Allowed device rating/setting (A) for `pct` of `fla`. With nextHigher and a standard-rating ladder (devices
// at 1000 V or less: NEC 240.6(A)) the next higher standard rating is allowed; continuously adjustable relay
// pickups and MV fuses have no ladder here, so the exact percentage governs (conservative).
export function allowedRating(pct, fla, nextHigher = false, ladder = false) {
  const raw = (pct / 100) * fla;
  if (nextHigher && ladder) {
    const n = nextStandard(raw);
    if (n != null) return { raw_a: raw, allowed_a: n, next_higher: n > raw + 1e-9 };
  }
  return { raw_a: raw, allowed_a: raw, next_higher: false };
}

function item(side, dev, pct, fla, { nextHigher = false, ladder = false, required = true } = {}) {
  if (!dev) {
    return { side, device: null, setting_a: null, pct, fla_a: fla, limit_a: (pct / 100) * fla, allowed_a: (pct / 100) * fla, pass: !required,
      note: required ? `No ${side} overcurrent device found; this scheme requires one.` : `No ${side} device (not required by this scheme).` };
  }
  const lim = allowedRating(pct, fla, nextHigher, ladder);
  const pass = dev.setting_a <= lim.allowed_a + 1e-6;
  const note = lim.next_higher ? `${pct} % = ${lim.raw_a.toFixed(1)} A; next higher standard rating ${lim.allowed_a} A allowed` : `${pct} % of ${fla.toFixed(1)} A`;
  return { side, device: dev.label ?? null, type: dev.type, setting_a: dev.setting_a, pct, fla_a: fla, limit_a: lim.raw_a, allowed_a: lim.allowed_a, next_higher: lim.next_higher, pass, note };
}
const optionPass = (o) => o.items.every((i) => i.pass);
const devType = (d) => (d?.type === "fuse" ? "fuse" : "breaker");
function pickOption(options) {
  const ok = options.find(optionPass);
  return { chosen: ok || options[0], pass: !!ok };
}

/**
 * NEC 450.3 check for one transformer.
 * x = { kva, hv_kv, lv_kv, z_pct, supervised, primary, secondary }; devices are
 * { type: "breaker" | "fuse", setting_a, label } or null. "breaker" covers a relay-operated breaker (setting = pickup).
 */
export function nec4503(x) {
  const fla_p = ratedCurrent(x.kva, x.hv_kv), fla_s = ratedCurrent(x.kva, x.lv_kv);
  const P = x.primary, S = x.secondary;
  const notes = [];
  const base = { code: "NEC", fla_p, fla_s, supervised: !!x.supervised, data_status: DATA.nec_450_3_a._meta.status };
  if (x.hv_kv * 1000 > DATA.nec_450_3_a.voltage_threshold_v) {
    const T = DATA.nec_450_3_a, secCol = x.lv_kv * 1000 > T.voltage_threshold_v ? "secondary_over_1000v" : "secondary_1000v_or_less";
    const lvLadder = x.lv_kv <= 1;
    const options = [];
    const rowOf = (rows) => rows.find((r) => x.z_pct <= r.z_max_pct + 1e-9);
    const any = rowOf(T.any_location);
    if (any) options.push({ scheme: `Any location, Z ≤ ${any.z_max_pct} %: primary and secondary`, items: [
      item("primary", P, any.primary[devType(P)], fla_p, { nextHigher: true, ladder: false }),
      item("secondary", S, any[secCol][devType(S)], fla_s, { nextHigher: true, ladder: lvLadder }),
    ] });
    if (x.supervised) {
      const sup = rowOf(T.supervised);
      if (sup) options.push({ scheme: `Supervised location, Z ≤ ${sup.z_max_pct} %: primary and secondary`, items: [
        item("primary", P, sup.primary[devType(P)], fla_p, { nextHigher: true }),
        item("secondary", S, sup[secCol][devType(S)], fla_s, { nextHigher: true, ladder: lvLadder }),
      ] });
      options.push({ scheme: "Supervised location, any impedance: primary only", items: [item("primary", P, T.supervised_primary_only[devType(P)], fla_p, { nextHigher: true })] });
    }
    if (!any) notes.push(`Impedance ${x.z_pct} % is above the 10 % rows of Table 450.3(A); only the supervised primary-only row can apply. Engineering review needed otherwise.`);
    if (!options.length) return { ...base, clause: "NEC 450.3(A)", table: "Table 450.3(A)", status: "warn", pass: null, options, chosen: null, notes };
    const { chosen, pass } = pickOption(options);
    notes.push("Table note: up to six secondary devices grouped in one location may share the allowance (sum of ratings); not modelled.");
    if (!x.supervised) notes.push("Location taken as unsupervised (conservative). Mark the transformer supervised only where qualified persons alone monitor and service it.");
    return { ...base, clause: "NEC 450.3(A)", table: "Table 450.3(A)", status: pass ? "pass" : "fail", pass, options, chosen, notes };
  }
  const T = DATA.nec_450_3_b, ladder = true;
  const rowFor = (rows, fla) => rows.find((r) => fla >= r.min_a - 1e-9);
  const po = rowFor(T.primary_only, fla_p), ss = rowFor(T.primary_and_secondary.secondary, fla_s);
  const options = [
    { scheme: "Primary only", items: [item("primary", P, po.pct, fla_p, { nextHigher: po.next_higher, ladder })] },
    { scheme: "Primary and secondary", items: [
      item("primary", P, T.primary_and_secondary.primary_pct, fla_p),
      item("secondary", S, ss.pct, fla_s, { nextHigher: ss.next_higher, ladder }),
    ] },
  ];
  const { chosen, pass } = pickOption(options);
  notes.push("Primary-only protection does not protect the secondary conductors (NEC 240.21(C)). Table note 3 (coordinated thermal overload protection) is not modelled.");
  return { ...base, data_status: T._meta.status, clause: "NEC 450.3(B)", table: "Table 450.3(B)", status: pass ? "pass" : "fail", pass, options, chosen, notes };
}

/** CEC Rules 26-250 / 26-252 / 26-254 for one transformer (same input as nec4503). */
export function cec26(x) {
  const fla_p = ratedCurrent(x.kva, x.hv_kv), fla_s = ratedCurrent(x.kva, x.lv_kv);
  const P = x.primary, S = x.secondary, notes = [];
  const base = { code: "CEC", fla_p, fla_s, supervised: !!x.supervised };
  if (x.hv_kv * 1000 > DATA.cec_26_250.voltage_threshold_v) {
    const T = DATA.cec_26_250;
    const options = [{ scheme: "Primary device (Rule 26-250)", items: [item("primary", P, T.primary[devType(P)], fla_p)] }];
    const { chosen, pass } = pickOption(options);
    notes.push("Rule 26-252 secondary-side requirements were not found in public sources: the secondary device is not evaluated.");
    return { ...base, data_status: T._meta.status, clause: "CEC 26-250", table: "Rule 26-250", status: pass ? "pass" : "fail", pass, options, chosen, notes };
  }
  const T = DATA.cec_26_254, ladder = x.hv_kv <= 1;
  const options = [
    { scheme: "Primary only (Rule 26-254)", items: [item("primary", P, T.primary_only_pct, fla_p, { nextHigher: T.primary_only_next_higher, ladder })] },
    { scheme: "Primary and secondary (Rule 26-254(3))", items: [
      item("primary", P, T.with_secondary.primary_pct, fla_p),
      item("secondary", S, T.with_secondary.secondary_pct, fla_s),
    ] },
  ];
  const { chosen, pass } = pickOption(options);
  notes.push("Above 125 % on the primary, Rule 26-256(4) requires the connected conductors to be protected per Rules 14-100 and 14-104 (not modelled). Next-higher standard ratings use the NEC 240.6(A) list.");
  return { ...base, data_status: T._meta.status, clause: "CEC 26-254", table: "Rule 26-254", status: pass ? "pass" : "fail", pass, options, chosen, notes };
}

export const transformerOcCheck = (x, code = "NEC") => (code === "CEC" ? cec26(x) : nec4503(x));

/* ------------------------------------------------------------ NEC 240.87 */
/**
 * x = { max_trip_a, method, inst_pickup_a, iarc_ka, iarc_reason }
 *  max_trip_a     highest continuous trip setting the breaker is rated for or can be adjusted to (A)
 *  inst_pickup_a  nominal instantaneous (or override) pickup, A; null when off
 *  iarc_ka        available arcing current at the protected equipment (reduced-scenario Iarc), kA; null when unknown
 * The pickup is taken at its +10 % tolerance (upper band of the generic LSIG shape) before the comparison.
 */
export function arcEnergyCheck(x) {
  const T = DATA.nec_240_87;
  const applies = x.max_trip_a >= T.threshold_a - 1e-9;
  const base = { clause: "NEC 240.87", applies, threshold_a: T.threshold_a, max_trip_a: x.max_trip_a, method: x.method || null, data_status: T._meta.status };
  if (!applies) return { ...base, status: "pass", pass: true, note: `Highest continuous trip ${x.max_trip_a} A is below ${T.threshold_a} A: not required.` };
  const m = T.methods.find((k) => k.key === x.method);
  if (!m) return { ...base, status: "fail", pass: false, note: "No arc energy reduction method selected." };
  if (!m.needs_arcing_current) return { ...base, status: "pass", pass: true, method_label: m.label, note: `${m.label}. Document the method and location (240.87(A)) and performance-test it at installation (240.87(C)).` };
  if (!(x.inst_pickup_a > 0)) return { ...base, status: "fail", pass: false, method_label: m.label, note: "The instantaneous element is off in the device settings." };
  const pickup_hi = x.inst_pickup_a * 1.1;
  if (!(x.iarc_ka > 0)) return { ...base, status: "warn", pass: null, method_label: m.label, pickup_a: pickup_hi, note: `Cannot verify: needs arc-flash data${x.iarc_reason ? ` (${x.iarc_reason})` : ""}.` };
  const iarc_a = x.iarc_ka * 1000, pass = pickup_hi < iarc_a;
  return { ...base, status: pass ? "pass" : "fail", pass, method_label: m.label, pickup_a: pickup_hi, iarc_a,
    note: `Pickup ${x.inst_pickup_a.toFixed(0)} A (+10 % = ${pickup_hi.toFixed(0)} A) ${pass ? "<" : "≥"} arcing current ${iarc_a.toFixed(0)} A.` };
}

/* ---------------------------------------------------------- NEC 110.16(B) */
/** x = { rating_a, service, kv, ik_ka, clearing_s, label_date } */
export function serviceLabelCheck(x) {
  const T = DATA.nec_110_16_b;
  const applies = !!x.service && x.rating_a >= T.threshold_a - 1e-9;
  const prefill = [
    { field: T.label_fields[0], value: x.kv != null ? (x.kv < 1 ? `${Math.round(x.kv * 1000)} V` : `${x.kv} kV`) : null },
    { field: T.label_fields[1], value: x.ik_ka != null ? `${x.ik_ka.toFixed(2)} kA` : null },
    { field: T.label_fields[2], value: x.clearing_s != null && isFinite(x.clearing_s) ? `${x.clearing_s.toFixed(3)} s` : null },
    { field: T.label_fields[3], value: x.label_date || null },
  ];
  const base = { clause: "NEC 110.16(B)", applies, threshold_a: T.threshold_a, rating_a: x.rating_a, prefill, data_status: T._meta.status };
  if (!applies) return { ...base, status: "pass", pass: true, note: x.service ? `Rated ${x.rating_a} A, below ${T.threshold_a} A: not required.` : "Not service equipment." };
  if (x.label_date) return { ...base, status: "pass", pass: true, note: `Label recorded as applied ${x.label_date}.` };
  const missing = prefill.slice(0, 3).filter((p) => !p.value).map((p) => p.field.toLowerCase());
  return { ...base, status: "warn", pass: null, note: `Permanent label required (service equipment ≥ ${T.threshold_a} A). Enter the date once applied.${missing.length ? ` Not known from the model: ${missing.join(", ")}.` : ""}` };
}

/* ------------------------------------------------------- system wiring */
// Lineup trips per connector, as the Coordination view uses them. A gear-to-gear run appears in both lineups:
// the source-end feeder breaker protects it, so its trip wins over the load-end main, whatever the equipment order.
export function lineupTrips(sys, analysis) {
  const trips = {};
  for (const g of sys.equipment.filter((e) => NODE_KINDS.has(e.type))) {
    const kv = { ...EQUIPMENT[g.type].defaults, ...g }.kv;
    try {
      for (const c of buildLineup(sys, analysis, g.id).circuits) {
        if (kv > 1) continue;
        if (c.kind === "feeder") trips[c.tag] = c.trip; else trips[c.tag] ??= c.trip;
      }
    } catch (err) { /* gear without circuits */ }
  }
  return trips;
}

const eqFull = (sys, id) => { const e = sys.equipment.find((x) => x.id === id); return e ? { ...EQUIPMENT[e.type].defaults, ...e } : null; };

// Load-end equipment of a connector: the end power flows into (transformer HV terminals are always the load end).
function loadEnd(c, analysis) {
  const r = analysis.connectors[c.id];
  if (c.to.endsWith(".hv")) return c.to.split(".")[0];
  if (c.from.endsWith(".hv")) return c.from.split(".")[0];
  if (r && !r.open && r.dir != null) return (r.dir >= 0 ? c.to : c.from).split(".")[0];
  return c.to.split(".")[0];
}

/** The protective device at the source end of connector `connId`, from the TCC model. null if the run is open / not solved. */
export function deviceForConnector(sys, analysis, connId, trips) {
  const c = sys.connectors.find((x) => x.id === connId);
  const r = analysis.connectors?.[connId];
  if (!c || c.closed === false || !r || r.open) return null;
  const start = loadEnd(c, analysis);
  let d = null;
  try { d = protectionPath(sys, analysis, start, trips).devices.find((x) => x.connector === connId) ?? null; } catch (err) { d = null; }
  if (!d) {
    // fallback (e.g. a second incomer the upstream walk did not take): default settings plus manual overrides
    const src = (c.from.split(".")[0] === start ? c.to : c.from).split(".")[0];
    const kv = analysis.equipment[src]?.kv ?? analysis.equipment[start]?.kv;
    const kind = kv > 1 ? "relay" : "breaker";
    const rating = trips[connId] ?? Math.max(r.i_a * 1.25, 15);
    d = { connector: connId, at: src, kind, kv, ratio: 1, role: "feeder", rating_a: rating, settings: { ...defaultSettings(kind, rating, "feeder"), ...(c.protection || {}) },
      label: `${kind === "relay" ? "51/50" : "Breaker"} ${connId} at ${src}` };
  }
  return { ...d, load_end: start };
}

// Device as the code checks see it: relay pickup (relay-operated breaker) or LV long-time pickup Ir.
export function deviceSetting(d) {
  if (!d) return null;
  if (d.kind === "relay") return { type: "breaker", setting_a: d.settings.pickup, label: `${d.label} (51 pickup)`, kv: d.kv };
  const s = d.settings;
  return { type: "breaker", setting_a: s.ltpu * s.sensor, label: `${d.label} (Ir)`, kv: d.kv, max_trip_a: s.sensor, inst_pickup_a: s.inst ? s.inst * s.sensor : null };
}

const fmtA = (a) => (a == null ? "—" : a >= 100 ? a.toFixed(0) : a.toFixed(1));

/**
 * All protection code checks for a solved system.
 * opts: { code: "NEC" | "CEC" (default sys.code or NEC), allow_placeholder_data (arc flash) }
 * Returns { code, checks: [ { key, target: { kind, id }, group, name, clause, status, pass, value, limit, unit, note, detail, input, data_status } ], notes }.
 */
export function protectionCodeChecks(sys, analysis, opts = {}) {
  const code = opts.code ?? (CODES.includes(sys.code) ? sys.code : "NEC");
  const out = { code, checks: [], notes: [], data_status: PROT_DATA_STATUS };
  if (!analysis?.ok) { out.notes.push("Solve the system first."); return out; }
  const trips = lineupTrips(sys, analysis);
  const ends = (id, term) => sys.connectors.filter((c) => c.from === `${id}.${term}` || c.to === `${id}.${term}`);

  /* transformers */
  for (const raw of sys.equipment.filter((e) => e.type === "transformer")) {
    const t = eqFull(sys, raw.id), r = analysis.equipment[t.id];
    if (!r || r.deenergized) continue;
    const pDevs = ends(t.id, "hv").map((c) => deviceForConnector(sys, analysis, c.id, trips)).filter(Boolean);
    const sDevs = ends(t.id, "lv").map((c) => deviceForConnector(sys, analysis, c.id, trips)).filter((d) => d && d.at === t.id);
    const P = pDevs.length ? deviceSetting(pDevs[0]) : null;
    const sSet = sDevs.map(deviceSetting);
    const S = sSet.length ? { type: "breaker", setting_a: sSet.reduce((a, d) => a + d.setting_a, 0), label: sSet.map((d) => d.label).join(" + ") } : null;
    const input = { kva: t.kva, hv_kv: t.hv_kv, lv_kv: t.lv_kv, z_pct: t.z_pct, supervised: t.oc_supervised === true, primary: P, secondary: S };
    const res = transformerOcCheck(input, code);
    const chips = [res.clause, res.table].filter((v, i, a) => a.indexOf(v) === i);
    const scheme = res.chosen?.scheme;
    const alt = res.options.filter((o) => o !== res.chosen).map((o) => `${o.scheme}: ${optionPass(o) ? "pass" : "fail"}`);
    const head = `${t.kva} kVA ${t.hv_kv}/${t.lv_kv} kV, Z ${t.z_pct} %: rated ${fmtA(res.fla_p)} A primary, ${fmtA(res.fla_s)} A secondary. ${res.supervised ? "Supervised" : "Unsupervised"} location.`;
    if (!res.chosen) {
      out.checks.push({ key: `${t.id}:oc`, target: { kind: "eq", id: t.id }, group: t.id, group_type: "transformer", name: "Transformer overcurrent protection", clause: res.clause, chips,
        status: "warn", pass: null, value: null, limit: null, unit: "A", note: res.notes.join(" "), detail: head, input: { kind: "transformer", supervised: res.supervised }, data_status: res.data_status });
      continue;
    }
    for (const it of res.chosen.items) {
      out.checks.push({
        key: `${t.id}:oc:${it.side}`, target: { kind: "eq", id: t.id }, group: t.id, group_type: "transformer",
        name: `${it.side === "primary" ? "Primary" : "Secondary"} device ≤ ${it.pct} % of rated current`,
        clause: `${res.clause} ${res.table}`, chips, status: it.pass ? "pass" : "fail", pass: it.pass,
        value: it.setting_a, limit: it.allowed_a, unit: "A", direction: "max",
        note: `${it.device ?? "no device"} · ${it.note} · scheme: ${scheme}${res.pass === false && alt.length ? ` (also tried: ${alt.join("; ")})` : ""}`,
        detail: head + " " + res.notes.join(" "), input: { kind: "transformer", supervised: res.supervised }, data_status: res.data_status,
      });
    }
  }

  if (code === "NEC") {
    /* 240.87: every LV breaker (source end of each closed connector) with a highest continuous trip ≥ threshold */
    let afRows = null, afReason = null;
    const afFor = (gearId) => {
      if (afRows == null) { try { afRows = arcFlashStudy(analysis, sys, { allow_placeholder_data: !!opts.allow_placeholder_data }); } catch (err) { afRows = []; afReason = err.message; } }
      const row = afRows.find((x) => x.id === gearId);
      if (!row) return { iarc_ka: null, reason: afReason || "no arc-flash row for the load-side equipment" };
      if (row.error) return { iarc_ka: null, reason: row.placeholder ? "arc-flash coefficients are PLACEHOLDER-gated" : row.error };
      return { iarc_ka: row.iarc_min_ka, reason: null, status: row.data_status };
    };
    for (const c of sys.connectors) {
      const d = deviceForConnector(sys, analysis, c.id, trips);
      if (!d || d.kind !== "breaker") continue;
      const s = deviceSetting(d);
      if (!(s.max_trip_a >= DATA.nec_240_87.threshold_a - 1e-9)) continue;
      const gear = NODE_KINDS.has(eqFull(sys, d.load_end)?.type) ? d.load_end : null;
      const af = gear ? afFor(gear) : { iarc_ka: null, reason: "load side is not switchgear, an MCC or a panel" };
      const res = arcEnergyCheck({ max_trip_a: s.max_trip_a, method: c.aer_method, inst_pickup_a: s.inst_pickup_a, iarc_ka: af.iarc_ka, iarc_reason: af.reason });
      const where = NODE_KINDS.has(eqFull(sys, d.at)?.type) ? d.at : d.load_end;
      out.checks.push({
        key: `${c.id}:aer`, target: { kind: "con", id: c.id }, group: where, group_type: eqFull(sys, where)?.type, name: `Arc energy reduction, ${d.label} (${fmtA(s.max_trip_a)} A)`,
        clause: "NEC 240.87", chips: ["NEC 240.87"], status: res.status, pass: res.pass,
        value: res.pickup_a ?? s.max_trip_a, limit: res.iarc_a ?? DATA.nec_240_87.threshold_a, unit: "A", direction: res.iarc_a != null ? "max" : "min",
        note: res.note + (af.status && af.status !== "VERIFIED" && res.iarc_a != null ? ` Arcing current from ${af.status} IEEE 1584 data.` : ""),
        detail: `Highest continuous trip setting taken as the trip unit sensor / rating plug (${fmtA(s.max_trip_a)} A); ≥ ${DATA.nec_240_87.threshold_a} A requires a method. Arcing current: reduced-scenario Iarc at ${gear ?? "—"}.`,
        input: { kind: "aer", method: c.aer_method ?? "" }, data_status: res.data_status,
      });
    }
    /* 110.16(B): service equipment */
    const utilIds = new Set(sys.equipment.filter((e) => e.type === "utility").map((e) => e.id));
    for (const raw of sys.equipment.filter((e) => NODE_KINDS.has(e.type))) {
      const g = eqFull(sys, raw.id), r = analysis.equipment[g.id];
      if (!r || r.deenergized) continue;
      const feeders = sys.connectors.filter((c) => [c.from, c.to].some((t) => t.startsWith(g.id + ".")) && [c.from, c.to].some((t) => utilIds.has(t.split(".")[0])));
      const assumed = g.service == null;
      const service = assumed ? feeders.length > 0 : !!g.service;
      if (!service && assumed) continue;
      let clearing = null;
      const dev = feeders.length ? deviceForConnector(sys, analysis, feeders[0].id, trips) : null;
      if (dev && r.ik_ka != null) { const t = deviceTimes(dev, (r.ik_ka * 1000) / (dev.ratio || 1)).max; clearing = isFinite(t) ? t : null; }
      const res = serviceLabelCheck({ rating_a: g.bus_a, service, kv: g.kv, ik_ka: r.ik_ka, clearing_s: clearing, label_date: g.label_date });
      out.checks.push({
        key: `${g.id}:label`, target: { kind: "eq", id: g.id }, group: g.id, group_type: g.type, name: res.applies ? "Service equipment arc-flash label" : "Service equipment label (not required)",
        clause: "NEC 110.16(B)", chips: ["NEC 110.16(B)"], status: res.status, pass: res.pass, value: g.bus_a, limit: DATA.nec_110_16_b.threshold_a, unit: "A", direction: "min",
        note: res.note + (assumed ? " Service equipment assumed (fed directly from the utility)." : ""),
        detail: "Available fault current is the study I″k (IEC 60909 with c_max). Clearing time is the upper band of the service device curve at that current" + (dev ? ` (${dev.label}).` : "."),
        prefill: res.applies ? res.prefill : null, input: { kind: "label", service: g.service, assumed, label_date: g.label_date ?? "" }, data_status: res.data_status,
      });
    }
  } else {
    out.notes.push("NEC 240.87 and 110.16(B) have no CEC equivalent in this tool; they are not evaluated under CEC.");
  }
  return out;
}

/** Report rows for the calc package: pass true/false, null for checks that need review. */
export function complianceReportChecks(res) {
  return res.checks.map((k) => ({ name: `${k.group} ${k.name}`, value: k.value, limit: k.limit, unit: k.unit, pass: k.pass ?? null, clause: `${k.clause} (${k.data_status})`, note: k.note }));
}
