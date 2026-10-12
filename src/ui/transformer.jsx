/* Transformer workspace: preliminary core-type design (pecalc transformer port), live as inputs change. */
const { useState, useMemo } = React;
import { Btn, Field, NumField, Pill, Section, Tile, cx, fmt } from "./common.jsx";
import { design, design_for_impedance, transformerInput } from "../engine/pecalc/transformer.js";

/* Starting state: the 1500 kVA, 13.8 kV delta / 480Y V liquid-filled example, 5.75 % Z. */
const EXAMPLE = { kva: 1500, hv_v: 13800, lv_v: 480, target_z_pct: 5.75, source_mva: 500, j_lv_a_mm2: 2.6, j_hv_a_mm2: 2.6 };

function solve(inp, tune) {
  try {
    const i = transformerInput(inp);
    return { result: tune && i.target_z_pct ? design_for_impedance(i) : design(i) };
  } catch (e) {
    return { error: e.message };
  }
}

export function TransformerWorkspace() {
  const [inp, setInp] = useState(() => transformerInput(EXAMPLE));
  const [tune, setTune] = useState(true);
  const { result: r, error } = useMemo(() => solve(inp, tune), [inp, tune]);
  const set = (k, optional) => (v) => setInp((s) => (v === undefined && !optional ? s : { ...s, [k]: v === undefined ? null : v }));

  const num = (k, label, unit, o = {}) => (
    <Field label={label} unit={unit} hint={o.hint}>
      <NumField id={`xf-${k}`} value={inp[k] === null ? undefined : inp[k]} placeholder={o.ph} disabled={o.disabled} onCommit={set(k, o.optional)} />
    </Field>
  );
  const pick = (k, label, opts) => (
    <Field label={label}>
      <select id={`xf-${k}`} className="num-input" value={inp[k]} onChange={(e) => setInp((s) => ({ ...s, [k]: e.target.value }))}>
        {opts.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
    </Field>
  );

  const tuned = tune && !!inp.target_z_pct;
  return (
    <div className="ws">
      <header className="topbar">
        <div className="ws-title">Transformer</div>
        <span className="text-muted text-[12.5px]">Preliminary core-type design · 3-phase</span>
        <div className="flex items-center gap-2 ml-auto">
          {r && <Pill tone={r.passed ? "ok" : "crit"}>{r.passed ? "All checks pass" : `${r.checks.filter((c) => !c.passed).length} check(s) fail`}</Pill>}
          <Btn onClick={() => { setInp(transformerInput(EXAMPLE)); setTune(true); }} title="Restore the 1500 kVA example inputs">Reset to example</Btn>
        </div>
      </header>

      <div className="main">
        <div className="xf-grid">
          <div className="xf-form">
            <Section title="Rating">
              <div className="xf-fields">
                {num("kva", "Rated power", "kVA")}
                {num("frequency_hz", "Frequency", "Hz")}
                {pick("kind", "Cooling type", [["liquid", "Liquid-filled"], ["dry", "Dry-type"]])}
                {num("power_factor", "Load power factor", "pu")}
                {num("source_mva", "Source fault level", "MVA", { optional: true, ph: "infinite bus", hint: "at HV terminals" })}
                {num("fault_duration_s", "Through-fault duration", "s")}
              </div>
            </Section>
            <Section title="Voltages">
              <div className="xf-fields">
                {num("hv_v", "HV line-line", "V")}
                {pick("hv_connection", "HV connection", [["delta", "Delta"], ["wye", "Wye"]])}
                {num("lv_v", "LV line-line", "V")}
                {pick("lv_connection", "LV connection", [["wye", "Wye"], ["delta", "Delta"]])}
              </div>
            </Section>
            <Section title="Design targets">
              <div className="xf-fields">
                {num("target_z_pct", "Target impedance", "%Z", { optional: true, ph: "none" })}
                {num("z_tolerance_pct", "%Z tolerance", "% of value")}
                {num("window_ratio", "Window height / width", "", { disabled: tuned, hint: tuned ? "set by tuning" : undefined })}
                {num("b_max_t", "Peak flux density", "T")}
                {num("k_et", "Volts/turn constant K", "Et = K√kVA")}
                {num("j_lv_a_mm2", "LV current density", "A/mm²")}
                {num("j_hv_a_mm2", "HV current density", "A/mm²")}
                {num("doe_min_efficiency_pct", "DOE minimum efficiency", "%", { optional: true, ph: "not checked", hint: "from 10 CFR 431.196" })}
              </div>
              <label className="live-toggle mt-3" title="Bisect the window height/width ratio until %Z meets the target">
                <input id="xf-tune" type="checkbox" checked={tune} onChange={(e) => setTune(e.target.checked)} />
                <span>Tune window ratio to target %Z</span>
              </label>
            </Section>
            <Section title="Materials">
              <div className="xf-fields">
                {pick("conductor", "Winding conductor", [["Cu", "Copper"], ["Al", "Aluminium"]])}
                {num("conductor_proof_mpa", "Conductor proof stress", "MPa")}
                {num("core_fill", "Core fill factor", "")}
                {num("building_factor", "Core loss building factor", "")}
                {num("lv_fill", "LV conductor fill", "")}
                {num("hv_fill", "HV conductor fill", "")}
                {num("stray_loss_frac", "Stray loss", "× I²R")}
                {num("reference_temp_c", "Load-loss reference", "°C", { optional: true, ph: inp.kind === "liquid" ? "85" : "115" })}
              </div>
            </Section>
            <Section title="Clearances" aside={<span className="text-faint text-[12px]">blank = default</span>}>
              <div className="xf-fields">
                {num("core_to_lv_mm", "Core to LV", "mm")}
                {num("lv_hv_duct_mm", "LV-HV duct", "mm", { optional: true, ph: "8 + 0.9 kV" })}
                {num("end_clearance_mm", "Winding to yoke", "mm", { optional: true, ph: "15 + 1.2 kV" })}
                {num("phase_gap_mm", "Phase gap", "mm", { optional: true, ph: "10 + 0.8 kV" })}
                {num("kw", "Window space factor Kw", "", { optional: true, ph: "10 / (30 + kV)" })}
              </div>
            </Section>
          </div>

          <div className="xf-results">
            {error && <div className="notice notice-crit"><b>Cannot design.</b> {error}</div>}
            {r && <Results r={r} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function Results({ r }) {
  const i = r.input, d = r.design, z = r.impedance, p = r.performance, sc = r.short_circuit, l = r.losses;
  const zCheck = r.checks.find((c) => c.name.startsWith("Impedance"));
  const doeCheck = r.checks.find((c) => c.name.startsWith("Efficiency"));
  const lossTotal = (l.no_load_w + l.load_loss_w) / 1000;
  const std = (v) => (Number.isFinite(v) ? fmt(v, Math.abs(v) < 10 ? 2 : 1) : "∞");
  return (
    <>
      <div className="tiles">
        <Tile label="Rating" value={fmt(i.kva, i.kva % 1 ? 1 : 0)} unit="kVA" sub={`${fmt(i.hv_v / 1000, 2)} kV ${i.hv_connection === "delta" ? "Δ" : "Y"} / ${fmt(i.lv_v, 0)} V ${i.lv_connection === "delta" ? "Δ" : "Y"}`} />
        <Tile label="Impedance" value={fmt(z.z_pct, 2)} unit="%Z" tone={zCheck ? (zCheck.passed ? "ok" : "crit") : undefined}
          sub={`R ${fmt(z.r_pct, 2)} % · X ${fmt(z.x_pct, 2)} % · X/R ${fmt(z.x_over_r, 1)}`} />
        <Tile label="Efficiency, full load" value={fmt(p.efficiency_pct["100%"], 2)} unit="%" tone={doeCheck ? (doeCheck.passed ? "ok" : "crit") : undefined}
          sub={`DOE point (${fmt(p.doe_point.load * 100, 0)} %): ${fmt(p.doe_point.efficiency_pct, 3)} %`} />
        <Tile label="Losses" value={fmt(lossTotal, 2)} unit="kW" sub={`no-load ${fmt(l.no_load_w / 1000, 2)} · load ${fmt(l.load_loss_w / 1000, 2)} kW`} />
        <Tile label="LV fault current" value={fmt(sc.lv_fault_ka_rms, 1)} unit="kA" tone={!r.passed ? "warn" : undefined} sub={`peak ${fmt(sc.lv_fault_peak_ka, 1)} kA · ${i.source_mva ? `source ${fmt(i.source_mva, 0)} MVA` : "infinite source"}`} />
      </div>

      <Section title="Checks" aside={<Pill tone={r.passed ? "ok" : "crit"}>{r.passed ? "Pass" : "Fail"}</Pill>}>
        <div className="table-wrap">
          <table className="grid-table">
            <thead><tr><th>Check</th><th className="r">Value</th><th className="r">Limit</th><th>Result</th><th>Clause</th></tr></thead>
            <tbody>
              {r.checks.map((c) => (
                <tr key={c.name} title={c.note}>
                  <td className="xf-wrap">{c.name}<div className="xf-note">{c.note}</div></td>
                  <td className="r">{std(c.value)} <em className="xf-unit">{c.unit}</em></td>
                  <td className="r">{std(c.limit)} <em className="xf-unit">{c.unit}</em></td>
                  <td><Pill tone={c.passed ? "ok" : "crit"}>{c.passed ? "Pass" : "Fail"}</Pill></td>
                  <td className="xf-wrap xf-clause">{c.clause}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Core and coil" aside={<span className="text-faint text-[12px]">drawn to scale, dimensions in mm</span>}>
        <CoreCoil d={d} i={i} />
      </Section>

      <div className="xf-kv-row">
        <Section title="Core and windings">
          <dl className="kv">
            <dt>Volts per turn</dt><dd>{fmt(d.volts_per_turn, 3)} V</dd>
            <dt>Turns LV / HV</dt><dd>{d.turns_lv} / {d.turns_hv}</dd>
            <dt>Peak flux density</dt><dd>{fmt(d.b_max_t, 3)} T</dd>
            <dt>Core net area</dt><dd>{fmt(d.core_area_net_cm2, 1)} cm²</dd>
            <dt>Core diameter</dt><dd>{fmt(d.core_diameter_mm, 1)} mm</dd>
            <dt>Window h × w</dt><dd>{fmt(d.window_h_mm, 0)} × {fmt(d.window_w_mm, 0)} mm</dd>
            <dt>Winding height</dt><dd>{fmt(d.winding_height_mm, 0)} mm</dd>
            <dt>LV / HV conductor</dt><dd>{fmt(d.lv_conductor_mm2, 1)} / {fmt(d.hv_conductor_mm2, 2)} mm²</dd>
            <dt>LV / HV radial build</dt><dd>{fmt(d.lv_radial_mm, 1)} / {fmt(d.hv_radial_mm, 1)} mm</dd>
            <dt>LV-HV duct</dt><dd>{fmt(d.duct_mm, 1)} mm</dd>
            <dt>Core mass</dt><dd>{fmt(d.core_mass_kg, 0)} kg</dd>
            <dt>Window factor Kw</dt><dd>{fmt(d.kw, 3)}</dd>
          </dl>
        </Section>
        <Section title="Losses and performance">
          <dl className="kv">
            <dt>No-load loss</dt><dd>{fmt(l.no_load_w, 0)} W</dd>
            <dt>Load loss @ {fmt(l.reference_temp_c, 0)} °C</dt><dd>{fmt(l.load_loss_w, 0)} W</dd>
            <dt>R LV / HV (per phase)</dt><dd>{fmt(l.r_lv_mohm, 3)} mΩ / {fmt(l.r_hv_ohm, 3)} Ω</dd>
            {Object.entries(p.efficiency_pct).map(([k, v]) => <React.Fragment key={k}><dt>Efficiency @ {k} load</dt><dd>{fmt(v, 3)} %</dd></React.Fragment>)}
            <dt>Max-efficiency load</dt><dd>{fmt(p.max_efficiency_load_pct, 1)} %</dd>
            <dt>Regulation @ pf {fmt(i.power_factor, 2)}</dt><dd>{fmt(p.regulation_pct, 2)} %</dd>
            <dt>Rogowski factor Kr</dt><dd>{fmt(z.rogowski_kr, 3)}</dd>
          </dl>
        </Section>
        <Section title="Short circuit">
          <dl className="kv">
            <dt>LV fault, rms</dt><dd>{fmt(sc.lv_fault_ka_rms, 2)} kA</dd>
            <dt>LV fault, peak</dt><dd>{fmt(sc.lv_fault_peak_ka, 2)} kA</dd>
            <dt>Winding temp after {i.fault_duration_s} s</dt><dd>{Number.isFinite(sc.winding_temp_after_fault_c) ? `${fmt(sc.winding_temp_after_fault_c, 0)} °C` : "∞"}</dd>
            <dt>HV mean hoop stress</dt><dd>{fmt(sc.hv_hoop_stress_mpa, 1)} MPa</dd>
          </dl>
        </Section>
      </div>

      <Section title="Notes">
        <ul className="xf-notes">{r.notes.map((n, k) => <li key={k}>{n}</li>)}</ul>
      </Section>
    </>
  );
}

/* Core-and-coil drawing. Everything is in millimetres in the viewBox, so the scale is true:
   limbs are the core circle diameter wide, windows the design window, windings their radial build and height. */
function CoreCoil({ d, i }) {
  const dc = d.core_diameter_mm, ww = d.window_w_mm, hw = d.window_h_mm, h = d.winding_height_mm;
  const c1 = i.core_to_lv_mm, blv = d.lv_radial_mm, bhv = d.hv_radial_mm, duct = d.duct_mm;
  const yoke = dc;                                  // yoke depth drawn equal to the limb (circumscribed) width
  const W0 = 3 * dc + 2 * ww, H0 = hw + 2 * yoke;
  const ext = c1 + blv + duct + bhv;                // winding projects past the outer limbs
  const fs = Math.max(W0, H0) * 0.03;               // text size in mm
  const left = ext + 3 * fs, right = ext + 7.5 * fs, top = 5 * fs, bottom = 8.5 * fs;
  const vw = W0 + left + right, vh = H0 + top + bottom;
  const ox = left, oy = top;
  const cx = [0, 1, 2].map((k) => dc / 2 + k * (dc + ww));
  const wy = yoke + (hw - h) / 2;                   // winding top (end clearance each end)
  const sw = fs * 0.07;
  const windows = [0, 1].map((k) => dc + k * (dc + ww));
  const core = `M0 0H${W0}V${H0}H0Z` + windows.map((x) => `M${x} ${yoke}h${ww}v${hw}h${-ww}Z`).join("");
  const wind = (x, w, cls, key) => <rect key={key} className={cls} x={x} y={wy} width={w} height={h} strokeWidth={sw} />;
  const rects = cx.flatMap((c, k) => {
    const e = dc / 2 + c1;                          // limb centre to LV inner face
    return [
      wind(c - e - blv, blv, "xf-lv", `l${k}a`), wind(c + e, blv, "xf-lv", `l${k}b`),
      wind(c - e - blv - duct - bhv, bhv, "xf-hv", `h${k}a`), wind(c + e + blv + duct, bhv, "xf-hv", `h${k}b`),
    ];
  });
  const T = { fontSize: fs };
  const rx = W0 + ext + 1.5 * fs;                   // vertical dimension lines on the right
  const by = H0 + 2 * fs;                           // horizontal dimension lines below
  const dimV = (x, y0, y1, label) => (
    <g className="xf-dim">
      <path d={`M${x} ${y0}V${y1}M${x - fs * 0.4} ${y0}h${fs * 0.8}M${x - fs * 0.4} ${y1}h${fs * 0.8}`} strokeWidth={sw} />
      <text transform={`translate(${x + fs * 1.15} ${(y0 + y1) / 2}) rotate(-90)`} textAnchor="middle" style={T}>{label}</text>
    </g>
  );
  const dimH = (x0, x1, y, label) => (
    <g className="xf-dim">
      <path d={`M${x0} ${y}H${x1}M${x0} ${y - fs * 0.4}v${fs * 0.8}M${x1} ${y - fs * 0.4}v${fs * 0.8}`} strokeWidth={sw} />
      <text x={(x0 + x1) / 2} y={y + fs * 1.3} textAnchor="middle" style={T}>{label}</text>
    </g>
  );
  const lead = (x0, y0, x1, y1, tx, ty, label, anchor) => (
    <g className="xf-lead">
      <path d={`M${x0} ${y0}L${x1} ${y1}`} strokeWidth={sw} /><circle cx={x0} cy={y0} r={fs * 0.22} />
      <text x={tx} y={ty} textAnchor={anchor} style={T}>{label}</text>
    </g>
  );
  const hvx0 = cx[0] - dc / 2 - c1 - blv - duct - bhv / 2;       // outer limb, HV left
  const lvx2 = cx[2] + dc / 2 + c1 + blv / 2;                    // outer limb, LV right
  return (
    <div className="xf-draw">
      <svg className="xf-svg" viewBox={`0 0 ${vw} ${vh}`} role="img"
        aria-label={`Core and coil, to scale: core diameter ${fmt(dc, 0)} mm, window ${fmt(hw, 0)} by ${fmt(ww, 0)} mm`}>
        <g transform={`translate(${ox} ${oy})`}>
          <path className="xf-core" d={core} fillRule="evenodd" strokeWidth={sw} />
          {cx.map((c, k) => <path key={k} className="xf-axis" d={`M${c} ${yoke * 0.35}V${H0 - yoke * 0.35}`} strokeWidth={sw} />)}
          {rects}
          {lead(hvx0, wy, hvx0 - fs * 1.2, -2.2 * fs, hvx0 - fs * 1.2, -2.8 * fs, "HV winding", "start")}
          {lead(lvx2, wy, lvx2 + fs * 1.2, -2.2 * fs, lvx2 + fs * 1.2, -2.8 * fs, "LV winding", "end")}
          {lead(cx[1], yoke * 0.5, cx[1], -0.6 * fs, cx[1], -1.2 * fs, `Core Ø${fmt(dc, 0)}`, "middle")}
          {dimV(rx, yoke, yoke + hw, `window ${fmt(hw, 0)}`)}
          {dimV(rx + 3.6 * fs, wy, wy + h, `windings ${fmt(h, 0)}`)}
          {dimH(0, dc, by, `Ø ${fmt(dc, 0)}`)}
          {dimH(dc, dc + ww, by, `window ${fmt(ww, 0)}`)}
          {dimH(cx[1] - dc / 2 - c1 - blv - duct - bhv, cx[1] - dc / 2 - c1, by + 3 * fs, `LV+HV ${fmt(c1 + blv + duct + bhv, 0)}`)}
        </g>
      </svg>
      <div className="xf-legend">
        <span><i className="xf-sw-core" />Core (limb width = circumscribed Ø)</span>
        <span><i className="xf-sw-lv" />LV {fmt(blv, 1)} mm</span>
        <span><i className="xf-sw-hv" />HV {fmt(bhv, 1)} mm</span>
        <span className="text-faint">duct {fmt(duct, 1)} · core-LV {fmt(c1, 1)} mm</span>
      </div>
    </div>
  );
}
