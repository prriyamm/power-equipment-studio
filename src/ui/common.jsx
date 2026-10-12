/* Shared UI primitives for every workspace. React is the global UMD build. */
const { useState, useEffect } = React;
import { autoLayout } from "../engine/loadflow.js";

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
        <h3 className="label">{title}</h3>
        {aside}
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

