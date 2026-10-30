/* System projects: undo/redo history, Project menu (new, library, import, export). */
const { useState, useRef, useEffect, useCallback } = React;
import { Btn, Icon, cx, clone } from "./common.jsx";
import { LIBRARY } from "../engine/systemLibrary.js";
import { serializeSystem, parseSystemWithWarning } from "../engine/systemio.js";

const MAX_HISTORY = 100;

/* ------------------------------------------------------------- history */
/* setSys(valueOrFn)            one history entry per call.
   setSys(valueOrFn, {silent})  live change with no entry of its own (drag moves); the state before the
                                first silent change is held back and committed by checkpoint() on pointer-up. */
export function useHistory(initial) {
  const [, force] = useState(0);
  const h = useRef(null);
  if (!h.current) h.current = { present: typeof initial === "function" ? initial() : initial, past: [], future: [], held: null };
  const s = h.current;
  const render = () => force((n) => n + 1);
  const push = (list, v) => { list.push(v); if (list.length > MAX_HISTORY) list.shift(); };
  const flush = () => { if (s.held) { push(s.past, s.held); s.held = null; s.future = []; } };

  const setSys = useCallback((v, opts) => {
    const next = typeof v === "function" ? v(s.present) : v;
    if (next === s.present) return;
    if (opts?.silent) { if (!s.held) s.held = s.present; s.present = next; render(); return; }
    flush(); push(s.past, s.present); s.future = []; s.present = next; render();
  }, []); // eslint-disable-line
  const checkpoint = useCallback(() => { if (s.held) { flush(); render(); } }, []); // eslint-disable-line
  const undo = useCallback(() => {
    flush(); if (!s.past.length) { render(); return; }
    push(s.future, s.present); s.present = s.past.pop(); render();
  }, []); // eslint-disable-line
  const redo = useCallback(() => {
    flush(); if (!s.future.length) return;
    push(s.past, s.present); s.present = s.future.pop(); render();
  }, []); // eslint-disable-line
  return [s.present, setSys, { undo, redo, checkpoint, canUndo: s.past.length > 0 || !!s.held, canRedo: s.future.length > 0 && !s.held }];
}

/* ------------------------------------------------------------ project menu */
const slug = (t) => String(t || "system").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "system";
export const emptyProject = () => ({
  name: "New package", base_mva: 10,
  equipment: [{ id: "UTIL", type: "utility", name: "Utility 13.8 kV", kv: 13.8, mva_sc: 500, xr: 15, gx: 0, gy: 0 }],
  connectors: [],
});

const CSS = `
.sp-wrap { position: relative; }
.sp-toast-warn { border-color: var(--high); cursor: pointer; }
.sp-menu { min-width: 190px; }
.sp-menu .sp-sep { height: 1px; background: var(--line); margin: 4px 0; }
.sp-menu button:disabled { color: var(--faint); cursor: default; background: none; }
.sp-lib { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; padding: 14px; overflow: auto; }
.sp-card { text-align: left; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 6px; }
.sp-card:hover { border-color: var(--accent); }
.sp-card b { font-weight: 600; }
.sp-card span { color: var(--muted); font-size: 12.5px; line-height: 1.45; }
.sp-card i { color: var(--faint); font-size: 11.5px; font-style: normal; font-family: var(--font-data); margin-top: auto; }
.sp-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.sp-body { padding: 14px; display: flex; flex-direction: column; gap: 10px; overflow: auto; }
`;

export function ProjectMenu({ sys, setSys, history, onLoaded }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState(null);       // "library" | "import" | null
  const [paste, setPaste] = useState("");
  const [err, setErr] = useState(null);
  const [toast, setToast] = useState(null);
  const [downloads, setDownloads] = useState(null);
  const fileRef = useRef(null), rootRef = useRef(null);
  const { undo, redo, canUndo, canRedo } = history;

  useEffect(() => {
    let alive = true;
    try { window.claude?.use?.("downloads").then((d) => alive && setDownloads(d)).catch(() => {}); } catch (e) { /* not in a viewer */ }
    return () => { alive = false; };
  }, []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), toast.ms ?? 2600); return () => clearTimeout(t); }, [toast]);
  useEffect(() => {
    if (!open) return;
    const away = (ev) => { if (!rootRef.current?.contains(ev.target)) setOpen(false); };
    document.addEventListener("pointerdown", away); return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  useEffect(() => {
    const onKey = (ev) => {
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "")) return;
      if (!rootRef.current || rootRef.current.offsetParent === null) return;   // workspace hidden
      const mod = ev.ctrlKey || ev.metaKey; if (!mod) return;
      const k = ev.key.toLowerCase();
      if (k === "z" && !ev.shiftKey) { ev.preventDefault(); undo(); }
      else if ((k === "z" && ev.shiftKey) || k === "y") { ev.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const copyText = (text, msg) => {
    try { navigator.clipboard.writeText(text).then(() => setToast({ text: msg }), () => setToast({ tone: "crit", text: "Clipboard blocked. Select the text and copy it manually." })); }
    catch (e) { setToast({ tone: "crit", text: "Clipboard blocked. Select the text and copy it manually." }); }
  };
  const exportJson = async () => {
    setOpen(false);
    const text = serializeSystem(sys), filename = `${slug(sys.name)}.json`;
    if (!downloads) { copyText(text, "Saving is not available here. Project JSON copied to clipboard instead."); return; }
    try { await downloads.save({ filename, data: text }); setToast({ text: `Saved ${filename}` }); }
    catch (e) { if (e?.code !== "declined") setToast({ tone: "crit", text: `Could not save: ${e?.message || e?.code || "unknown error"}` }); }
  };
  const load = (next, msg) => { setSys(clone(next)); onLoaded?.(); setDialog(null); setErr(null); setPaste(""); setToast({ text: msg }); };
  // A file saved by another pecalc version or table data still opens; the warning stays up longer than the usual toast.
  const ingest = (text) => {
    try {
      const { system: s, warning } = parseSystemWithWarning(text);
      load(s, `Opened ${s.name}`);
      if (warning) setToast({ tone: "warn", ms: 12000, text: `Opened ${s.name}. ${warning}` });
    } catch (e) { setErr(e.message); }
  };
  const onFile = (f) => { if (!f) return; const r = new FileReader(); r.onload = () => ingest(String(r.result)); r.onerror = () => setErr("Could not read that file."); r.readAsText(f); };
  const item = (label, fn, disabled, hint) => <button disabled={disabled} onClick={() => { setOpen(false); fn(); }}>{label}{hint && <span className="text-faint" style={{ float: "right", marginLeft: 16 }}>{hint}</span>}</button>;
  const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform || "");
  const mod = mac ? "⌘" : "Ctrl+";

  return (
    <div className="sp-wrap" ref={rootRef}>
      <style>{CSS}</style>
      <div className="flex items-center gap-1">
        <Btn onClick={() => setOpen(!open)} active={open} title="New, library, import and export"><Icon name="layout" size={14} />Project</Btn>
        <Btn onClick={undo} disabled={!canUndo} title={`Undo (${mod}Z)`}>Undo</Btn>
        <Btn onClick={redo} disabled={!canRedo} title={`Redo (${mod}Shift+Z)`}>Redo</Btn>
      </div>
      {open && (
        <div className="menu sp-menu" style={{ left: "auto", right: 0 }}>
          {item("New package", () => load(emptyProject(), "New package with one utility"))}
          {item("Open library…", () => setDialog("library"))}
          <div className="sp-sep" />
          {item("Import JSON…", () => { setErr(null); setDialog("import"); })}
          {item("Export JSON", exportJson)}
          <div className="sp-sep" />
          {item("Undo", undo, !canUndo, `${mod}Z`)}
          {item("Redo", redo, !canRedo, `${mod}⇧Z`)}
        </div>
      )}
      {dialog && (
        <div className="modal-back" onClick={() => setDialog(null)}>
          <div className="modal panel" style={{ width: "min(760px, 100%)" }} role="dialog" aria-label={dialog === "library" ? "Example library" : "Import system JSON"} onClick={(ev) => ev.stopPropagation()}>
            <div className="sp-head"><b>{dialog === "library" ? "Example library" : "Import system JSON"}</b><span className="ml-auto" /><Btn onClick={() => setDialog(null)} title="Close"><Icon name="x" size={14} /></Btn></div>
            {dialog === "library" ? (
              <div className="sp-lib">
                {LIBRARY.map((l) => (
                  <button key={l.key} className="sp-card" onClick={() => load(l.system, `Opened ${l.name}`)}>
                    <b>{l.name}</b><span>{l.note}</span><i>{l.system.equipment.length} pieces · {l.system.connectors.length} runs</i>
                  </button>
                ))}
              </div>
            ) : (
              <div className="sp-body">
                <div className="flex gap-2 items-center flex-wrap">
                  <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: "none" }} onChange={(ev) => { onFile(ev.target.files?.[0]); ev.target.value = ""; }} />
                  <Btn kind="primary-soft" onClick={() => fileRef.current?.click()}>Choose .json file</Btn>
                  <span className="text-faint text-[12px]">or paste the project JSON below</span>
                </div>
                <textarea className="code-area" rows={10} value={paste} onChange={(ev) => { setPaste(ev.target.value); setErr(null); }} placeholder='{"format":"power-equipment-studio-system","version":1, …}' aria-label="Project JSON" />
                {err && <div className="notice notice-crit">{err}</div>}
                <div className="flex gap-2"><Btn kind="primary" disabled={!paste.trim()} onClick={() => ingest(paste)}>Open pasted JSON</Btn><Btn onClick={() => setDialog(null)}>Cancel</Btn></div>
                <p className="text-faint text-[12px]">Opening a project replaces the current one. Use Undo to bring it back.</p>
              </div>
            )}
          </div>
        </div>
      )}
      {toast && <div className={cx("toast", toast.tone === "crit" && "toast-crit", toast.tone === "warn" && "sp-toast-warn")} role="status" onClick={() => setToast(null)}>{toast.text}</div>}
    </div>
  );
}
