/* Shared UI primitives for every workspace. React is the global UMD build. */
const { useState, useEffect } = React;
import { autoLayout } from "../engine/loadflow.js";
import { checkDirection, checkUtilization, meterFill, utilTone } from "./checks.js";

/* ---------------------------------------------------------------- helpers */
let uid = 0;
export const newId = () => "s" + ++uid + Date.now().toString(36);
export const clone = (x) => (typeof structuredClone === "function" ? structuredClone(x) : JSON.parse(JSON.stringify(x)));
export const fmt = (x, d = 3) => (x === undefined || x === null || !isFinite(x) ? "—" : (Math.abs(x) < 0.5 * 10 ** -d ? 0 : x).toFixed(d));
export const sgn = (x, d = 2) => (x === undefined || x === null || !isFinite(x) ? "—" : (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(d));
export const cx = (...a) => a.filter(Boolean).join(" ");
export const V_MIN = 0.95, V_MAX = 1.05;
export const vflagOf = (v) => (v < V_MIN ? "low" : v > V_MAX ? "high" : "ok");
export const FLAG_COLOR = { low: "var(--low)", high: "var(--high)", ok: "var(--ok)" };
export const busType = (b) => { const t = String(b.type ?? "PQ").toUpperCase(); return t === "SLACK" ? "slack" : t; };
export const isXfmr = (br) => "tap" in br || "shift" in br;

export function makeScenario(name, data, layout) {
  return { id: newId(), name, data: clone(data), layout: clone(layout || autoLayout(data)), result: null, solvedData: null };
}
export function freeSpot(layout) {
  const pts = Object.values(layout);
  for (let r = 0; r < 12; r++) for (let c = 0; c < 9; c++) {
    const p = [140 + c * 100, 90 + r * 80];
    if (pts.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) > 90)) return p;
  }
  return [500, 340];
}

/* ------------------------------------------------------- shared controls */
export function NumField({ value, onCommit, placeholder, invalid, disabled, className, id, step }) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  const [focus, setFocus] = useState(false);
  useEffect(() => { if (!focus) setText(value === undefined ? "" : String(value)); }, [value, focus]);
  const parsed = text.trim() === "" ? undefined : Number(text);
  const bad = text.trim() !== "" && !isFinite(parsed);
  const commit = () => { if (!bad && parsed !== value) onCommit(parsed); };
  return (
    <input id={id} inputMode="decimal" disabled={disabled} value={text} placeholder={placeholder}
      title={invalid || (bad ? "Enter a number" : undefined)}
      onFocus={() => setFocus(true)}
      onBlur={() => { setFocus(false); commit(); }}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") { commit(); e.currentTarget.blur(); } if (e.key === "Escape") { setText(value === undefined ? "" : String(value)); e.currentTarget.blur(); } }}
      className={cx("num-input", (bad || invalid) && "is-bad", className)} step={step} />
  );
}

export function Btn({ children, onClick, kind = "ghost", className, disabled, title, type = "button", active }) {
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick}
      className={cx("btn", `btn-${kind}`, active && "is-active", className)}>{children}</button>
  );
}

export function Pill({ tone = "muted", children, title }) {
  return <span title={title} className={cx("pill", `pill-${tone}`)}>{children}</span>;
}

export function Section({ title, aside, children, className }) {
  return (
    <section className={cx("panel", className)}>
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3 pb-2">
        <h3 className="sec-title">{title}</h3>
        {typeof aside === "string" ? <span className="sec-aside">{aside}</span> : aside}
      </header>
      <div className="px-4 pb-4 min-w-0">{children}</div>
    </section>
  );
}

export function Icon({ name, size = 16 }) {
  const p = {
    select: "M4 3l7 17 2.5-7L20 10.5z",
    bus: "M3 12h18M7 8v8M17 8v8",
    connect: "M5 18L19 6M5 18a2 2 0 1 0 0-.01M19 6a2 2 0 1 0 0-.01",
    trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
    layout: "M4 4h6v6H4zM14 14h6v6h-6zM10 7h4v10",
    fit: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
    bolt: "M13 2L4 14h7l-1 8 9-12h-7z",
    check: "M4 12l5 5L20 6",
    copy: "M8 8h12v12H8zM4 16V4h12",
    save: "M12 3v12M6 10l6 6 6-6M4 21h16",
    plus: "M12 5v14M5 12h14",
    dup: "M8 8h12v12H8zM4 4h12v2M4 4v12h2",
    x: "M6 6l12 12M18 6L6 18",
    play: "M7 4l13 8-13 8z",
    alert: "M12 3l10 18H2zM12 10v5M12 18h.01",
    info: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 11v6M12 7.5h.01",
    empty: "M4 13l3-8h10l3 8v6H4zM4 13h5l1 2h4l1-2h5",
  }[name];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={p} />
    </svg>
  );
}


export function Field({ label, unit, children, hint }) {
  return (
    <label className="field">
      <span className="field-label">{label}{unit && <em>{unit}</em>}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Tile({ label, value, unit, sub, tone }) {
  return (
    <div className={cx("tile", tone && `tile-${tone}`)}>
      <div className="label">{label}</div>
      <div className="tile-value">{value}{unit && <span className="tile-unit">{unit}</span>}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}


/* ------------------------------------------------------- workspace header */
/* One header pattern for every workspace: identity (title + context line), an optional middle slot (mode
   switch, scenario chips), then status pills and the primary actions, separated by a hairline. */
export function WsHeader({ title, context, children, status, actions }) {
  return (
    <header className="topbar ws-head">
      <div className="ws-head-id">
        <h1 className="ws-title">{title}</h1>
        {context && <span className="ws-context">{context}</span>}
      </div>
      {children && <div className="ws-head-mid">{children}</div>}
      <div className="ws-head-end">
        <div className="ws-head-status">{status}</div>
        <div className="ws-head-actions">{actions}</div>
      </div>
    </header>
  );
}

/* --------------------------------------------------------- status badge */
const BADGE = { pass: ["Pass", "check"], fail: ["Fail", "x"], warn: ["Check", "alert"], na: ["Not checked", null] };
export function StatusBadge({ status = "na", children, title, iconOnly }) {
  const [text, icon] = BADGE[status] || BADGE.na;
  return (
    <span className={cx("badge", `badge-${status}`, iconOnly && "is-icon")} title={title ?? (iconOnly ? text : undefined)}>
      {icon && <Icon name={icon} size={12} />}{iconOnly ? <span className="sr-only">{text}</span> : children ?? text}
    </span>
  );
}

export const Clause = ({ children }) => (children ? <span className="clause">{children}</span> : null);

/* ------------------------------------------------------------ KPI strip */
/* Instrument-style readouts: big tabular value with unit, a status rail, optional pass/fail badge and an
   optional utilisation meter (value against a limit, limit tick at 80 % of the track).
   items: [{ label, value, unit, sub, status: "pass"|"fail"|"warn", meter: { u, label } }]; a status shows as
   the coloured rail plus an icon badge (check / cross / alert) so it never relies on colour alone. */
export function KpiStrip({ items, className }) {
  return (
    <div className={cx("kpis", className)}>
      {items.filter(Boolean).map((k, i) => (
        <div key={k.key || k.label || i} className={cx("kpi", k.status && `kpi-${k.status}`)}>
          <div className="kpi-head"><span>{k.label}</span>{k.status && <StatusBadge status={k.status} iconOnly />}</div>
          <div className="kpi-value">{k.value}{k.unit && <span className="kpi-unit">{k.unit}</span>}</div>
          {k.sub && <div className="kpi-sub">{typeof k.sub === "string" ? glue(k.sub) : k.sub}</div>}
          {k.meter && k.meter.u != null && (
            <>
              <div className="kpi-meter" role="meter" aria-valuemin={0} aria-valuemax={125} aria-valuenow={Math.round(k.meter.u * 100)} aria-label={`${k.label}: ${Math.round(k.meter.u * 100)} % of limit`}>
                <i style={{ width: `${meterFill(k.meter.u) * 100}%` }} /><b style={{ left: "80%" }} />
              </div>
              <div className="kpi-meter-l"><span>{glue(k.meter.label ?? `${fmt(k.meter.u * 100, 0)} % of limit`)}</span></div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/* Keep a number and its unit on one line ("27.1 %", "400 A") when a sub-line wraps. */
const glue = (s) => s.replace(/(\d) (?=[%A-Za-zµ°Ω])/g, "$1\u00a0");

/* Utilisation meter for a KPI from an engine check. */
export const checkMeter = (c, label) => (c ? { u: checkUtilization(c), label } : null);
export const checkStatus = (c) => (c ? (c.passed ? "pass" : "fail") : undefined);

/* ---------------------------------------------------------- checks table */
/* Engine checks as rows: pass/fail badge, name and note, value against limit with a utilisation bar, clause chip.
   format(v) prints numbers (the workspace's own precision rule). bar(c) says whether value / limit is a
   meaningful utilisation (not for ordinal values such as a size index, or two-sided tolerance checks). */
const ordinalCheck = (c) => /index/i.test(String(c.unit || ""));
export function ChecksTable({ checks, format = (v) => fmt(v, 2), bar = (c) => !ordinalCheck(c) }) {
  return (
    <div className="chk" role="table" aria-label="Design checks">
      <div className="chk-row chk-th" role="row">
        <span role="columnheader">Result</span><span role="columnheader">Check</span><span role="columnheader">Value vs limit</span><span role="columnheader" className="chk-cl">Clause</span>
      </div>
      {checks.map((c, k) => {
        const u = bar(c) ? checkUtilization(c) : null, dir = checkDirection(c);
        const tone = c.passed ? (u != null && u >= 0.9 ? "warn" : "pass") : "fail";
        const fill = meterFill(u);
        const num = (v) => (typeof v === "number" ? format(v) : v ?? "—");
        return (
          <div key={c.name + k} className={cx("chk-row", !c.passed && "is-fail")} role="row" title={c.note || undefined}>
            <span role="cell"><StatusBadge status={c.passed ? "pass" : "fail"} /></span>
            <div role="cell" className="min-w-0"><div className="chk-name">{c.name}</div>{c.note && <div className="chk-note">{c.note}</div>}</div>
            <div role="cell" className="chk-mid min-w-0">
              <div className="chk-vals">
                <span>{num(c.value)}<em>{c.unit}</em></span>
                <span className="chk-lim">{c.limit != null && c.limit !== "" ? <>{dir === "max" ? "≤" : "≥"} {num(c.limit)}<em>{c.unit}</em></> : "—"}</span>
              </div>
              {u != null && (
                <div className="chk-bar" aria-hidden="true">
                  <i style={{ width: `${fill * 100}%`, background: `var(--st-${tone})` }} /><b style={{ left: "80%" }} />
                </div>
              )}
              {u != null && <div className="chk-util">{fmt(u * 100, 0)} % of limit</div>}
            </div>
            <div role="cell" className="chk-cl min-w-0"><Clause>{c.clause}</Clause></div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------- empty / loading / error */
export function StateMsg({ kind = "empty", title, children, action, center }) {
  return (
    <div className={cx("state", `state-${kind}`, center && "state-center")} role={kind === "error" ? "alert" : kind === "loading" ? "status" : undefined}>
      {kind === "loading" ? <span className="spin" aria-hidden="true" /> : <Icon name={kind === "error" ? "alert" : "info"} size={18} />}
      <div className="min-w-0">{title && <b>{title}</b>}{children}{action && <div className="mt-3">{action}</div>}</div>
    </div>
  );
}
