/* Pure helpers for showing an engine check ({ name, value, limit, unit, passed, clause, note }) as value vs limit
   with a utilisation bar. No DOM: unit-tested in tests/charts.test.mjs. */

/* Direction of a check: "max" when the value must stay at or below the limit, "min" when it must reach it.
   Uses c.direction when the engine gives one, otherwise infers it from the pass flag. */
export function checkDirection(c) {
  if (c?.direction === "max" || c?.direction === "min") return c.direction;
  const v = Number(c?.value), l = Number(c?.limit);
  if (!Number.isFinite(v) || !Number.isFinite(l) || v === l) return "max";
  return !!c.passed === v <= l ? "max" : "min";
}

/* Utilisation of the limit (demand / capacity): 1 = at the limit, > 1 = beyond it. null when not measurable. */
export function checkUtilization(c) {
  const v = Number(c?.value), l = Number(c?.limit);
  if (typeof c?.value === "boolean" || typeof c?.limit === "boolean") return null;
  if (!Number.isFinite(v) || !Number.isFinite(l)) return null;
  const dir = checkDirection(c);
  if (dir === "max") return l > 0 && v >= 0 ? v / l : null;
  return v > 0 && l >= 0 ? l / v : null;
}

/* Fill fraction of a meter whose full width is `span` x the limit (the limit tick sits at 1 / span). */
export const meterFill = (u, span = 1.25) => (u == null ? 0 : Math.max(0, Math.min(1, u / span)));

/* Status tone for a utilisation: pass, warn from `warnAt`, fail above 1 (or when the check says it failed). */
export function utilTone(u, passed, warnAt = 0.9) {
  if (passed === false || (u != null && u > 1 + 1e-12)) return "fail";
  if (u != null && u >= warnAt) return "warn";
  return "pass";
}
