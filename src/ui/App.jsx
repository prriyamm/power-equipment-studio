/* Application shell: workspace rail + the active workspace. Workspaces stay mounted
   once opened so their in-memory state survives switching. */
const { useState } = React;
import { cx, Pill } from "./common.jsx";
import { WORKSPACES } from "./workspaces.jsx";

export function App() {
  const [active, setActive] = useState(WORKSPACES.find((w) => w.default)?.key || WORKSPACES[0].key);
  const [opened, setOpened] = useState(() => new Set([active]));
  const open = (k) => { setActive(k); setOpened((s) => new Set(s).add(k)); };
  return (
    <div className="shell">
      <nav className="rail" aria-label="Workspaces">
        <div className="rail-brand" title="Power Equipment Studio">
          <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h18M3 17h18M8 7v10M16 7v10" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" fill="none" /></svg>
        </div>
        {WORKSPACES.map((w) => (
          <button key={w.key} className={cx("rail-btn", active === w.key && "is-active", !w.Component && "is-planned")} onClick={() => open(w.key)} title={w.title}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={w.icon} /></svg>
            <span>{w.short}</span>
          </button>
        ))}
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
