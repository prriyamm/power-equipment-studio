/* Application shell: workspace rail + the active workspace. Workspaces stay mounted
   once opened so their in-memory state survives switching. */
const { useState, useEffect } = React;
import { cx, Pill } from "./common.jsx";
import { WORKSPACES } from "./workspaces.jsx";
import { QualityMenu } from "./qualityMenu.jsx";

export function App() {
  const [active, setActive] = useState(() => {
    // deep link: a bare #token naming a workspace (e.g. #transformer) opens it
    const h = (typeof location !== "undefined" ? location.hash : "").slice(1).split("-")[0];
    return WORKSPACES.some((w) => w.key === h) ? h : WORKSPACES.find((w) => w.default)?.key || WORKSPACES[0].key;
  });
  const [opened, setOpened] = useState(() => new Set([active]));
  // phone width: the rail collapses to a top bar with a menu button (head.html .rail-* rules)
  const [menu, setMenu] = useState(false);
  const open = (k) => { setActive(k); setOpened((s) => new Set(s).add(k)); setMenu(false); };
  useEffect(() => {
    if (!menu) return;
    const k = (e) => e.key === "Escape" && setMenu(false);
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [menu]);
  const current = WORKSPACES.find((w) => w.key === active);
  return (
    <div className="shell">
      <nav className={cx("rail", menu && "is-open")} aria-label="Workspaces">
        <div className="rail-brand" title="Power Equipment Studio">
          <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h18M3 17h18M8 7v10M16 7v10" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" fill="none" /></svg>
        </div>
        <div className="rail-current" aria-hidden="true">{current?.title}</div>
        <button className="rail-menu-btn" aria-expanded={menu} aria-controls="rail-list" aria-label={menu ? "Close workspace menu" : "Open workspace menu"} onClick={() => setMenu(!menu)}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><path d={menu ? "M6 6l12 12M18 6L6 18" : "M4 7h16M4 12h16M4 17h16"} /></svg>
        </button>
        <div className="rail-list" id="rail-list">
          {WORKSPACES.map((w) => (
            <button key={w.key} className={cx("rail-btn", active === w.key && "is-active", !w.Component && "is-planned")} onClick={() => open(w.key)} title={w.title} aria-current={active === w.key ? "page" : undefined}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={w.icon} /></svg>
              <span className="rail-short">{w.short}</span>
              <span className="rail-long">{w.title}</span>
            </button>
          ))}
        </div>
        <QualityMenu />
        {menu && <div className="rail-scrim" onClick={() => setMenu(false)} />}
      </nav>
      <div className="shell-main">
        {WORKSPACES.map((w) => opened.has(w.key) && (
          <div key={w.key} className="ws-host" hidden={active !== w.key}>
            {w.Component ? <w.Component goTo={open} /> : <Planned w={w} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function Planned({ w }) {
  return (
    <div className="p-6 overflow-auto h-full">
      <div className="panel p-6 max-w-2xl flex flex-col gap-3">
        <div className="flex items-center gap-3"><h2 className="text-lg">{w.title}</h2><Pill>Planned</Pill></div>
        <p className="text-muted leading-relaxed">{w.detail}</p>
      </div>
    </div>
  );
}
