/* DOE 10 CFR 431.196 minimum-efficiency panel for the Transformer workspace: status, required vs designed
   efficiency per compliance window, and efficiency vs load with the DOE test point. Reads result.doe from the
   pecalc transformer port (doe_efficiency_check plus the losses at the DOE reference temperature). */
import { Section, Pill, StateMsg, StatusBadge, Clause, fmt } from "./common.jsx";
import { Chart, Line, Bars, RefLine, Dot } from "./charts/index.js";

const CSS = `
.doe-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
.doe-cap { font-size: 12px; color: var(--muted); margin: 0 0 4px; }
.doe-meta { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 12.5px; color: var(--muted); margin-bottom: 10px; }
.doe-meta b { color: var(--fg); font-weight: 600; font-family: var(--font-data); }
.doe-foot { font-size: 11.5px; color: var(--faint); margin-top: 8px; line-height: 1.45; }
`;

export const DOE_WINDOWS = [
  ["", "Auto (today)"],
  ["2015-06-01", "Before 2016"],
  ["2016-01-01", "2016 to 2029-04-22"],
  ["2029-04-23", "From 2029-04-23"],
];

const STATUS = {
  pass: ["ok", "Meets DOE minimum"], fail: ["crit", "Below DOE minimum"], not_in_table: ["warn", "Rating not in table"],
  needs_input: ["warn", "Input needed"], not_covered: ["muted", "Not covered by 431.196"],
};
const winLabel = (w) => (w.to ? `${w.from.slice(0, 4)}–${w.to.slice(0, 4)}` : `${w.from.slice(0, 4)}+`);
const pct = (v, n = 3) => (Number.isFinite(v) ? fmt(v, n) : "—");

/* Efficiency vs per-unit load on the DOE basis: eta(k) = k S / (k S + P0 + k^2 Pk), unity power factor. */
export function doeCurve(kva, losses, kMax = 1.25, n = 49) {
  const s = kva * 1000, out = [];
  for (let i = 0; i < n; i++) {
    const k = 0.05 + (kMax - 0.05) * i / (n - 1);
    out.push({ x: k * 100, y: (k * s) / (k * s + losses.no_load_w + k * k * losses.load_loss_w) * 100 });
  }
  return out;
}

export function DoePanel({ r }) {
  const d = r.doe;
  if (!d || !d.category) return null;
  const [tone, label] = STATUS[d.status] || ["muted", d.status];
  const e = d.efficiency_pct, req = d.required_pct;
  const winReq = d.by_window.map((w) => w.required_pct);
  const vals = [e, req, ...winReq].filter(Number.isFinite);
  const yLo = Math.floor((Math.min(...vals) - 0.15) * 10) / 10, yHi = Math.ceil((Math.max(...vals) + 0.08) * 10) / 10;
  // y range from 15 % load up (efficiency falls steeply towards no load); points below it are dropped.
  const full = doeCurve(d.kva, d.losses);
  const cVals = full.filter((p) => p.x >= 15).map((p) => p.y).concat(Number.isFinite(req) ? [req] : []);
  const cLo = Math.floor((Math.min(...cVals) - 0.1) * 10) / 10;
  const cHi = Math.ceil((Math.max(...cVals) + 0.05) * 10) / 10;
  const curve = full.filter((p) => p.y >= cLo);
  const tl = d.test_load_pu * 100;
  const curWin = d.window?.id;
  return (
    <Section title="DOE 10 CFR 431.196 efficiency" aside={<Pill tone={tone}>{label}</Pill>}>
      <style>{CSS}</style>
      <div className="doe-meta">
        <span>Class <b>{d.category_label}</b>{d.bil_band ? <> · BIL <b>{d.bil_band}</b></> : null}{d.submersible ? <> · <b>submersible</b></> : null}</span>
        <span>Manufacture date <b>{d.date}</b>{d.window ? <> → <b>{d.window.paragraph.replace("10 CFR ", "")}</b></> : null}</span>
        <span>Test load <b>{fmt(tl, 0)} %</b> · unity pf · load loss at <b>{d.reference_temp_c.load} °C</b></span>
        <span>Efficiency <b>{pct(e)} %</b> vs minimum <b>{pct(req, 2)}{Number.isFinite(req) ? " %" : ""}</b>
          {Number.isFinite(d.margin_pct) ? <> · margin <b>{d.margin_pct >= 0 ? "+" : ""}{fmt(d.margin_pct, 3)} pts</b></> : null}</span>
      </div>
      {d.status !== "pass" && d.status !== "fail" && (
        <StateMsg kind={d.status === "not_covered" ? "empty" : "error"} title={label}>
          {d.message}
          {d.status === "not_in_table" && d.nearest_rows.length > 0 && <> The rule gives no value to extrapolate from; nearest table rows are shown above for reference.</>}
        </StateMsg>
      )}
      <div className="doe-grid">
        <div>
          <p className="doe-cap">Minimum by compliance window ({d.phases}-phase {fmt(d.kva, d.kva % 1 ? 1 : 0)} kVA{d.interpolated ? ", interpolated" : ""}) vs designed efficiency</p>
          {winReq.some(Number.isFinite) ? (
            <Chart height={210} ariaLabel={`DOE minimum efficiency by window: ${d.by_window.map((w) => `${winLabel(w)} ${pct(w.required_pct, 2)} %`).join(", ")}; designed ${pct(e)} %`}
              reportTitle="DOE minimum efficiency by compliance window vs designed"
              x={{ type: "band", n: d.by_window.length, labels: d.by_window.map(winLabel), label: "Window (manufacture date)" }}
              y={{ domain: [yLo, yHi], label: "Efficiency", unit: "%", nice: false, format: (v) => fmt(v, 2) }}
              legend={[{ name: "DOE minimum", color: "var(--muted)", kind: "bar" }, { name: "Designed", color: "var(--accent)", kind: "ref" }]}
              hover={{ render: (i) => ({ title: `${d.by_window[i].paragraph.replace("10 CFR ", "")} ${d.by_window[i].table}`, rows: [
                { label: "minimum", value: `${pct(d.by_window[i].required_pct, 3)} %`, color: "var(--muted)" },
                { label: "designed", value: `${pct(e)} %`, color: "var(--accent)" }] }) }}>
              <Bars values={winReq} base={yLo} labels={() => true} format={(v) => fmt(v, 2)}
                color={(v, i) => (d.by_window[i].id === curWin ? (d.status === "fail" ? "var(--st-fail)" : "var(--st-pass)") : "var(--muted)")} />
              {Number.isFinite(e) && <RefLine y={e} tone="accent" />}
            </Chart>
          ) : <StateMsg title="No table minimum">No window gives a minimum for this rating{d.bil_band === null && d.category === "mv_dry" ? " (enter the BIL)" : ""}.</StateMsg>}
        </div>
        <div>
          <p className="doe-cap">Efficiency vs load, DOE basis (unity pf, P0 {fmt(d.losses.no_load_w, 0)} W, Pk {fmt(d.losses.load_loss_w, 0)} W at {d.reference_temp_c.load} °C)</p>
          <Chart height={210} ariaLabel={`Efficiency versus load; DOE test point ${fmt(tl, 0)} % load ${pct(e)} %`} reportTitle="Efficiency vs load with the DOE test point"
            x={{ domain: [0, 125], label: "Load", unit: "% of nameplate", nice: false }}
            y={{ domain: [cLo, cHi], label: "Efficiency", unit: "%", nice: false, format: (v) => fmt(v, 2) }}
            hover={{ xs: curve.map((p) => p.x), render: (i) => ({ title: `${fmt(curve[i].x, 0)} % load`, rows: [{ label: "efficiency", value: `${pct(curve[i].y)} %`, color: "var(--accent)" }] }),
              points: (i) => [{ x: curve[i].x, y: curve[i].y, color: "var(--accent)" }] }}>
            <Line data={curve} color="var(--accent)" />
            {Number.isFinite(req) && <RefLine y={req} label={`DOE minimum ${pct(req, 2)} %`} tone={d.status === "fail" ? "crit" : "ok"} />}
            <RefLine x={tl} tone="muted" />
            {Number.isFinite(e) && <Dot x={tl} y={e} color={d.status === "fail" ? "var(--st-fail)" : "var(--accent)"} label={`DOE point ${fmt(tl, 0)} %: ${pct(e)} %`} />}
          </Chart>
        </div>
      </div>
      <div className="doe-foot">
        {d.citation && <><Clause>{d.citation}</Clause> · </>}
        Test conditions: 10 CFR 431 Subpart K App. A Tables 2.1 / 2.2. Data <StatusBadge status="pass">{d.data_status}</StatusBadge> eCFR snapshot {d.snapshot}.
        {d.rows.length === 2 && <> Interpolated linearly between {fmt(d.rows[0][0], 1)} kVA ({fmt(d.rows[0][1], 2)} %) and {fmt(d.rows[1][0], 1)} kVA ({fmt(d.rows[1][1], 2)} %), as 431.196 requires.</>}
        {d.status === "not_in_table" && d.nearest_rows.length > 0 && <> Nearest rows: {d.nearest_rows.map(([k, v]) => `${fmt(k, 1)} kVA ${fmt(v, 2)} %`).join(", ")}.</>}
        {" "}Efficiency here is the preliminary design's estimate; compliance is certified from measured losses.
      </div>
    </Section>
  );
}

/* Calculation-package rows and tables for the DOE check. */
export function doeReportParts(d) {
  if (!d || !d.category) return { results: [], tables: [], dataStatus: [] };
  const n = (v, k = 3) => (Number.isFinite(v) ? Number(v.toFixed(k)) : "n/a");
  return {
    results: [
      ["DOE class", d.category_label], ["DOE status", d.status], ["DOE manufacture date", d.date],
      ["DOE window", d.window ? `${d.window.paragraph}, ${d.window.table}` : "none"],
      ["DOE test load", `${n(d.test_load_pu * 100, 0)} % of nameplate, unity pf`],
      ["DOE efficiency at test load", `${n(d.efficiency_pct)} %`], ["DOE minimum", Number.isFinite(d.required_pct) ? `${n(d.required_pct)} %` : "n/a"],
      ["DOE basis", d.message],
    ].map(([label, value]) => ({ label, value })),
    tables: [{
      title: "DOE 10 CFR 431.196 minimum by compliance window",
      columns: ["Paragraph", "Table", "From", "Before", "Minimum %"],
      rows: d.by_window.map((w) => [w.paragraph, w.table, w.from, w.to || "", Number.isFinite(w.required_pct) ? n(w.required_pct) : "n/a"]),
    }],
    dataStatus: [{ table: "DOE 10 CFR 431.196 tables, 431.192 definitions, App. A Tables 2.1/2.2", status: d.data_status,
      source: `eCFR versioner API, snapshot ${d.snapshot} (https://www.ecfr.gov/api/versioner/v1/full/${d.snapshot}/title-10.xml?part=431&section=431.196)` }],
  };
}
