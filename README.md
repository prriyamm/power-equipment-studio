# Power Equipment Studio (web)

A browser version of Power Equipment Studio: an ETAP-style engineering workspace for
transformer, switchgear and cable bus packages, with modern equipment-level visuals.
It builds to **one self-contained HTML file** (`dist/index.html`) that runs with no backend.
That file is published as a Claude Artifact.

| Workspace | Status |
|---|---|
| Load flow: Newton-Raphson, one-line diagram, data tables, results, scenarios, IEEE 14-bus self-test | Ready |
| System view: transformers → switchgear → cable bus → loads, drawn as equipment | In progress |
| Cable bus, feeder & cable, switchgear bus, transformer design | Porting from `pecalc` |

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
