# Working in Power Equipment Studio (power-equipment-studio)

- Standards scope: US and Canadian standards only (e.g. IEEE, ANSI, NEC/NFPA, UL, CSA, CEC, NEMA). Do not add
  or cite IEC, BS, EN, or other regional standards, tables, or conventions. Existing exception: methods already
  ported from pecalc that follow IEC (60909 short circuit, 60287 ampacity, 60228, 60076-5, 60865) stay as they
  are, because the ports must match pecalc; do not extend them. Tracked as O25 in `docs/engine-review-2026-10.md`.
- Keep `AGENTS.md` in sync: whenever this file changes, apply the same change to `AGENTS.md` in the same commit.
- One self-contained HTML output. No runtime network fetches, no localStorage dependency. Allowed CDNs only
  (cdnjs, jsdelivr, unpkg, cdn.tailwindcss.com; stylesheets and fonts from Google Fonts). React is the global UMD build: write `const { useState } = React;`, never `import React`.
- `src/engine/` is pure: no DOM, no React, no globals. Export named functions. Every module gets tests:
  `tests/<module>.test.mjs`, or for `pecalc/` ports the shared golden-vector suites (`pecalc-core`, `feeder`,
  `cablebus`, `switchgear`, `transformer`).
- Ports of Python `pecalc` (`calculations/pecalc` in prriyamm/power-equipment-engineering) must match the Python
  output. Generate vectors with a script in `scripts/` that imports pecalc, commit the JSON to `tests/golden/`,
  and assert with a relative tolerance of 1e-9 unless the Python uses iterative solvers (then 1e-6).
  Keep names close to the Python (snake_case fields in result objects, camelCase JS functions).
- Data tables: copy JSON as-is including `_meta` status. Never upgrade a status. Statuses in use: VERIFIED,
  UNVERIFIED, PLACEHOLDER, DERIVED, and for catalogue data MANUFACTURER (vendor datasheet) and EMPTY (no rows yet);
  anything other than VERIFIED is shown as not verified.
- Never hard-code a product rating; ratings are inputs.
- Workflow: branch `feat/<topic>` (or `fix/<topic>`), `npm run check` must pass, open a PR against `main`, keep it focused.
  Do NOT commit `dist/index.html` in feature PRs (parallel PRs conflict on it); the maintainer rebuilds `dist/`
  on `main` after each merge and publishes it to the artifact.
- Workspace UI files keep their own CSS: put a `const CSS = \`...\`` string in the workspace file and render
  `<style>{CSS}</style>` inside the component, prefixing classes with the workspace name (e.g. `.cb-…`).
  Only touch `src/head.html` for new shared design tokens.
- Cross-workspace hand-off uses `src/ui/bus.js` (`bus.on(topic, fn)` / `bus.emit(topic, msg)`).
- Deep link for screenshots: `dist/index.html#<workspace-key>` opens that workspace.
- No private material: nothing from Notion, customers, pricing, or personal paths in tracked files.
- UI: design tokens live in `src/head.html` `:root`. Reuse primitives from `src/ui/common.jsx`
  (Btn, Pill, Section, Field, NumField, Tile, Icon). Tables use `.grid-table`, panels `.panel`.
