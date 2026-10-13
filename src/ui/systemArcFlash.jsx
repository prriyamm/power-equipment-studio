// Arc-flash study table and label preview for the System workspace (IEEE 1584-2018, data UNVERIFIED).
const { useState, useMemo } = React;
import { Pill, Section, NumField, cx, fmt } from "./common.jsx";
import { arcFlashStudy, DATA_STATUS } from "../engine/arcflash.js";

const CSS = `
.af-ppe { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; font-weight:600; white-space:nowrap; }
.af-l0 { color: var(--ok); background: color-mix(in srgb, var(--ok) 14%, transparent); }
.af-l1 { color: #9ad45a; background: color-mix(in srgb, #9ad45a 14%, transparent); }
.af-l2 { color: var(--accent); background: color-mix(in srgb, var(--accent) 16%, transparent); }
.af-l3 { color: var(--high); background: color-mix(in srgb, var(--high) 16%, transparent); }
.af-l4 { color: #ff6f4a; background: color-mix(in srgb, #ff6f4a 18%, transparent); }
.af-l5 { color: var(--crit); background: color-mix(in srgb, var(--crit) 20%, transparent); }
.af-note { color: var(--high); font-size: 11px; }
.af-body { display:grid; grid-template-columns: minmax(0,1fr) 300px; gap:16px; align-items:start; padding:0 0 4px; }
@media (max-width: 1000px) { .af-body { grid-template-columns: minmax(0,1fr); } }
.af-label { border:2px solid #111; background:#fff; color:#111; border-radius:4px; overflow:hidden; font-family: var(--font-ui); max-width:300px; }
.af-label header { padding:6px 10px; text-align:center; font-weight:800; letter-spacing:.12em; font-size:20px; color:#fff; }
.af-label.is-warning header { background:#f28c1e; color:#111; }
.af-label.is-danger header { background:#d62828; }
.af-label .af-row { display:flex; justify-content:space-between; gap:8px; padding:4px 10px; border-top:1px solid #ccc; font-size:12px; }
.af-label .af-row b { font-family: var(--font-data); font-weight:600; }
.af-label .af-big { padding:8px 10px; text-align:center; font-size:12px; }
.af-label .af-big b { display:block; font-size:26px; font-family: var(--font-data); }
.af-label footer { padding:5px 10px; font-size:10px; background:#eee; color:#444; }
@media (max-width: 640px) { .af-label footer { font-size:11px; } }
`;

export function ArcFlashSection({ sys, analysis, updateEq }) {
  const [allowPlaceholder, setAllowPlaceholder] = useState(false);
  const rows = useMemo(() => (analysis?.ok ? arcFlashStudy(analysis, sys, { allow_placeholder_data: allowPlaceholder }) : []), [analysis, sys, allowPlaceholder]);
  const [sel, setSel] = useState(null);
  if (!rows.length) return null;
  const cur = rows.find((r) => r.id === sel) || rows[0];
  const bad = (r) => !!r.error;
  const refused = rows.some((r) => r.placeholder);
  return (
    <Section title="Arc flash · IEEE 1584-2018 incident energy"
      aside={<Pill tone="crit" title="Coefficient tables were entered from memory and some sets are approximations. Verify against a licensed copy of IEEE 1584-2018 before use.">Data {DATA_STATUS}</Pill>}>
      <style>{CSS}</style>
      <div className="notice notice-crit mb-3">Placeholder coefficients: most IEEE 1584-2018 coefficient sets here were entered from memory or approximated. Results show the method and workflow only. Do not use them for labels or PPE selection until every coefficient is checked against a licensed copy of the standard.
        {DATA_STATUS === "PLACEHOLDER" && (
          <div className="mt-2">
            {refused && <div className="mb-1"><b>Not calculated.</b> The study refuses PLACEHOLDER coefficients unless you allow them.</div>}
            <label className="live-toggle">
              <input id="af-placeholder" type="checkbox" checked={allowPlaceholder} onChange={(e) => setAllowPlaceholder(e.target.checked)} />
              <span>Allow PLACEHOLDER data for testing (results are not IEEE 1584-2018 values)</span>
            </label>
          </div>
        )}</div>
      <div className="af-body px-4 pb-3">
        <div>
          <div className="table-wrap"><table className="grid-table">
            <thead><tr><th>Equipment</th><th className="r">kV</th><th className="r">Ibf<em>kA</em></th><th className="r">Iarc<em>kA</em></th><th className="r">Iarc min<em>kA</em></th>
              <th className="r">Clearing<em>ms</em></th><th>Config</th><th className="r">Gap<em>mm</em></th><th className="r">Dist<em>mm</em></th><th className="r">E<em>cal/cm²</em></th><th className="r">AFB<em>mm</em></th><th>PPE level (informative)</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className={cx("clickable", r.id === cur.id && "is-selected")} onClick={() => setSel(r.id)}>
                <td><span className="font-mono">{r.id}</span> <span className="text-muted">{r.class_label}</span></td>
                <td className="r">{r.input.voc_kv}</td><td className="r">{fmt(r.input.ibf_ka, 2)}</td>
                <td className="r">{bad(r) ? "—" : fmt(r.iarc_ka, 2)}</td><td className="r">{bad(r) ? "—" : fmt(r.iarc_min_ka, 2)}</td>
                <td className="r" onClick={(ev) => ev.stopPropagation()}>
                  <NumField className="num-input" value={r.input.clearing_ms} onCommit={(v) => updateEq(r.id, { af_clearing_ms: v > 0 ? v : undefined })} />
                  {r.clearing_assumed && <div className="af-note" title={r.note}>assumed</div>}
                </td>
                <td>{r.input.config}</td><td className="r">{fmt(r.input.gap_mm, 0)}</td><td className="r">{fmt(r.input.working_mm, 0)}</td>
                <td className="r">{bad(r) ? "—" : fmt(r.e_cal_cm2, 2)}</td><td className="r">{bad(r) ? "—" : fmt(r.afb_mm, 0)}</td>
                <td>{bad(r) ? <span className="text-crit" title={r.error}>error</span> : <span className={cx("af-ppe", `af-l${r.ppe.level}`)}>{r.ppe.label}</span>}</td>
              </tr>))}</tbody>
          </table></div>
          <p className="text-faint text-[12px] leading-relaxed mt-2">
            Ibf = I″k ÷ c<sub>max</sub> (the IEC 60909 voltage factor is a margin; IEEE 1584 wants bolted fault at nominal voltage). Gap, distance, enclosure and configuration are the Table 8 class defaults; override with <span className="font-mono">af_gap_mm</span>, <span className="font-mono">af_working_mm</span>, <span className="font-mono">af_config</span>.
            Clearing times are <b>assumed</b> (200 ms MV, 300 ms LV) until you enter the upstream device clearing time. Each row is the worse of the full and reduced arcing-current scenarios.
            {cur.warnings?.length > 0 && <span className="af-note"> {cur.warnings.join(" ")}</span>}
          </p>
        </div>
        {!bad(cur) && (
          <div>
            <div className={cx("af-label", cur.e_cal_cm2 < 40 ? "is-warning" : "is-danger")} aria-label="Arc flash label preview">
              <header>{cur.e_cal_cm2 < 40 ? "WARNING" : "DANGER"}</header>
              <div className="af-big">Arc flash and shock hazard<br />appropriate PPE required<b>{fmt(cur.e_cal_cm2, 1)} cal/cm²</b>incident energy at {fmt(cur.input.working_mm, 0)} mm</div>
              <div className="af-row"><span>Arc flash boundary</span><b>{fmt(cur.afb_mm, 0)} mm</b></div>
              <div className="af-row"><span>PPE level (informative)</span><b>{cur.ppe.level === 5 ? "none" : cur.ppe.level === 0 ? "—" : `Cat ${cur.ppe.level}`}</b></div>
              <div className="af-row"><span>Nominal voltage</span><b>{cur.input.voc_kv < 1 ? Math.round(cur.input.voc_kv * 1000) + " V" : cur.input.voc_kv + " kV"}</b></div>
              <div className="af-row"><span>Limited approach</span><b>—</b></div>
              <div className="af-row"><span>Restricted approach</span><b>—</b></div>
              <div className="af-row"><span>Equipment</span><b>{cur.id}</b></div>
              <footer>IEEE 1584-2018 · data {cur.data_status} · {cur.clearing_assumed ? "clearing time assumed" : `${cur.input.clearing_ms} ms clearing`} · preview only</footer>
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}
