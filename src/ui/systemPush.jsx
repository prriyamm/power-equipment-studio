/* "Apply to System": pushes a module design (Feeder, Cable bus, Switchgear, Transformer) back onto the
   linked System element. The System workspace publishes its model on the bus ("system:model", retained);
   this control maps the design with engine/designPush.js, shows the old → new diff, and on confirm asks
   the System to apply it ("system:apply") as one undoable step. */
const { useState, useEffect, useMemo } = React;
import { Btn, Icon, cx } from "./common.jsx";
import { bus } from "./bus.js";
import { planPush, pushTargets, PUSH_MODULES, STUDY_LABELS } from "../engine/designPush.js";

const CSS = `
.ps-wrap { display: flex; align-items: center; gap: 6px; }
.ps-target { width: 190px; max-width: 42vw; }
.ps-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.ps-body { padding: 14px; display: flex; flex-direction: column; gap: 10px; overflow: auto; }
.ps-diff td.ps-old { color: var(--muted); }
.ps-diff tr.ps-same td { color: var(--faint); }
.ps-diff tr.ps-chg td.ps-new { color: var(--accent); font-weight: 600; }
.ps-diff td.ps-arrow { color: var(--faint); text-align: center; }
.ps-foot { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.ps-toast { display: flex; align-items: center; gap: 10px; }
.ps-toast button { color: var(--accent); font-weight: 500; }
@media (max-width: 640px) { .ps-target { width: 130px; } }
`;

/** The current System model, or null until the System workspace has mounted. */
export function useSystemModel() {
  const [m, setM] = useState(() => bus.peek("system:model") || null);
  useEffect(() => bus.on("system:model", setM), []);
  return m;
}

const show = (v) => (v === null || v === undefined ? "—" : typeof v === "number" ? String(Math.round(v * 1000) / 1000) : String(v));
const key = (t) => (t ? `${t.kind}:${t.id}` : "");

/**
 * module: "feeder" | "cablebus" | "switchgear" | "transformer"
 * design: the design object from the engine builders, or null; designError explains a null design
 * link / setLink: the linked System element { kind, id } (set when the module is opened from the System)
 */
export function PushToSystem({ module, design, designError, link, setLink, goTo }) {
  const model = useSystemModel();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState(null);
  const [toast, setToast] = useState(null);
  const label = PUSH_MODULES[module].label;
  const targets = useMemo(() => (model ? pushTargets(model.sys, module) : []), [model, module]);
  const found = link && targets.some((t) => key(t) === key(link));
  const plan = useMemo(() => (open && model && design ? planPush(model.sys, link, design) : null), [open, model, link, design]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 5000); return () => clearTimeout(t); }, [toast]);

  const why = !model ? "Open the System workspace first" : !link ? `Pick the System ${PUSH_MODULES[module].element === "con" ? "run" : "equipment"} this design belongs to` : !design ? designError || "No design to apply" : null;
  const apply = () => {
    let res = null;
    bus.emit("system:apply", { module, target: link, design, reply: (r) => { res = r; } });
    if (!res) { setErr("The System workspace did not answer. Open it and try again."); return; }
    if (!res.ok) { setErr(res.errors.join(" ")); return; }
    setOpen(false); setErr(null);
    setToast(`Applied to System · ${res.plan.target.id}: ${res.plan.changed} change${res.plan.changed === 1 ? "" : "s"}. Undo it in the System workspace.`);
  };

  return (
    <div className="ps-wrap">
      <style>{CSS}</style>
      <select id={`ps-${module}-target`} className="num-input ps-target" value={key(link)} aria-label="System target"
        title={model ? "System element this design is linked to" : "Open the System workspace to link a target"}
        onChange={(ev) => { const t = targets.find((x) => key(x) === ev.target.value); setLink(t ? { kind: t.kind, id: t.id } : null); }}>
        <option value="">{model ? "System target…" : "No System model"}</option>
        {targets.map((t) => <option key={key(t)} value={key(t)}>{t.label}</option>)}
        {link && !found && <option value={key(link)}>{link.id} (not in System)</option>}
      </select>
      <Btn kind="primary-soft" disabled={!!why} title={why || `Preview the changes to ${link.id}`} onClick={() => { setErr(null); setOpen(true); }}>
        <Icon name="save" size={14} />Apply to System
      </Btn>
      {open && (
        <div className="modal-back" onClick={() => setOpen(false)}>
          <div className="modal panel" style={{ width: "min(640px, 100%)" }} role="dialog" aria-label="Apply design to System" onClick={(ev) => ev.stopPropagation()}>
            <div className="ps-head"><b>Apply {label} design to {link?.id}</b><span className="ml-auto" /><Btn onClick={() => setOpen(false)} title="Close"><Icon name="x" size={14} /></Btn></div>
            <div className="ps-body">
              {!plan ? <div className="notice notice-crit">{why || "Nothing to apply."}</div> : <>
                {plan.errors.length > 0 && <div className="notice notice-crit"><b>Rejected.</b> {plan.errors.join(" ")}</div>}
                {plan.ok && (
                  <div className="table-wrap"><table className="grid-table ps-diff">
                    <thead><tr><th>Field</th><th className="r">System now</th><th /><th className="r">This design</th></tr></thead>
                    <tbody>{plan.diff.map((r) => (
                      <tr key={r.field} className={r.changed ? "ps-chg" : "ps-same"}>
                        <td style={{ fontFamily: "var(--font-ui)" }}>{r.label}{r.unit && <span className="text-faint"> ({r.unit})</span>}</td>
                        <td className="r ps-old">{show(r.old)}</td><td className="ps-arrow">{r.changed ? "→" : "="}</td><td className="r ps-new">{show(r.new)}</td>
                      </tr>
                    ))}</tbody>
                  </table></div>
                )}
                {plan.ok && plan.notes.map((n, i) => <div key={"n" + i} className="notice notice-info">{n}</div>)}
                {plan.warnings.map((w, i) => <div key={i} className="notice notice-warn">{w}</div>)}
                {plan.ok && (plan.changed === 0
                  ? <p className="text-muted text-[12.5px]">{link.id} already matches this design.</p>
                  : <p className="text-muted text-[12.5px]">{plan.changed} field{plan.changed === 1 ? "" : "s"} change in one undoable step. Afterwards {plan.stale.map((s) => STUDY_LABELS[s].toLowerCase()).join(", ")} are marked stale until they re-run on the new model.</p>)}
              </>}
              {err && <div className="notice notice-crit">{err}</div>}
              <div className="ps-foot">
                <Btn kind="primary" disabled={!plan?.ok || plan.changed === 0} onClick={apply}>Apply {plan?.changed || ""} change{plan?.changed === 1 ? "" : "s"}</Btn>
                <Btn onClick={() => setOpen(false)}>Cancel</Btn>
              </div>
            </div>
          </div>
        </div>
      )}
      {toast && <div className={cx("toast", "ps-toast")} role="status"><span>{toast}</span>{goTo && <button type="button" onClick={() => { setToast(null); goTo("system"); }}>Open System</button>}</div>}
    </div>
  );
}
