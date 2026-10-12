# Working in power-studio-web

- One self-contained HTML output. No runtime network fetches, no localStorage dependency. Allowed CDNs only
  (cdnjs, jsdelivr, unpkg, cdn.tailwindcss.com). React is the global UMD build: write `const { useState } = React;`, never `import React`.
- `src/engine/` is pure: no DOM, no React, no globals. Export named functions. Every module gets `tests/<module>.test.mjs`.
- Ports of Python `pecalc` (~/Projects/power-equipment-engineering/calculations/pecalc) must match the Python
  output. Generate vectors with a script in `scripts/` that imports pecalc, commit the JSON to `tests/golden/`,
  and assert with a relative tolerance of 1e-9 unless the Python uses iterative solvers (then 1e-6).
  Keep names close to the Python (snake_case fields in result objects, camelCase JS functions).
- Data tables: copy JSON as-is including `_meta` status. Never upgrade a status.
- Never hard-code a product rating; ratings are inputs.
- Workflow: branch `feat/<topic>`, `npm run check` must pass, open a PR against `main`, keep it focused.
  Rebuild and commit `dist/index.html` in the PR so `main` always holds the publishable artifact.
- No private material: nothing from Notion, customers, pricing, or personal paths in tracked files.
- UI: design tokens live in `src/head.html` `:root`. Reuse primitives from `src/ui/common.jsx`
  (Btn, Pill, Section, Field, NumField, Tile, Icon). Tables use `.grid-table`, panels `.panel`.
