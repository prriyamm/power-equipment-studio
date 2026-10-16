/* Cable bus Check tab: shield (sheath) standing voltage with single-point bonding and the single-point vs
   both-ends bonding comparison. Engine: res.sheath from src/engine/pecalc/cablebus.js (port of pecalc). */
import { Section, Pill, KpiStrip, fmt } from "./common.jsx";
import { Chart, Line, RefLine, Dot, PHASE_VAR } from "./charts/index.js";

const FT = 0.3048;
const MODE_LABEL = { single_point: "Single point", both_ends: "Both ends" };
const dash = (v, d = 1, unit = "") => (v === null || v === undefined ? "—" : `${fmt(v, d)}${unit ? ` ${unit}` : ""}`);

/* Standing voltage rising linearly from the bonded end (0) to the open end of one section, one line per shield. */
function StandingChart({ sh }) {
  const Lm = sh.section_length_m, Lft = Lm / FT;
  // shields with the same voltage (mirror images) draw as one line; keep the first label of each
  const seen = new Map();
  for (const s of sh.shields) {
    const k = s.e_v_per_km.toFixed(2);
    if (!seen.has(k)) seen.set(k, { ...s, n: 1 }); else seen.get(k).n += 1;
  }
  const lines = [...seen.values()].sort((a, b) => a.e_v_per_km - b.e_v_per_km);
  const lim = sh.voltage_limit_v;
  const vmax = Math.max(sh.standing_v, lim || 0) * 1.12 || 1;
  const xs = [0, Lft / 4, Lft / 2, (3 * Lft) / 4, Lft];
  const worst = sh.shields.find((s) => s.label === sh.worst_shield);
  return (
    <Chart height={230} ariaLabel="Shield standing voltage along the bonded section" reportTitle="Shield standing voltage along the bonded section"
      x={{ domain: [0, Lft], nice: false, label: "Distance from the bonded end", unit: "ft", padRight: 58 }}
      y={{ domain: [0, vmax], label: "Shield voltage to ground", unit: "V" }}
      legend={[{ name: "A", color: PHASE_VAR.A }, { name: "B", color: PHASE_VAR.B }, { name: "C", color: PHASE_VAR.C },
        ...(lim ? [{ name: `Limit ${fmt(lim, 0)} V`, color: "var(--crit)", kind: "ref" }] : [])]}
      hover={{ xs, render: (i) => ({ title: `${fmt(xs[i], 0)} ft (${fmt(xs[i] * FT, 1)} m) from the bonded end`,
        rows: lines.map((s) => ({ label: `${s.label}${s.n > 1 ? ` +${s.n - 1}` : ""}`, value: `${fmt((s.e_v_per_km / 1000) * xs[i] * FT, 2)} V`, color: PHASE_VAR[s.phase] })) }),
        points: (i) => lines.map((s) => ({ y: (s.e_v_per_km / 1000) * xs[i] * FT, color: PHASE_VAR[s.phase] })) }}>
      {lim ? <RefLine y={lim} tone="crit" label={`limit ${fmt(lim, 0)} V`} align="start" /> : null}
      <RefLine x={Lft} tone="accent" label="open end" />
      {lines.map((s) => (
        <Line key={s.label} data={[{ x: 0, y: 0 }, { x: Lft, y: s.standing_v }]} color={PHASE_VAR[s.phase]}
          width={s.label === sh.worst_shield ? 2.5 : 1.5} dash={s.label === sh.worst_shield ? undefined : "4 3"} />
      ))}
      {worst && <Dot x={Lft} y={worst.standing_v} color={PHASE_VAR[worst.phase]} />}
    </Chart>
  );
}

export function SheathSection({ res }) {
  const sh = res.sheath;
  if (!sh) return null;
  const sp = sh.modes.single_point, be = sh.modes.both_ends;
  const lim = sh.voltage_limit_v;
  const has = sh.standing_v !== null;
  const status = !has || lim === null ? undefined : sh.passed ? "pass" : "fail";
  const secFt = sh.section_length_m / FT;
  const rows = [
    ["Shield circulating current (max)", (m) => dash(m.shield_current_a, 0, "A")],
    ["Shield loss (whole run)", (m) => dash(m.shield_loss_w / 1000, 2, "kW")],
    ["Worst shield loss factor λ1", (m) => dash(m.max_lambda1, 3)],
    ["Lowest cable ampacity", (m) => dash(m.min_ampacity_a, 0, "A")],
    ["Worst cable loading", (m) => dash(m.max_loading_pct, 1, "%")],
    ["Standing voltage, normal load", (m, k) => (k === "both_ends" ? "≈ 0 (bonded at both ends)" : dash(m.standing_v, 2, "V"))],
    ["Standing voltage, through-fault", (m, k) => (k === "both_ends" ? "≈ 0" : m.standing_v_fault === null ? "no fault current" : dash(m.standing_v_fault, 0, "V"))],
  ];
  const modes = ["single_point", "both_ends"].filter((k) => sh.modes[k]);
  return (
    <Section title="Shield bonding and standing voltage" aside={
      <span className="cb-from">
        <Pill tone={sh.bonding === "single_point" ? "accent" : "muted"}>design: {MODE_LABEL[sh.bonding]}</Pill>
        {lim === null ? <Pill tone="warn">no limit set</Pill> : <Pill tone={sh.passed ? "ok" : "crit"}>{sh.passed ? "within limit" : "over limit"}</Pill>}
      </span>}>
      <KpiStrip items={[
        { label: "Standing voltage, open end", value: has ? fmt(sh.standing_v, 1) : "—", unit: has ? "V" : "", status,
          meter: has && lim ? { u: sh.standing_v / lim, label: `${fmt((sh.standing_v / lim) * 100, 0)} % of the ${fmt(lim, 0)} V limit` } : undefined,
          sub: has ? `single point · ${sh.worst_shield} · ${fmt(sh.e_v_per_km, 1)} V/km × ${fmt(secFt, 0)} ft section${sh.sections > 1 ? ` (${sh.sections} sections)` : ""}`
            : "needs the shield mean diameter or a shield thickness" },
        { label: "Through-fault standing voltage", value: sh.standing_v_fault === null ? "—" : fmt(sh.standing_v_fault, 0), unit: sh.standing_v_fault === null ? "" : "V",
          sub: sh.standing_v_fault === null ? "give a fault current" : `${fmt(sh.fault_ka, 1)} kA balanced 3-phase · compare with jacket / SVL rating` },
        { label: "Voltage limit", value: lim === null ? "not set" : fmt(lim, 0), unit: lim === null ? "" : "V", status: lim === null ? "warn" : undefined,
          sub: lim === null ? "set your utility / owner limit: no verified public value" : sh.max_section_m_for_limit !== null ? `longest section within limit ${fmt(sh.max_section_m_for_limit / FT, 0)} ft (${fmt(sh.max_section_m_for_limit, 1)} m)` : "" },
        be && { label: "Both-ends bonding would cost", value: fmt(be.shield_loss_w / 1000, 2), unit: "kW",
          sub: `${fmt(be.shield_current_a, 0)} A circulating · λ1 ${fmt(be.max_lambda1, 3)} · ampacity ${sp ? `${fmt(sp.min_ampacity_a, 0)} → ` : ""}${fmt(be.min_ampacity_a, 0)} A` },
      ]} />
      {has && <div className="mt-3"><StandingChart sh={sh} /></div>}
      {has && <div className="ck-caption">Voltage on each single-point bonded shield rises linearly from the bonded end to the open end of each {fmt(secFt, 0)} ft bonded section. Solid line: worst shield; mirror-image shields share a line.</div>}
      <div className="table-wrap mt-3">
        <table className="grid-table">
          <thead><tr><th>Bonding comparison</th>{modes.map((k) => <th key={k} className="r">{MODE_LABEL[k]}{k === sh.bonding ? " (design)" : ""}</th>)}</tr></thead>
          <tbody>
            {rows.map(([label, f]) => (
              <tr key={label}><td className="cb-wrap">{label}</td>{modes.map((k) => <td key={k} className="r">{f(sh.modes[k], k)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="cb-note mt-3" style={{ fontSize: 13, color: "var(--muted)" }}>{sh.recommendation}</p>
      <ul className="cb-notes mt-2">{sh.notes.map((t, k) => <li key={k}>{t}</li>)}</ul>
    </Section>
  );
}

/* Calculation-package additions: result rows, comparison table, notes and data status. */
export function sheathReport(res) {
  const sh = res.sheath;
  if (!sh) return { results: [], tables: [], notes: [], dataStatus: [] };
  const modes = ["single_point", "both_ends"].filter((k) => sh.modes[k]);
  const v = (x) => (x === null || x === undefined ? "" : x);
  return {
    results: [
      { label: "Shield standing voltage, open end (single point, normal)", value: sh.standing_v, unit: "V" },
      { label: "Shield standing voltage, through-fault", value: sh.standing_v_fault, unit: "V" },
      { label: "Worst shield", value: sh.worst_shield },
      { label: "Bonded section length", value: sh.section_length_m, unit: "m" },
      { label: "Shield standing-voltage limit (user input)", value: sh.voltage_limit_v === null ? "not set" : sh.voltage_limit_v, unit: sh.voltage_limit_v === null ? "" : "V" },
    ],
    tables: [
      { title: "Shield bonding comparison", columns: ["Bonding", "Shield current (A)", "Shield loss (W)", "Max λ1", "Lowest ampacity (A)", "Worst loading %", "Standing V (normal)", "Standing V (fault)"],
        rows: modes.map((k) => { const m = sh.modes[k]; return [MODE_LABEL[k] + (k === sh.bonding ? " (design)" : ""), m.shield_current_a, m.shield_loss_w, m.max_lambda1, m.min_ampacity_a, m.max_loading_pct, v(m.standing_v), v(m.standing_v_fault)]; }) },
      ...(sh.shields.length ? [{ title: "Shield standing voltage per cable (single point)", columns: ["Shield", "Phase", "x (mm)", "y (mm)", "V/km", "V normal", "V fault"],
        rows: sh.shields.map((s) => [s.label, s.phase, s.x_mm, s.y_mm, s.e_v_per_km, s.standing_v, v(s.standing_v_fault)]) }] : []),
    ],
    notes: [sh.recommendation, ...sh.notes],
    dataStatus: [{ table: "Shield standing-voltage limit (IEEE 575 practice ~25 V per a secondary source, LOW confidence)",
      status: sh.voltage_limit_v === null ? "NOT SET (user input)" : "UNVERIFIED (user input)", source: "user / owner / utility; https://www.texcan.com/articles/technical-news/power-cable-shielding" }],
  };
}
