# Power Equipment Studio (web)

A browser version of Power Equipment Studio: an ETAP-style engineering workspace for
transformer, switchgear and cable bus packages, with modern equipment-level visuals.
It builds to **one self-contained HTML file** (`dist/index.html`) that runs with no backend.
That file is published as a Claude Artifact.

| Workspace | What it does |
|---|---|
| **System** | The package as equipment: isometric site plan, orbitable 3D model (procedural equipment, loading / bus-voltage / fault-current overlays), auto-generated one-line diagram. Live load flow, IEC 60909 short circuit, breaker switching with de-energized islands, switchgear lineup elevations and breaker schedules (NEC 240), arc-flash study (IEEE 1584-2018, PLACEHOLDER coefficients), project save/load, example library, undo/redo. |
| **Load flow** | Newton-Raphson bus model, one-line editor, data tables, results, scenarios and comparison, IEEE 14-bus self-test, Q-limits, N−1 screening, short circuit. Byte-compatible with the Python `loadflow` CLI. |
| **Cable bus** | Check and designer (port of pecalc): current sharing, table/datasheet/IEC 60287 ampacity, shield and enclosure losses, magnetic field map, fault forces, cross-section and iso enclosure view. |
| **Feeder & cable** | Feeder sizing with parallel sets, NEC 110.14(C)/215, voltage drop, withstand, lug selection. |
| **Switchgear bus** | Rac/Rdc and lamination sharing, temperature rise, short-circuit bracing, support span. |
| **Transformer** | Preliminary core-type design, impedance tuning, losses, DOE efficiency, fault withstand, core-and-coil drawing. |

## Develop

```
npm ci
npm test          # node --test, engine golden tests
npm run build     # -> dist/index.html
```

Open `dist/index.html` in a browser. React 18 and Tailwind load from CDNs; everything else is inline.

## Layout

```
src/engine/   pure ES modules, no DOM, no React. Each module has tests in tests/.
src/ui/       React components (JSX, global React UMD). One file per workspace.
src/head.html page head: title, fonts, design tokens, CSS.
scripts/      build.mjs (esbuild bundle -> dist/index.html), golden-vector generators.
tests/        node:test files; tests/golden/*.json are vectors generated from the Python engines.
```

## Sources of truth

- Load flow: mirrors the Python `loadflow` CLI. Same JSON case format, byte-compatible export,
  same result format as `loadflow case.json --out`.
- Equipment calculations: ported from `pecalc` in
  [power-equipment-engineering](https://github.com/prriyamm/power-equipment-engineering).
  Every ported function is checked against golden vectors produced by the Python code
  (`scripts/gen_golden_*.py`). Data tables keep their `VERIFIED` / `UNVERIFIED` / `PLACEHOLDER` status.

## Important

An engineering aid, not a substitute for a licensed professional engineer. Code-table data marked
UNVERIFIED must be checked against licensed copies of the codes before use.
