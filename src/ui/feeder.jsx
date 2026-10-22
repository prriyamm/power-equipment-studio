/* Feeder & cable workspace: conductor sizing with parallel sets, voltage drop, withstand and lug schedule
   (pecalc sizing + lugs port), live as inputs change. */
const { useState, useMemo, useEffect, useRef } = React;
import { Btn, Field, NumField, Pill, Section, fmt, WsHeader, KpiStrip, ChecksTable, StateMsg, checkMeter, checkStatus } from "./common.jsx";
import { Chart, Line, RefLine, Dot, SERIES_VAR } from "./charts/index.js";
import { bus } from "./bus.js";
import { PushToSystem } from "./systemPush.jsx";
import { feederDesign } from "../engine/designPush.js";
import { feederInput, sizeFeeder, loadA } from "../engine/pecalc/sizing.js";
import { selectLugs, lugInput } from "../engine/pecalc/lugs.js";
import { cableOdMm, diameterMm, sizeIndex } from "../engine/pecalc/conductors.js";
import { kvRows, checkRows } from "../engine/report.js";
import { tableInfo } from "../engine/pecalc/ampacity.js";
import { ReportButton, reportFigures } from "./reportButton.jsx";

const FT = 0.3048;

/* Starting state: the 480 V, 400 A continuous feeder, 100 ft in PVC conduit (examples/feeder-480v-400a.json). */
const EXAMPLE = {
  code: "NEC", voltage_v: 480, phases: 3, mode: "A", load: 400, kva: 300, cont_pct: 100,
  length: 100, unit: "ft", material: "Cu", insulation_temp_c: 90, terminal_temp_c: null,
  installation: "raceway", conduit: "pvc", ambient_c: 30, current_carrying_per_raceway: 3,
  power_factor: 0.85, max_vd_pct: 3, fault_ka: null, fault_clearing_s: null, sets: null,
  hundred_percent_rated: false, allow_placeholder_data: false,
  src_term: "bus", load_term: "bus", pad_positions: null, conduit_size: "auto",
};

/* Nominal inside diameters (in) by trade size, used only to draw and fill-check the raceway.
   [UNVERIFIED: Schedule 40 pipe nominal inside diameters; confirm against NEC Chapter 9 Table 4 for the conduit type] */
const TRADE = [["1/2", 0.622], ["3/4", 0.824], ["1", 1.049], ["1-1/4", 1.38], ["1-1/2", 1.61], ["2", 2.067],
  ["2-1/2", 2.469], ["3", 3.068], ["3-1/2", 3.548], ["4", 4.026], ["5", 5.047], ["6", 6.065]];
const FILL_LIMIT = 40; // NEC Chapter 9 Table 1, three or more conductors [UNVERIFIED]

const RULES = [
  ["Min size", (n) => n.startsWith("Minimum size")],
  ["Terminal", (n) => n.startsWith("Terminal-column")],
  ["Derated", (n) => n === "Derated ampacity >= load"],
  ["Allowable", (n) => n.startsWith("Allowable ampacity")],
  ["Volt drop", (n) => n === "Voltage drop"],
  ["Withstand", (n) => n.startsWith("Short-circuit")],
];
const ruleOf = (c) => (RULES.find(([, f]) => f(c.name)) || [c.name])[0];

function build(ui) {
  const lenM = ui.unit === "ft" ? ui.length * FT : ui.length;
  let amps = ui.load;
  if (ui.mode === "kVA") amps = ui.phases === 3 ? (ui.kva * 1000) / (Math.sqrt(3) * ui.voltage_v) : (ui.kva * 1000) / ui.voltage_v;
  const cont = (amps * ui.cont_pct) / 100;
  return {
    amps,
    inp: feederInput({
      code: ui.code, voltage_v: ui.voltage_v, phases: ui.phases, continuous_a: cont, noncontinuous_a: amps - cont,
      length_m: lenM, material: ui.material, insulation_temp_c: ui.insulation_temp_c, terminal_temp_c: ui.terminal_temp_c,
      installation: ui.installation, conduit: ui.conduit, ambient_c: ui.ambient_c,
      current_carrying_per_raceway: ui.current_carrying_per_raceway, power_factor: ui.power_factor, max_vd_pct: ui.max_vd_pct,
      fault_ka: ui.fault_ka, fault_clearing_s: ui.fault_clearing_s, sets: ui.sets, hundred_percent_rated: ui.hundred_percent_rated,
      allow_placeholder_data: ui.allow_placeholder_data,
    }),
  };
}

function solve(ui) {
  try {
    const { inp, amps } = build(ui);
    if (!(ui.voltage_v > 0)) throw new Error("voltage must be positive");
    if (!(inp.length_m > 0)) throw new Error("length must be positive");
    if (!(inp.power_factor > 0 && inp.power_factor <= 1)) throw new Error("power factor must be in (0, 1]");
    const result = sizeFeeder(inp);
    let lugs = null;
    if (result.recommended) {
      const b = result.recommended;
      const mk = (termination) => selectLugs(lugInput({
        code: inp.code, size: b.size, material: inp.material, sets_per_phase: b.sets, phases: inp.phases,
        circuit_current_a: amps, equipment_terminal_temp_c: result.input.terminal_temp_c, termination,
        pad_positions: ui.pad_positions || null,
      }));
      lugs = { source: mk(ui.src_term), load: mk(ui.load_term) };
    }
    return { result, lugs, amps };
  } catch (e) {
    return { error: e.message, placeholder: e.name === "DataStatusError" };
  }
}

/* Calculation package (see engine/report.js). */
function feederReport(ui, host) {
  const { result: r, lugs, error } = solve(ui);
  if (!r) throw new Error(error || "no result");
  const i = r.input, b = r.recommended, info = tableInfo(i.code, i.installation);
  return {
    title: "Feeder sizing", module: "feeder", subtitle: `${i.code}, ${i.voltage_v} V, ${i.phases}-phase, ${i.material}`,
    inputs: kvRows(i, { voltage_v: "V", continuous_a: "A", noncontinuous_a: "A", length_m: "m", ambient_c: "C", fault_ka: "kA", max_vd_pct: "%" }),
    results: b ? [
      { label: "Recommended conductors", value: `${b.sets} x ${b.size_label} per phase` }, { label: "Ampacity per set", value: b.ampacity_per_set_a, unit: "A" },
      { label: "Voltage drop", value: b.vd_pct, unit: "%" }, { label: "Voltage drop", value: b.vd_v, unit: "V" }, { label: "Losses", value: b.loss_w, unit: "W" },
    ] : [{ label: "Recommended conductors", value: "none passes every check" }],
    checks: checkRows(b ? b.checks : []),
    tables: [
      ...(r.alternatives.length ? [{ title: "Other passing options", columns: ["Conductors", "VD %", "Loss W", "Copper mm2 / phase"],
        rows: r.alternatives.map((a) => [`${a.sets} x ${a.size_label}`, a.vd_pct, a.loss_w, a.total_area_mm2]) }] : []),
      ...(lugs ? [{ title: "Lugs", columns: ["End", "Qty", "Conductor", "Style", "Material", "Stud (in)"],
        rows: [["Source", lugs.source], ["Load", lugs.load]].flatMap(([e, l]) => l.lines.map((x) => [e, x.quantity, x.conductor, x.style, x.lug_material, x.stud_in])) }] : []),
    ],
    figures: reportFigures(host),
    notes: [...r.notes, ...(b ? b.notes : []), ...(lugs ? lugs.source.notes : [])],
    dataStatus: [{ table: `${i.code} ${info.table_name} (${info.edition})`, status: info.status, source: info.source }],
  };
}

/* For each set count: the options tried, in order, and the rules that rejected the last failing size. */
function candidates(result) {
  const bySets = new Map();
  for (const o of result.considered) {
    if (!bySets.has(o.sets)) bySets.set(o.sets, []);
    bySets.get(o.sets).push(o);
  }
  const rows = [];
  for (const [sets, list] of bySets) {
    const pass = list.find((o) => o.passed);
    const idx = pass ? list.indexOf(pass) : list.length - 1;
    const prev = idx > 0 ? list[idx - 1] : null;
    if (prev) rows.push({ o: prev, role: "rejected", governing: [...new Set(prev.checks.filter((c) => !c.passed).map(ruleOf))] });
    rows.push({ o: list[idx], role: pass ? "selected" : "rejected",
      governing: pass ? [] : [...new Set(list[idx].checks.filter((c) => !c.passed).map(ruleOf))], sets });
  }
  return rows;
}

export function FeederWorkspace({ goTo }) {
  const [ui, setUi] = useState(EXAMPLE);
  const [link, setLink] = useState(null);            // System cable run this feeder is designed for
  const hostRef = useRef(null);
  const { result: r, lugs, amps, error, placeholder } = useMemo(() => solve(ui), [ui]);
  const push = useMemo(() => { if (!r) return { error }; try { return { design: feederDesign(r) }; } catch (e) { return { error: e.message }; } }, [r, error]);

  // A cable run opened from the System view: its voltage, load-flow current, length and construction.
  useEffect(() => bus.on("feeder:open", ({ connector: c, current_a, kv, fault_ka }) => {
    setUi((s) => ({
      ...s, mode: "A", unit: "ft", installation: "raceway", sets: null,
      ...(kv ? { voltage_v: Math.round(kv * 1000) } : {}), ...(current_a > 0 ? { load: Math.round(current_a) } : {}),
      ...(c.length_ft ? { length: c.length_ft } : {}), ...(c.material ? { material: c.material } : {}),
      ...([60, 75, 90].includes(c.insulation_c) ? { insulation_temp_c: c.insulation_c } : {}),
      terminal_temp_c: [60, 75, 90].includes(c.terminal_c) ? c.terminal_c : null, // null: 110.14(C) default
      ...(["pvc", "aluminum", "steel"].includes(c.raceway) ? { conduit: c.raceway } : {}),
      ...(fault_ka > 0 ? { fault_ka: Math.round(fault_ka * 10) / 10 } : {}),
    }));
    if (c.id) setLink({ kind: "con", id: c.id });
  }), []);
  const set = (k, optional) => (v) => setUi((s) => (v === undefined && !optional ? s : { ...s, [k]: v === undefined ? null : v }));
  const num = (k, label, unit, o = {}) => (
    <Field label={label} unit={unit} hint={o.hint}>
      <NumField id={`fd-${k}`} value={ui[k] === null ? undefined : ui[k]} placeholder={o.ph} disabled={o.disabled} onCommit={set(k, o.optional)} />
    </Field>
  );
  const pick = (k, label, opts, o = {}) => (
    <Field label={label} hint={o.hint}>
      <select id={`fd-${k}`} className="num-input" value={ui[k] === null ? "" : ui[k]}
        onChange={(e) => { const raw = e.target.value; setUi((s) => ({ ...s, [k]: o.numeric ? (raw === "" ? null : Number(raw)) : raw })); }}>
        {opts.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
    </Field>
  );

  return (
    <div className="ws fd" ref={hostRef}>
      <style>{CSS}</style>
      <WsHeader title="Feeder & cable" context="Conductor sizing, voltage drop, withstand and lugs"
        status={<>
          {r && <Pill tone={r.recommended ? "ok" : "crit"}>{r.recommended ? "Conductor found" : "No size passes"}</Pill>}
          {r && r.data_status !== "VERIFIED" && <Pill tone="warn" title={r.notes.find((n) => n.startsWith("WARNING")) || ""}>Data {r.data_status}</Pill>}
          {error && <Pill tone="crit">Input error</Pill>}
        </>}
        actions={<>
          <PushToSystem module="feeder" design={push.design || null} designError={push.error} link={link} setLink={setLink} goTo={goTo} />
          {r && <ReportButton filename="feeder-calc" getReport={() => feederReport(ui, hostRef.current)} />}
          <Btn onClick={() => setUi(EXAMPLE)} title="Restore the 480 V 400 A example inputs">Reset to example</Btn>
        </>} />

      <div className="main">
        <div className="fd-grid">
          <div className="fd-form">
            <Section title="Circuit">
              <div className="fd-fields">
                {num("voltage_v", "Voltage, line-line", "V")}
                {pick("phases", "Phases", [[3, "3-phase"], [1, "1-phase"]], { numeric: true })}
                {pick("mode", "Load entered as", [["A", "Current"], ["kVA", "Apparent power"]])}
                {ui.mode === "A" ? num("load", "Load current", "A") : num("kva", "Load", "kVA", { hint: `= ${fmt(amps, 1)} A` })}
                {num("cont_pct", "Continuous share", "%", { hint: "of the load" })}
                {num("power_factor", "Power factor", "lag")}
                {num("length", "One-way length", ui.unit)}
                {pick("unit", "Length unit", [["m", "metres"], ["ft", "feet"]])}
                {num("max_vd_pct", "Max voltage drop", "%")}
                {pick("code", "Code", [["NEC", "NEC"], ["CEC", "CEC"]])}
              </div>
              <label className="live-toggle mt-3" title="OCPD and equipment listed for 100 % continuous operation">
                <input id="fd-hundred" type="checkbox" checked={ui.hundred_percent_rated}
                  onChange={(e) => setUi((s) => ({ ...s, hundred_percent_rated: e.target.checked }))} />
                <span>Equipment rated for 100 % continuous</span>
              </label>
            </Section>
            <Section title="Conductor and installation">
              <div className="fd-fields">
                {pick("material", "Material", [["Cu", "Copper"], ["Al", "Aluminium"]])}
                {pick("insulation_temp_c", "Insulation rating", [[60, "60 °C"], [75, "75 °C"], [90, "90 °C"]], { numeric: true })}
                {pick("terminal_temp_c", "Terminal rating", [["", "Auto (110.14(C))"], [60, "60 °C"], [75, "75 °C"], [90, "90 °C"]], { numeric: true })}
                {pick("installation", "Installation", [["raceway", "Raceway"], ["free_air", "Free air / tray"]])}
                {pick("conduit", "Conduit type", [["pvc", "PVC"], ["aluminum", "Aluminium"], ["steel", "Steel"]])}
                {num("ambient_c", "Ambient", "°C")}
                {num("current_carrying_per_raceway", "Conductors in raceway", "count", { hint: "current-carrying" })}
                {pick("sets", "Parallel sets", [["", "Auto"], ...[1, 2, 3, 4, 5, 6, 8].map((n) => [n, String(n)])], { numeric: true })}
              </div>
            </Section>
            <Section title="Short circuit">
              <div className="fd-fields">
                {num("fault_ka", "Fault current", "kA", { optional: true, ph: "not checked" })}
                {num("fault_clearing_s", "Clearing time", "s", { optional: true, ph: "not checked" })}
              </div>
            </Section>
            <Section title="Terminations">
              <div className="fd-fields">
                {pick("src_term", "Source end", [["bus", "Bus pad (2-hole)"], ["stud", "Stud / 1-hole"], ["breaker", "Breaker lug"]])}
                {pick("load_term", "Load end", [["bus", "Bus pad (2-hole)"], ["stud", "Stud / 1-hole"], ["breaker", "Breaker lug"]])}
                {num("pad_positions", "Pad positions", "per phase", { optional: true, ph: "unchecked", hint: "2-hole positions, both faces" })}
              </div>
            </Section>
          </div>

          <div className="fd-results">
            {error && (
              <StateMsg kind="error" title="Cannot size this feeder">
                {error}. Correct the input on the left; results update as you type.
                {placeholder && (
                  <div className="mt-2">
                    <label className="live-toggle">
                      <input id="fd-placeholder" type="checkbox" checked={ui.allow_placeholder_data}
                        onChange={(e) => setUi((s) => ({ ...s, allow_placeholder_data: e.target.checked }))} />
                      <span>Allow PLACEHOLDER data for testing (results are not CEC values)</span>
                    </label>
                  </div>
                )}
              </StateMsg>
            )}
            {r && <Results r={r} lugs={lugs} ui={ui} amps={amps} setUi={setUi} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function Results({ r, lugs, ui, amps, setUi }) {
  const i = r.input, b = r.recommended;
  const rows = useMemo(() => candidates(r), [r]);
  const lugRows = lugs ? [["Source end", lugs.source], ["Load end", lugs.load]] : [];
  const failing = b ? b.checks.filter((c) => !c.passed) : [];
  const required = i.code === "NEC"
    ? (i.hundred_percent_rated ? 1 : 1.25) * i.continuous_a + i.noncontinuous_a
    : i.continuous_a / (i.hundred_percent_rated ? 1 : 0.8) + i.noncontinuous_a;
  const sc = b && b.checks.find((c) => c.name.startsWith("Short-circuit"));
  const std = (v) => (Number.isFinite(v) ? fmt(v, Math.abs(v) < 10 && v % 1 ? 2 : Math.abs(v) < 100 && v % 1 ? 1 : 0) : "∞");
  const kva = (Math.sqrt(3) * i.voltage_v * amps) / 1000;
  return (
    <>
      {!b && <StateMsg kind="error" title="No conductor passes every check">Nothing within {i.max_sets} parallel sets meets all rules. The candidates table shows the largest size tried for each set count and the rules that fail; try more sets, a larger voltage-drop limit or a different installation.</StateMsg>}
      <KpiStrip items={[
        { label: "Selected conductor", value: b ? `${b.sets} × ${b.size}` : "—", unit: b ? (sizeIndex(b.size) >= sizeIndex("250") ? "kcmil" : "AWG") : "",
          status: b ? "pass" : "fail", badge: true, sub: b ? `${i.material} · ${b.total_area_mm2} mm² total · ${i.insulation_temp_c} °C` : "see candidates" },
        { label: "Ampacity vs required", value: b ? fmt(b.ampacity_per_set_a * b.sets, 0) : "—", unit: "A", status: b ? "pass" : undefined,
          sub: b ? `need ${fmt(required, 0)} A · load ${fmt(amps, 0)} A` : `need ${fmt(required, 0)} A`,
          meter: b ? { u: required / (b.ampacity_per_set_a * b.sets), label: `${fmt((100 * required) / (b.ampacity_per_set_a * b.sets), 0)} % of ampacity used` } : null },
        { label: "Voltage drop", value: b ? fmt(b.vd_pct, 2) : "—", unit: "%", status: b ? (b.vd_pct <= i.max_vd_pct ? "pass" : "fail") : undefined,
          sub: b ? `${fmt(b.vd_v, 1)} V of ${fmt(i.voltage_v, 0)} V · limit ${i.max_vd_pct} %` : "", meter: b ? { u: b.vd_pct / i.max_vd_pct } : null },
        { label: "Losses", value: b ? fmt(b.loss_w / 1000, 2) : "—", unit: "kW", sub: b ? `${fmt((b.loss_w / (kva * 1000 * i.power_factor)) * 100, 2)} % of ${fmt(kva * i.power_factor, 0)} kW` : "" },
        { label: "Short-circuit withstand", value: sc ? fmt(sc.value, 1) : "—", unit: sc ? "kA" : "", status: checkStatus(sc),
          sub: sc ? `fault ${sc.limit} kA · ${sc.note.split(",")[0]}` : "enter fault kA and time", meter: checkMeter(sc) },
      ]} />

      <Section title="Candidate options" aside={<span className="text-faint text-[12px]">smallest passing size per number of sets · governing rule shaded</span>}>
        <div className="table-wrap">
          <table className="grid-table fd-cand">
            <thead>
              <tr><th>Option</th><th className="r">Area<em>mm²</em></th><th className="r">Ampacity<em>A</em></th><th className="r">VD<em>%</em></th><th className="r">Loss<em>kW</em></th>
                {RULES.map(([n]) => <th key={n} className="c">{n}</th>)}<th>Result</th></tr>
            </thead>
            <tbody>
              {rows.map(({ o, role, governing }, k) => {
                const isBest = b && o.sets === b.sets && o.size === b.size;
                return (
                  <tr key={k} className={isBest ? "fd-best" : role === "rejected" ? "fd-rej" : ""}>
                    <td>{o.sets} × {o.size_label}</td>
                    <td className="r">{fmt(o.total_area_mm2, 0)}</td>
                    <td className="r">{fmt(o.ampacity_per_set_a * o.sets, 0)}</td>
                    <td className="r">{fmt(o.vd_pct, 2)}</td>
                    <td className="r">{fmt(o.loss_w / 1000, 2)}</td>
                    {RULES.map(([n, f]) => {
                      const c = o.checks.find((x) => f(x.name));
                      return <td key={n} className={`c ${c && !c.passed ? "fd-bad" : ""} ${governing.includes(n) ? "fd-gov" : ""}`} title={c ? `${c.name}: ${std(c.value)} vs ${std(c.limit)} ${c.unit}` : "not applicable"}>
                        {c ? (c.passed ? "✓" : "✗") : "–"}</td>;
                    })}
                    <td className="fd-res">{isBest ? <Pill tone="ok">Recommended</Pill> : o.passed ? <Pill tone="muted">Passes</Pill> : <Pill tone="crit">{governing.join(", ") || "Fail"}</Pill>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {b && r.alternatives.length > 0 && (
          <div className="fd-alt">Other passing options by area:{" "}
            {r.alternatives.map((o) => `${o.sets} × ${o.size_label} (${fmt(o.total_area_mm2, 0)} mm²)`).join(" · ")}</div>
        )}
      </Section>

      {b && (
        <Section title="Checks" aside={<Pill tone={failing.length ? "crit" : "ok"}>{failing.length ? `${failing.length} fail` : "All pass"}</Pill>}>
          <ChecksTable checks={b.checks} format={std} />
          {b.notes.length > 0 && <ul className="fd-notes fd-opt-notes" aria-label="Notes on the recommended option">{b.notes.map((n, k) => <li key={k}>{n}</li>)}</ul>}
        </Section>
      )}

      {lugs && (
        <Section title="Lug schedule" aside={<span className="text-faint text-[12px]">terminal rating {lugs.source.terminal_temp_c} °C · {lugs.source.terminal_temp_basis.split(":")[0]}</span>}>
          <div className="table-wrap">
            <table className="grid-table">
              <thead><tr><th>End</th><th>Terminal</th><th>Conductor</th><th className="r">Qty</th><th>Style</th><th>Lug material</th><th>Stud</th><th>Spacing</th><th>Part / die / torque</th></tr></thead>
              <tbody>
                {lugRows.flatMap(([end, l]) => l.lines.map((ln, k) => (
                  <tr key={end + k}>
                    <td>{end}</td><td className="fd-wrap">{ln.terminal}</td><td>{ln.conductor}</td><td className="r">{ln.quantity}</td>
                    <td className="fd-wrap">{ln.style}</td><td className="fd-wrap">{ln.lug_material}</td>
                    <td>{ln.stud_in}{ln.stud_in.includes("/") ? " in" : ""}</td><td>{ln.hole_spacing_in ? `${ln.hole_spacing_in} in` : "—"}</td>
                    <td className="fd-wrap">{ln.part_no || ln.die || ln.torque ? [ln.part_no, ln.die, ln.torque].filter(Boolean).join(" / ") : "use manufacturer value"}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
          {lugRows.flatMap(([end, l]) => l.checks.map((c) => ({ end, c }))).map(({ end, c }, k) => (
            <div key={k} className={`notice ${c.passed ? "notice-info" : "notice-crit"} mt-2`}><b>{end}: {c.name}.</b> {c.value} vs {c.limit} {c.unit} {c.note && `(${c.note})`}</div>
          ))}
        </Section>
      )}

      <div className="fd-vis">
        <Section title="Raceway cross-section" aside={<span className="text-faint text-[12px]">to scale</span>}>
          {b ? <Raceway r={r} ui={ui} setUi={setUi} /> : <StateMsg title="No conductor selected">The drawing appears once a size passes every check.</StateMsg>}
        </Section>
        <Section title="Voltage drop along the run" aside="hover or tap for values">
          {b ? <DropChart r={r} ui={ui} /> : <StateMsg title="No conductor selected">The voltage-drop profile appears once a size passes every check.</StateMsg>}
        </Section>
      </div>

      <Section title="Notes">
        <ul className="fd-notes">{[...r.notes, ...(lugs ? lugs.source.notes : [])].map((n, k) => <li key={k}>{n}</li>)}</ul>
      </Section>
    </>
  );
}

/* ---------------------------------------------------------------- raceway cross-section */
const PHASE_COLOR = ["var(--ph-a)", "var(--ph-b)", "var(--ph-c)"];

/* Hex-lattice packing of n circles of diameter d, lowest positions first, inside a circle of radius R. */
function pack(n, d, R) {
  const pts = [];
  const lim = R - d / 2 + 1e-6;
  for (let row = -Math.ceil(R / d) - 1; row <= Math.ceil(R / d) + 1; row++) {
    for (let col = -Math.ceil(R / d) - 1; col <= Math.ceil(R / d) + 1; col++) {
      const x = col * d + (Math.abs(row) % 2 ? d / 2 : 0), y = row * d * 0.8660254;
      if (Math.hypot(x, y) <= lim) pts.push([x, y]);
    }
  }
  pts.sort((a, b) => b[1] - a[1] || Math.abs(a[0]) - Math.abs(b[0]) || a[0] - b[0]);
  const out = pts.slice(0, n);
  while (out.length < n) out.push([0, 0]); // overflow, flagged by the fill figure
  return { out, fits: pts.length >= n };
}

function Raceway({ r, ui, setUi }) {
  const b = r.recommended, i = r.input;
  const od = cableOdMm(b.size), core = diameterMm(b.size);
  const free = i.installation === "free_air";
  const count = free ? i.phases : Math.max(i.phases, Math.round(i.current_carrying_per_raceway));
  const areaCond = (count * Math.PI * od * od) / 4;
  let id, label;
  if (free) {
    id = null;
  } else if (ui.conduit_size !== "auto") {
    const t = TRADE.find(([n]) => n === ui.conduit_size);
    id = t[1] * 25.4; label = t[0];
  } else {
    const t = TRADE.find(([, d]) => (areaCond / (Math.PI * (d * 25.4) ** 2 / 4)) * 100 <= FILL_LIMIT) || TRADE[TRADE.length - 1];
    id = t[1] * 25.4; label = t[0];
  }
  const R = id ? id / 2 : (od * (1 + 2 / Math.sqrt(3))) / 2 + 2;
  const { out, fits } = pack(count, od, id ? R : 1e9);
  const pts = free ? trefoil(od, i.phases) : out;
  const fill = id ? (areaCond / (Math.PI * R * R)) * 100 : null;
  const pad = 14;
  const jacket = id ? Math.max(3, id * 0.07) : 0;
  const ext = R + jacket;
  const vb = `${-ext - pad} ${-ext - pad} ${2 * ext + 2 * pad} ${2 * ext + 2 * pad}`;
  return (
    <div className="fd-draw">
      <svg viewBox={vb} className="fd-svg" role="img" aria-label="Raceway cross-section drawn to scale">
        {id && <>
          <circle r={R + jacket} className="fd-conduit" />
          <circle r={R} className="fd-bore" />
        </>}
        {pts.map(([x, y], k) => {
          const ph = k < i.phases;
          return (
            <g key={k} transform={`translate(${x} ${y})`}>
              <circle r={od / 2} className="fd-ins" style={{ stroke: ph ? PHASE_COLOR[k % 3] : "var(--faint)", fill: ph ? `color-mix(in srgb, ${PHASE_COLOR[k % 3]} 20%, var(--bg))` : "var(--panel-2)" }} />
              <circle r={core / 2} className={i.material === "Cu" ? "fd-cu" : "fd-al"} />
            </g>
          );
        })}
      </svg>
      <div className="fd-caption">
        <div>{id ? `${label} in conduit, ID ${fmt(id, 1)} mm` : "Free air, cables touching"} · cable OD {fmt(od, 1)} mm · {i.material} core {fmt(core, 1)} mm</div>
        {id ? <>Fill <b className={fill > FILL_LIMIT || !fits ? "fd-bad" : ""}>{fmt(fill, 1)} %</b> of the bore with {count} conductors (limit {FILL_LIMIT} %).
          {ui.conduit_size === "auto" ? " Conduit size picked automatically." : ""}
          {r.recommended.sets > 1 && ` One of ${r.recommended.sets} identical raceways.`}</> : "Single trefoil group in free air."}
        {id && <div className="fd-conduit-pick">
          <label className="field-label" htmlFor="fd-conduit_size">Conduit size</label>
          <select id="fd-conduit_size" className="num-input" value={ui.conduit_size} onChange={(e) => setUi((s) => ({ ...s, conduit_size: e.target.value }))}>
            <option value="auto">Auto</option>
            {TRADE.map(([n]) => <option key={n} value={n}>{n} in</option>)}
          </select>
        </div>}
      </div>
    </div>
  );
}

function trefoil(od, n) {
  if (n === 1) return [[0, 0]];
  if (n === 2) return [[-od / 2, 0], [od / 2, 0]];
  const h = (od * Math.sqrt(3)) / 2;
  return [[-od / 2, h / 3], [od / 2, h / 3], [0, -(2 * h) / 3]];
}

/* ---------------------------------------------------------------- voltage drop along the run */
function DropChart({ r, ui }) {
  const b = r.recommended, i = r.input;
  const L = ui.unit === "ft" ? i.length_m / FT : i.length_m;
  const lim = i.max_vd_pct;
  const maxL = b.vd_pct > 0 ? (L * lim) / b.vd_pct : Infinity;
  const xMax = Math.min(Math.max(L, Math.min(maxL, 3 * L)) * 1.08, 4 * L);
  const yMax = Math.max(lim, b.vd_pct * (xMax / L)) * 1.1;
  const alts = r.alternatives.slice(0, 3);
  const at = (o, x) => (o.vd_pct * x) / L;
  const seg = (o) => [{ x: 0, y: 0 }, { x: xMax, y: at(o, xMax) }];
  const name = (o) => `${o.sets} × ${o.size_label}`;
  const xs = useMemo(() => { const n = 48, a = Array.from({ length: n + 1 }, (_, k) => (k * xMax) / n); a.push(L); return [...new Set(a)].sort((p, q) => p - q); }, [xMax, L]);
  const series = [{ o: b, color: "var(--accent)" }, ...alts.map((o, k) => ({ o, color: SERIES_VAR[k] }))];
  return (
    <div>
      <Chart height={240} ariaLabel="Voltage drop versus distance from the source" reportTitle="Voltage drop along the run"
        x={{ domain: [0, xMax], label: "Distance from source", unit: ui.unit }} y={{ domain: [0, yMax], label: "Voltage drop", unit: "%" }}
        legend={series.length > 1 ? series.map((s) => ({ name: name(s.o), color: s.color })) : null}
        hover={{
          xs,
          render: (k) => ({ title: `${fmt(xs[k], 0)} ${ui.unit} from source`, rows: series.map((s) => ({ label: name(s.o), value: `${fmt(at(s.o, xs[k]), 2)} %`, color: s.color })) }),
          points: (k) => series.map((s) => ({ y: at(s.o, xs[k]), color: s.color })),
        }}>
        <RefLine y={lim} label={`limit ${lim} %`} tone="crit" />
        <RefLine x={L} label={`run ${fmt(L, 0)} ${ui.unit}`} tone="muted" />
        {alts.map((o, k) => <Line key={k} data={seg(o)} color={SERIES_VAR[k]} width={1.5} opacity={0.85} />)}
        <Line data={seg(b)} color="var(--accent)" width={2.25} />
        <Dot x={L} y={b.vd_pct} label={`${fmt(b.vd_pct, 2)} %`} />
      </Chart>
      <div className="ck-caption">
        {name(b)} reaches the {lim} % limit at {Number.isFinite(maxL) ? <b>{fmt(maxL, 0)} {ui.unit}</b> : "—"} (run is {fmt(L, 0)} {ui.unit}).
        {alts.length > 0 && " Thinner lines: next-larger passing options."}
      </div>
    </div>
  );
}

const CSS = `
  .fd-grid { display: grid; grid-template-columns: 340px minmax(0, 1fr); gap: 12px; padding: 12px 16px; align-items: start; }
  .fd-form, .fd-results { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .fd-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; }
  .fd .grid-table th.c, .fd .grid-table td.c { text-align: center; }
  .fd-wrap { white-space: normal !important; min-width: 120px; font-family: var(--font-ui) !important; }
  .fd-note { font-size: 11px; color: var(--faint); margin-top: 2px; }
  .fd-clause { color: var(--muted); font-size: 12px !important; }
  .fd-unit { font-style: normal; color: var(--faint); font-size: 11px; }
  .fd-opt-notes { margin-top: 10px; }
  .fd-notes { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--muted); list-style: disc; padding-left: 18px; }
  .fd-alt { font-size: 12px; color: var(--muted); margin-top: 8px; }
  .fd-cand tr.fd-best td { background: color-mix(in srgb, var(--ok) 9%, transparent); }
  .fd-cand tr.fd-rej td { color: var(--muted); }
  .fd-cand td.fd-bad { color: var(--crit); }
  .fd-cand td.fd-gov { background: color-mix(in srgb, var(--high) 22%, transparent); font-weight: 600; }
  .fd-bad { color: var(--crit); }
  .fd-vis { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
  .fd-draw { display: flex; flex-direction: column; gap: 8px; }
  .fd-svg { width: 100%; height: auto; max-height: 420px; display: block; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; }
  .fd-svg text { font-family: var(--font-data); font-size: 10px; fill: var(--muted); }
  .fd-conduit { fill: color-mix(in srgb, var(--wire) 35%, var(--bg)); stroke: var(--wire); stroke-width: 0.6; }
  .fd-bore { fill: var(--bg); stroke: var(--wire); stroke-width: 0.4; }
  .fd-ins { stroke-width: 1; }
  .fd-cu { fill: #b87333; } .fd-al { fill: #aeb8c2; }
  .fd-caption { font-size: 12.5px; color: var(--muted); }
  .fd-caption b { color: var(--fg); font-family: var(--font-data); font-weight: 500; }
  .fd-caption b.fd-bad { color: var(--crit); }
  .fd-conduit-pick { display: flex; align-items: center; gap: 8px; margin-top: 8px; max-width: 220px; }
  .fd-conduit-pick .field-label { white-space: nowrap; }
  @media (max-width: 899px) { .fd-grid { grid-template-columns: minmax(0, 1fr); } }
  @media (max-width: 520px) { .fd-grid { padding: 10px 16px; } .fd-fields { gap: 8px; } }
`;
