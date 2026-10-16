// Code compliance panel for the System workspace (Schedules & studies): protection code checks by equipment.
// NEC 450.3 / CEC 26-250..26-254 transformer overcurrent limits, NEC 240.87 arc energy reduction, NEC 110.16(B) label.
const { useState, useMemo } = React;
import { Section, StatusBadge, Clause, KpiStrip, StateMsg, ChecksTable, cx, fmt } from "./common.jsx";
import { protectionCodeChecks, AER_METHODS, PROT_DATA_STATUS, CODES } from "../engine/protchecks.js";
import { EQUIPMENT } from "../engine/system.js";
import { checkUtilization, meterFill } from "./checks.js";

const CSS = `
.cc-bar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:12px; }
.cc-bar .cc-end { margin-left:auto; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.cc-group { border:1px solid var(--line); border-radius:8px; margin-bottom:12px; overflow:hidden; }
.cc-ghead { display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px; padding:8px 12px; background: var(--panel-2); border-bottom:1px solid var(--line); }
.cc-link { font-family: var(--font-data); font-weight:600; color: var(--accent); background:none; border:0; padding:0; cursor:pointer; text-decoration: underline; text-underline-offset: 3px; text-decoration-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.cc-link:hover { text-decoration-color: var(--accent); }
.cc-type { color: var(--muted); font-size:12px; }
.cc-ghead .cc-in { margin-left:auto; }
.cc-rows { padding: 0 12px; }
.cc-rows .chk-row.is-warn { background: linear-gradient(90deg, color-mix(in srgb, var(--high) 7%, transparent), transparent 55%); }
.cc-in { display:inline-flex; align-items:center; gap:6px; font-size:12px; color: var(--muted); flex-wrap:wrap; }
.cc-in select, .cc-in input { width:auto; min-width:0; max-width:100%; }
.cc-ctl { margin-top:6px; }
.cc-chips { display:flex; flex-wrap:wrap; gap:4px; }
.cc-pre { display:grid; grid-template-columns: auto minmax(0, 1fr); gap:2px 10px; font-size:12px; }
.cc-pre dt { color: var(--faint); }
.cc-pre dd { font-family: var(--font-data); margin:0; }
.cc-pre dd.is-missing { color: var(--high); font-family: var(--font-ui); }
.cc-notes { color: var(--faint); font-size:12px; line-height:1.5; margin-top:8px; }
.cc-pre dd { white-space: nowrap; }
@media (max-width: 640px) {
  .cc-ghead .cc-in { margin-left:0; }
  .cc-in { display:flex; width:100%; min-width:0; }
  .cc-in select, .cc-in input { flex: 1 1 120px; width:100%; min-width:0; }
  .cc-pre { grid-template-columns: minmax(0, 1fr) auto; }
}
`;

const groupStatus = (rows) => (rows.some((r) => r.status === "fail") ? "fail" : rows.some((r) => r.status === "warn") ? "warn" : "pass");
const A = (v) => (v == null ? "—" : fmt(v, v >= 100 ? 0 : 1));

function ValueCell({ k }) {
  if (k.input?.kind === "label" && k.prefill) {
    return (
      <dl className="cc-pre" aria-label="Label fields known from the model">
        {k.prefill.map((p) => <React.Fragment key={p.field}><dt>{p.field.replace(/ at the service overcurrent device| of the service overcurrent device at that fault current/, "")}</dt><dd className={cx(!p.value && "is-missing")}>{p.value ?? "not known"}</dd></React.Fragment>)}
      </dl>
    );
  }
  if (k.input?.kind === "label") return <div className="chk-vals"><span>{A(k.value)}<em>A</em></span><span className="chk-lim">label at ≥ {A(k.limit)}<em>A</em></span></div>;
  if (k.input?.kind === "aer" && k.direction === "min") return <div className="chk-vals"><span>trip {A(k.value)}<em>A</em></span><span className="chk-lim">method at ≥ {A(k.limit)}<em>A</em></span></div>;
  const c = { value: k.value, limit: k.limit, passed: k.status !== "fail", direction: k.direction };
  const u = k.value != null && k.limit != null ? checkUtilization(c) : null;
  const tone = k.status === "fail" ? "fail" : k.status === "warn" ? "warn" : u != null && u >= 0.9 ? "warn" : "pass";
  return (
    <>
      <div className="chk-vals"><span>{A(k.value)}<em>{k.unit}</em></span><span className="chk-lim">{k.limit != null ? <>{k.direction === "min" ? "≥" : "≤"} {A(k.limit)}<em>{k.unit}</em></> : "—"}</span></div>
      {u != null && <div className="chk-bar" aria-hidden="true"><i style={{ width: `${meterFill(u) * 100}%`, background: `var(--st-${tone})` }} /><b style={{ left: "80%" }} /></div>}
      {u != null && <div className="chk-util">{fmt(u * 100, 0)} % of limit</div>}
    </>
  );
}

function RowInput({ k, sys, updateEq, updateCon }) {
  const i = k.input;
  if (i?.kind === "aer") return (
    <label className="cc-in cc-ctl">Method
      <select className="num-input" value={i.method} aria-label={`Arc energy reduction method for ${k.target.id}`} onChange={(ev) => updateCon(k.target.id, { aer_method: ev.target.value || undefined })}>
        <option value="">None selected</option>
        {AER_METHODS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
      </select>
    </label>
  );
  if (i?.kind === "label") return (
    <div className="cc-in cc-ctl">
      <label className="cc-in">Service equipment
        <select className="num-input" value={i.service == null ? "" : i.service ? "yes" : "no"} onChange={(ev) => updateEq(k.target.id, { service: ev.target.value === "" ? undefined : ev.target.value === "yes" })}>
          <option value="">Auto (fed from utility)</option><option value="yes">Yes</option><option value="no">No</option>
        </select>
      </label>
      <label className="cc-in">Label applied
        <input className="num-input" type="date" value={i.label_date} onChange={(ev) => updateEq(k.target.id, { label_date: ev.target.value || undefined })} />
      </label>
    </div>
  );
  return null;
}

export function CodeCompliancePanel({ sys, analysis, select, updateEq, updateCon, setCode }) {
  const [issuesOnly, setIssuesOnly] = useState(false);
  const res = useMemo(() => protectionCodeChecks(sys, analysis), [sys, analysis]);
  const code = res.code;
  const head = (
    <span className="cc-in">
      <label className="cc-in">Code
        <select id="cc-code" className="num-input" value={code} onChange={(ev) => setCode(ev.target.value)}>{CODES.map((c) => <option key={c} value={c}>{c}</option>)}</select>
      </label>
      <StatusBadge status="warn" title="Every limit is UNVERIFIED: not yet read in the primary code text.">Data {PROT_DATA_STATUS}</StatusBadge>
    </span>
  );
  if (!analysis?.ok) return <Section title="Code compliance · protection" aside={head}><StateMsg kind="empty" title="Solve the system first.">The checks use the load flow, short circuit and protective-device model.</StateMsg></Section>;
  const counts = { pass: 0, fail: 0, warn: 0 };
  res.checks.forEach((k) => { counts[k.status]++; });
  const order = sys.equipment.map((e) => e.id);
  const groups = [...new Set(res.checks.map((k) => k.group))].sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .map((g) => ({ id: g, rows: res.checks.filter((k) => k.group === g) }))
    .map((g) => ({ ...g, shown: issuesOnly ? g.rows.filter((k) => k.status !== "pass") : g.rows }))
    .filter((g) => g.shown.length);
  const eqOf = (id) => sys.equipment.find((e) => e.id === id);
  return (
    <Section title="Code compliance · protection" aside={head}>
      <style>{CSS}</style>
      <div className="notice notice-warn mb-3">
        <b>Data UNVERIFIED.</b> The limits in Table 450.3(A)/(B), CEC Rules 26-250/26-254, 240.87 and 110.16(B) come from public secondary sources and recall; none was read in the code text (the free NFPA viewer needs a sign-in). Confirm each value against NFPA 70-2023 and the adopted CEC edition before relying on a result.
      </div>
      <KpiStrip items={[
        { label: "Checks", value: res.checks.length, sub: `${code} · ${groups.length} items shown` },
        { label: "Fail", value: counts.fail, status: counts.fail ? "fail" : "pass", sub: counts.fail ? "fix or justify" : "none" },
        { label: "Needs review", value: counts.warn, status: counts.warn ? "warn" : "pass", sub: "cannot verify or action needed" },
        { label: "Pass", value: counts.pass, sub: "within the limit" },
      ]} />
      <div className="cc-bar mt-3">
        <label className="live-toggle"><input id="cc-issues" type="checkbox" checked={issuesOnly} onChange={(ev) => setIssuesOnly(ev.target.checked)} /><span>Fail and review only</span></label>
        <span className="text-faint text-[12px]">Device ratings from the breaker schedule and the Coordination view settings.</span>
      </div>
      {res.checks.length === 0 && <StateMsg kind="empty" title="No protection code checks apply.">Add a transformer, a breaker of 1200 A or more, or service equipment of 1000 A or more.</StateMsg>}
      {res.checks.length > 0 && groups.length === 0 && <StateMsg kind="empty" title="Nothing fails.">Every check passes. Clear the filter to see them.</StateMsg>}
      {groups.map((g) => {
        const e = eqOf(g.id), gs = groupStatus(g.rows);
        const xfmr = e?.type === "transformer";
        return (
          <div key={g.id} className="cc-group">
            <div className="cc-ghead">
              <StatusBadge status={gs} iconOnly />
              <button className="cc-link" onClick={() => select({ kind: "eq", id: g.id })} title={`Select ${g.id} in the site view`}>{g.id}</button>
              <span className="cc-type">{e ? `${EQUIPMENT[e.type].label}${e.name ? ` · ${e.name}` : ""}` : ""}</span>
              {xfmr && (
                <label className="cc-in">Location
                  <select className="num-input" value={e.oc_supervised ? "sup" : ""} aria-label={`${g.id} supervision`} onChange={(ev) => updateEq(g.id, { oc_supervised: ev.target.value === "sup" ? true : undefined })}>
                    <option value="">Unsupervised (default)</option><option value="sup">Supervised (qualified persons only)</option>
                  </select>
                </label>
              )}
            </div>
            {g.shown.every((k) => k.input?.kind === "transformer" && k.status !== "warn") ? (
              <div className="cc-rows">
                <ChecksTable format={(v) => fmt(v, v >= 100 ? 0 : 1)}
                  checks={g.shown.map((k) => ({ name: k.name, value: k.value, limit: k.limit, unit: k.unit, passed: k.status === "pass", direction: k.direction, note: k.note, clause: `${k.clause} · ${k.data_status}` }))} />
              </div>
            ) : (
            <div className="chk cc-rows" role="table" aria-label={`Code checks for ${g.id}`}>
              {g.shown.map((k) => (
                <div key={k.key} className={cx("chk-row", k.status === "fail" && "is-fail", k.status === "warn" && "is-warn")} role="row">
                  <span role="cell"><StatusBadge status={k.status}>{k.status === "warn" ? "Review" : undefined}</StatusBadge></span>
                  <div role="cell" className="min-w-0">
                    <div className="chk-name">{k.name}{k.target.kind === "con" && <> · <button className="cc-link" onClick={() => select(k.target)} title={`Select ${k.target.id}`}>{k.target.id}</button></>}</div>
                    <div className="chk-note">{k.note}</div>
                    <RowInput k={k} sys={sys} updateEq={updateEq} updateCon={updateCon} />
                  </div>
                  <div role="cell" className="chk-mid min-w-0"><ValueCell k={k} /></div>
                  <div role="cell" className="chk-cl min-w-0"><div className="cc-chips">{k.chips.map((c) => <Clause key={c}>{c}</Clause>)}<Clause>{k.data_status}</Clause></div></div>
                </div>
              ))}
            </div>
            )}
          </div>
        );
      })}
      <p className="cc-notes">
        Transformer limits use the rated current kVA/(√3·kV) and the device rating or setting: relay 51 pickup on MV (no next-higher allowance; continuously adjustable), LV breaker long-time pickup Ir with the next higher NEC 240.6(A) rating where the table allows it.
        240.87 takes the trip unit sensor as the highest continuous setting and compares the instantaneous pickup (+10 % tolerance) with the reduced-scenario arcing current of the load-side gear from the arc-flash study.
        110.16(B) service equipment defaults to gear fed directly from the utility.
        {res.notes.length > 0 && <> {res.notes.join(" ")}</>}
      </p>
    </Section>
  );
}
