/* Graphics quality control for the rail footer: Auto / Low / Medium / High plus an Animations switch.
   State lives in ./quality.js (persisted when storage works); the 3D viewers subscribe to it directly.
   Accessible menu button: Enter / Space / ArrowDown opens, arrows + Home / End move, Escape closes. */
const { useState, useRef, useEffect, useLayoutEffect } = React;
import { quality, useQuality, MODES } from "./quality.js";

const CSS = `
.qm { margin-top: auto; padding-top: 6px; }
.qm-btn { display: flex; flex-direction: column; align-items: center; gap: 2px; width: 100%; padding: 7px 2px; border-radius: var(--r-md); color: var(--muted); font-size: 10px; letter-spacing: 0.02em; }
.qm-btn:hover, .qm-btn[aria-expanded="true"] { color: var(--fg); background: var(--panel-2); }
.qm-btn:focus-visible, .qm-menu [role^="menuitem"]:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.qm-tier { font-family: var(--font-data); font-size: 10px; color: var(--faint); }
.menu.qm-menu { position: fixed; top: auto; left: auto; z-index: 60; min-width: 220px; }
.qm-head { padding: 6px 10px 4px; font-size: 12px; color: var(--fg); font-weight: 600; }
.qm-why { padding: 0 10px 6px; font-size: 11px; color: var(--faint); max-width: 240px; line-height: 1.35; }
.qm-menu [role^="menuitem"] { display: flex; align-items: center; gap: 8px; }
.qm-check { width: 14px; flex: none; color: var(--accent); text-align: center; }
.qm-hint { margin-left: auto; font-size: 11px; color: var(--faint); }
.qm-sep { height: 1px; background: var(--line); margin: 4px 2px; }
/* the global Animations switch also stops the SVG flow dashes */
.gfx-no-anim .flow { animation: none !important; }
@media (max-width: 640px) {
  .qm { margin: 0; padding: 0; }
  .qm-btn { width: 44px; height: 44px; justify-content: center; padding: 0; }
  .qm-btn .qm-lbl, .qm-btn .qm-tier { display: none; }
}
`;

const NAME = { auto: "Auto", low: "Low", medium: "Medium", high: "High" };
const SHORT = { low: "low", medium: "med", high: "high" };
const HINT = { low: "fastest", medium: "balanced", high: "best look" };

export const graphicsLabel = (q) => `Graphics: ${q.mode === "auto" ? `Auto (${NAME[q.tier]})` : NAME[q.tier]}`;

export function QualityMenu() {
  const q = useQuality();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null), menuRef = useRef(null), focusFirst = useRef(false);

  const items = () => [...(menuRef.current?.querySelectorAll('[role^="menuitem"]') || [])];
  const close = (refocus) => { setOpen(false); if (refocus) btnRef.current?.focus(); };
  const openMenu = (focus) => {
    const r = btnRef.current.getBoundingClientRect();
    // beside the rail when there is room (desktop), otherwise under the button (phone top bar)
    setPos(r.right + 250 < window.innerWidth && r.top > 60
      ? { left: r.right + 6, bottom: Math.max(8, window.innerHeight - r.bottom) }
      : { top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    focusFirst.current = focus;
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open || !focusFirst.current) return;
    const list = items();
    (list.find((el) => el.getAttribute("aria-checked") === "true") || list[0])?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (!menuRef.current?.contains(e.target) && !btnRef.current?.contains(e.target)) close(false); };
    const onResize = () => close(false);
    document.addEventListener("pointerdown", onDown); window.addEventListener("resize", onResize);
    return () => { document.removeEventListener("pointerdown", onDown); window.removeEventListener("resize", onResize); };
  }, [open]);

  const onBtnKey = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); openMenu(true); }
  };
  const onMenuKey = (e) => {
    const list = items(), i = list.indexOf(document.activeElement);
    const go = (k) => { e.preventDefault(); list[(k + list.length) % list.length]?.focus(); };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
    else if (e.key === "Escape") { e.preventDefault(); close(true); }
    else if (e.key === "Tab") close(false);
  };

  const label = graphicsLabel(q);
  const why = quality.detection().reasons.join(", ");
  return (
    <div className="qm">
      <style>{CSS}</style>
      <button ref={btnRef} type="button" className="qm-btn" aria-haspopup="menu" aria-expanded={open} aria-controls="qm-menu"
        aria-label={`${label}, animations ${q.animations ? "on" : "off"}`} title={label}
        onClick={(e) => (open ? close(false) : openMenu(e.detail === 0))} onKeyDown={onBtnKey}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5" />
        </svg>
        <span className="qm-lbl">Graphics</span>
        <span className="qm-tier">{q.mode === "auto" ? `auto·${SHORT[q.tier]}` : SHORT[q.tier]}</span>
      </button>
      {open && (
        <div ref={menuRef} id="qm-menu" className="menu qm-menu" role="menu" aria-label="Graphics quality" style={pos || undefined} onKeyDown={onMenuKey}>
          <div className="qm-head" aria-hidden="true">{label}</div>
          <div className="qm-why" aria-hidden="true">Auto detected {NAME[q.autoTier]}: {why}</div>
          {MODES.map((m) => (
            <button key={m} type="button" role="menuitemradio" aria-checked={q.mode === m} tabIndex={-1}
              onClick={() => { quality.set({ mode: m }); close(true); }}>
              <span className="qm-check" aria-hidden="true">{q.mode === m ? "●" : ""}</span>
              {m === "auto" ? `Auto (${NAME[q.autoTier]})` : NAME[m]}
              <span className="qm-hint">{HINT[m] || "detected"}</span>
            </button>
          ))}
          <div className="qm-sep" role="separator" />
          <button type="button" role="menuitemcheckbox" aria-checked={q.animations} tabIndex={-1}
            onClick={() => quality.set({ animations: !q.animations })}>
            <span className="qm-check" aria-hidden="true">{q.animations ? "✓" : ""}</span>
            Animations
            <span className="qm-hint">{q.reducedMotion ? "reduced motion" : ""}</span>
          </button>
        </div>
      )}
    </div>
  );
}
