/* Load-flow Studies tab: Q-limit enforcement, N-1 screening, short circuit. */
const { useState, useMemo } = React;
import { screenN1 } from "../engine/contingency.js";
import { lfShortCircuit } from "../engine/lfshortcircuit.js";
import { Pill, Section, cx, fmt } from "./common.jsx";

const CSS = `
.lfs-sort { background: none; border: 0; color: inherit; font: inherit; cursor: pointer; padding: 0; display: inline-flex; align-items: center; gap: 3px; text-transform: inherit; letter-spacing: inherit; }
.lfs-sort:hover { color: var(--fg); }
.lfs-sort.is-active { color: var(--accent); }
.lfs-sev { display: inline-block; height: 6px; border-radius: 3px; background: var(--high); vertical-align: middle; margin-right: 6px; min-width: 2px; }
.lfs-sev.is-crit { background: var(--crit); }
.lfs-row-off { opacity: .55; }
.lfs-bars { width: 100%; height: auto; display: block; }
.lfs-toggle { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
.lfs-toggle input { accent-color: var(--accent); }
.lfs-two { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 12px; align-items: start; }
@media (max-width: 1000px) { .lfs-two { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 640px) {
  .lfs-sort { min-height: 40px; min-width: 40px; padding: 0 2px; }
  .lfs-toggle { min-height: 40px; }
  .lfs-toggle input { width: 18px; height: 18px; }
}
`;

function QLimits({ scenario, result, stale, setEnforceQ }) {
  const on = !!scenario.enforceQ;
  const pvLim = scenario.data.buses.filter((b) => String(b.type).toUpperCase() === "PV" && (typeof b.q_min === "number" || typeof b.q_max === "number")).length;
  const pv = scenario.data.buses.filter((b) => String(b.type).toUpperCase() === "PV").length;
  const sw = result?.switching;
  return (
    <Section title="Q-limit enforcement" aside={
      <label className="lfs-toggle"><input type="checkbox" checked={on} onChange={(e) => setEnforceQ(e.target.checked)} />Enforce generator Q limits</label>}>
      <p className="text-muted text-[13px] mb-3 leading-relaxed">
        After each Newton-Raphson solve, a PV bus whose generator Q exceeds q_max or falls below q_min becomes a PQ bus with Q held at the limit,
        and the case is re-solved. It returns to PV if its voltage crosses back over the setpoint. Limits are read from each PV bus (Data tab, q_min / q_max). The slack bus is not limited.
      </p>
      {pvLim === 0 && <div className="notice notice-info mb-3">No PV bus has q_min or q_max set ({pv} PV bus{pv === 1 ? "" : "es"}). Add limits on the Data tab, or open “IEEE 14-bus, tight Q limits” from the Cases tab.</div>}
      {on && stale && <div className="notice notice-warn mb-3">The network changed since the last solve. Results refresh automatically with Live solve on.</div>}
      {on && sw && (
        <>
          <div className="flex items-center gap-2 mb-2">
            <Pill tone={sw.length ? "high" : "ok"}>{sw.length ? `${sw.filter((e) => e.to === "PQ").length} bus${sw.length === 1 ? "" : "es"} switched` : "No limit reached"}</Pill>
            <span className="text-faint text-[12px]">{result.outer_iterations} outer iteration{result.outer_iterations === 1 ? "" : "s"}</span>
          </div>
          {sw.length > 0 && (
            <div className="table-wrap"><table className="grid-table">
              <thead><tr><th>Bus</th><th>Change</th><th>Limit</th><th className="r">Q held<em>Mvar</em></th><th className="r">V at switch<em>pu</em></th></tr></thead>
              <tbody>{sw.map((e, i) => (
                <tr key={i}><td className="font-mono">{e.bus}</td><td>{e.from} → {e.to}</td><td className="text-muted">{e.limit}</td><td className="r">{fmt(e.q_mvar, 2)}</td><td className="r">{e.v.toFixed(4)}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </>
      )}
      {!on && <div className="text-faint text-[12.5px]">Off. Switched buses are marked <span className="font-mono">PQ@limit</span> on the diagram when enabled.</div>}
    </Section>
  );
}

const N1_COLS = [["severity", "Severity"], ["branch", "Outage"], ["status", "Status"], ["min_v", "V min"], ["max_v", "V max"], ["nv", "V violations"], ["novl", "Overloads"], ["max_loading_pct", "Max loading"]];

function N1({ scenario, openOutage }) {
  const [sort, setSort] = useState({ key: "severity", dir: -1 });
  const screen = useMemo(() => {
    try { return screenN1(scenario.data, { enforceQLimits: !!scenario.enforceQ }); } catch (e) { return { rows: [], message: e.message }; }
  }, [scenario.data, scenario.enforceQ]);
  const rows = useMemo(() => {
    const val = (r) => ({ severity: r.severity, branch: r.branch, status: r.islanding ? 2 : r.converged ? 0 : 1, min_v: r.min_v ?? 9, max_v: r.max_v ?? -9,
      nv: r.v_violations.length, novl: r.overloads.length, max_loading_pct: r.max_loading_pct ?? -1 })[sort.key];
    return [...screen.rows].sort((a, b) => (val(a) - val(b)) * sort.dir || a.branch - b.branch);
  }, [screen, sort]);
  const maxSev = Math.max(1e-9, ...screen.rows.map((r) => (r.severity > 0 && r.severity < 1000 ? r.severity : 0)));
  const nIsl = screen.rows.filter((r) => r.islanding).length, nBad = screen.rows.filter((r) => !r.islanding && (r.v_violations.length || r.overloads.length || !r.converged)).length;
  return (
    <Section title="N−1 contingency screening" aside={screen.rows.length > 0 && <span className="flex gap-2">
      <Pill tone={nBad ? "high" : "ok"}>{nBad} with violations</Pill>{nIsl > 0 && <Pill tone="muted">{nIsl} islanding</Pill>}</span>}>
      {screen.message && <div className="notice notice-crit">{screen.message}</div>}
      {screen.rows.length > 0 && (
        <>
          <p className="text-muted text-[13px] mb-3 leading-relaxed">
            Each branch is taken out in turn and the case re-solved from the base solution. Violations use the 0.95–1.05 pu band and branch ratings (rate_a) where set.
            Click a row to open that outage as a new scenario, then compare it on the Cases tab.
          </p>
          <div className="table-wrap"><table className="grid-table">
            <thead><tr>{N1_COLS.map(([k, l]) => (
              <th key={k} className={["min_v", "max_v", "nv", "novl", "max_loading_pct"].includes(k) ? "r" : ""}>
                <button className={cx("lfs-sort", sort.key === k && "is-active")} onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? -s.dir : k === "severity" ? -1 : 1 }))}>
                  {l}{sort.key === k && (sort.dir > 0 ? " ▲" : " ▼")}</button></th>))}</tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.branch} className={cx(!r.islanding && "clickable", r.islanding && "lfs-row-off")} onClick={() => !r.islanding && openOutage(r.branch)} title={r.islanding ? "Islands the network: not solved" : "Open this outage as a scenario"}>
                <td>{r.islanding ? <span className="text-faint">—</span> : r.severity >= 1000 ? <span className="text-crit">diverged</span> :
                  <><span className={cx("lfs-sev", r.severity > 5 && "is-crit")} style={{ width: `${Math.max(2, (46 * r.severity) / maxSev)}px`, opacity: r.severity > 0 ? 1 : 0.25 }} /><span className="font-mono">{fmt(r.severity, 2)}</span></>}</td>
                <td className="font-mono whitespace-nowrap">{r.from}→{r.to}</td>
                <td>{r.islanding ? <Pill tone="muted">Islanding</Pill> : r.converged ? <Pill tone="ok">Converged</Pill> : <Pill tone="crit">Diverged</Pill>}</td>
                <td className={cx("r", r.min_v != null && r.min_v < 0.95 && "text-crit")}>{r.min_v == null ? <span className="text-faint">—</span> : r.min_v.toFixed(4)}</td>
                <td className={cx("r", r.max_v != null && r.max_v > 1.05 && "text-warn")}>{r.max_v == null ? <span className="text-faint">—</span> : r.max_v.toFixed(4)}</td>
                <td className="r">{r.v_violations.length ? <span className="text-warn" title={`Buses ${r.v_violations.join(", ")}`}>{r.v_violations.length} · {r.v_violations.slice(0, 4).join(", ")}{r.v_violations.length > 4 ? "…" : ""}</span> : <span className="text-faint">0</span>}</td>
                <td className="r">{r.overloads.length ? <span className="text-crit" title={r.overloads.map((o) => `${o.from}→${o.to} ${o.loading_pct.toFixed(0)}%`).join(", ")}>{r.overloads.length}</span> : <span className="text-faint">{r.max_loading_pct == null ? "—" : 0}</span>}</td>
                <td className="r">{r.max_loading_pct == null ? <span className="text-faint">—</span> : fmt(r.max_loading_pct, 1) + "%"}</td>
              </tr>))}</tbody>
          </table></div>
          <p className="text-faint text-[12px] mt-2 leading-relaxed">Severity = 100 × Σ voltage excursion beyond the band (pu) + Σ overload excess (% over rating) ÷ 10. Islanding outages are listed last and are not solved.</p>
        </>
      )}
    </Section>
  );
}

function IkChart({ buses, unit }) {
  const W = 620, H = 220, L = 44, R = 10, T = 12, B = 28;
  const vals = buses.map((b) => (unit === "kA" ? b.ik_ka : b.ik_pu));
  const hi = Math.max(...vals) * 1.1 || 1, band = (W - L - R) / buses.length;
  const y = (v) => T + (H - T - B) * (1 - v / hi);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * hi);
  return (
    <div className="chart-scroll" style={{ "--chart-min": "480px" }}><svg viewBox={`0 0 ${W} ${H}`} className="chart lfs-bars" role="img" aria-label="Initial symmetrical short-circuit current per bus">
      {ticks.map((t, i) => (<g key={i}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="gridline" /><text x={L - 6} y={y(t) + 3.5} textAnchor="end" className="tick">{t.toFixed(t >= 10 ? 0 : 1)}</text></g>))}
      {buses.map((b, i) => {
        const v = vals[i], x = L + band * i + band * 0.14, w = band * 0.72;
        return (<g key={b.id}>
          <rect x={x} y={y(v)} width={w} height={Math.max(y(0) - y(v), 0)} rx="1.5" fill="var(--accent)"><title>{`Bus ${b.id}: ${v.toFixed(2)} ${unit}`}</title></rect>
          <text x={L + band * i + band / 2} y={H - 10} textAnchor="middle" className="tick">{b.id}</text>
        </g>);
      })}
      <text x={L} y={10} className="tick">I″k, {unit}</text>
    </svg></div>
  );
}

function ShortCircuit({ scenario }) {
  const sc = useMemo(() => { try { return lfShortCircuit(scenario.data); } catch (e) { return { error: e.message }; } }, [scenario.data]);
  if (sc.error) return <Section title="Short circuit"><div className="notice notice-crit">{sc.error}</div></Section>;
  const anyKv = sc.buses.some((b) => b.kv_given), allKv = sc.buses.every((b) => b.kv_given);
  const unit = allKv ? "kA" : "pu";
  const srcs = scenario.data.buses.filter((b) => ["SLACK", "PV"].includes(String(b.type).toUpperCase()));
  return (
    <Section title="Short circuit" aside={<span className="text-faint text-[12px]">IEC 60909-0, three-phase bolted fault, c<sub>max</sub></span>}>
      <p className="text-muted text-[13px] mb-3 leading-relaxed">
        Sources are the slack and PV buses ({srcs.map((b) => b.id).join(", ")}), each behind x_source_pu (default 0.1 pu on {sc.base_mva} MVA, optional bus field in the case JSON; kv likewise).
        Loads, shunts and line charging are neglected. Buses without kv are taken as 1.0 kV, so only the pu currents are meaningful for them.
        {anyKv && !allKv && " Mixed: set kv on every bus to get kA."}
      </p>
      <div className="lfs-two">
        <div className="table-wrap"><table className="grid-table">
          <thead><tr><th>Bus</th><th className="r">kV</th><th className="r">I″k<em>pu</em></th><th className="r">I″k<em>kA</em></th><th className="r">X/R</th><th className="r">κ</th><th className="r">ip<em>kA</em></th><th className="r">Sk″<em>MVA</em></th></tr></thead>
          <tbody>{sc.buses.map((b) => (
            <tr key={b.id}>
              <td className="font-mono">{b.id}</td>
              <td className="r">{b.kv_given ? fmt(b.kv, 2) : <span className="text-faint">—</span>}</td>
              <td className="r">{fmt(b.ik_pu, 3)}</td>
              <td className="r">{b.kv_given ? fmt(b.ik_ka, 2) : <span className="text-faint">—</span>}</td>
              <td className="r">{fmt(b.xr, 2)}</td><td className="r">{fmt(b.kappa, 3)}</td>
              <td className="r">{b.kv_given ? fmt(b.ip_ka, 2) : <span className="text-faint">—</span>}</td>
              <td className="r">{fmt(b.sk_mva, 0)}</td>
            </tr>))}</tbody>
        </table></div>
        <div><IkChart buses={sc.buses} unit={unit} />
          <p className="text-faint text-[12px] mt-1">Initial symmetrical short-circuit current per bus{allKv ? "" : " (pu on system base)"}.</p></div>
      </div>
    </Section>
  );
}

export function StudiesTab({ scenario, result, stale, setEnforceQ, openOutage }) {
  return (
    <div className="flex flex-col gap-4 p-4">
      <style>{CSS}</style>
      <QLimits scenario={scenario} result={result} stale={stale} setEnforceQ={setEnforceQ} />
      <N1 scenario={scenario} openOutage={openOutage} />
      <ShortCircuit scenario={scenario} />
    </div>
  );
}
