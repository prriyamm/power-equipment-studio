// Shared input validation: every module raises the same messages. Port of pecalc/validate.py.
//
// Checks are applied where a value enters the engine (the module entry points
// and the shared solvers), so a bad value fails loudly instead of producing a
// silent NaN, a negative ampacity or a zero-division.
//
// Messages quote the value as Python's repr would for a float input (the type the
// pecalc dataclass fields declare): 0 -> "0.0", 480 -> "480.0", Infinity -> "inf",
// NaN -> "nan", a string -> 'quoted', null/undefined -> None.
import { pyRepr, pyG } from "./util.js";

/** repr() of a value as Python would print it, assuming numbers are floats. */
export function reprValue(value) {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
    if (Number.isInteger(value) && Math.abs(value) < 1e16) return value.toFixed(1);
    return String(value);
  }
  if (typeof value === "string") return pyRepr(value);
  return String(value);
}

// Python float(str): optional sign, decimal / exponent forms, inf / infinity / nan, surrounding whitespace.
const FLOAT_RE = /^[+-]?((\d[\d_]*(\.[\d_]*)?|\.\d[\d_]*)([eE][+-]?\d+)?|inf|infinity|nan)$/i;

function toFloat(value) {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const s = value.trim();
    if (FLOAT_RE.test(s)) {
      const t = s.toLowerCase().replace(/_/g, "");
      if (t.endsWith("nan")) return NaN;
      if (t.endsWith("inf") || t.endsWith("infinity")) return t.startsWith("-") ? -Infinity : Infinity;
      return Number(t);
    }
  }
  return undefined;
}

function finite(name, value) {
  const v = toFloat(value);
  if (v === undefined) throw new Error(`${name} must be a number, got ${reprValue(value)}`);
  if (!Number.isFinite(v)) throw new Error(`${name} must be finite, got ${reprValue(value)}`);
  return v;
}

/** Voltage must be > 0 V. */
export function voltage(name, value) {
  const v = finite(name, value);
  if (v <= 0) throw new Error(`${name} must be greater than 0 V, got ${reprValue(value)}`);
  return v;
}

/** Power factor magnitude must be in (0, 1]; leading/lagging is a separate flag. */
export function powerFactor(name, value) {
  const v = finite(name, value);
  if (!(v > 0 && v <= 1)) throw new Error(`${name} must be in the range (0, 1], got ${reprValue(value)}`);
  return v;
}

/** Fault clearing / duration time must be > 0 s. */
export function clearingTime(name, value) {
  const v = finite(name, value);
  if (v <= 0) throw new Error(`${name} must be greater than 0 s, got ${reprValue(value)}`);
  return v;
}

/** X/R ratio must be > 0. */
export function xOverR(name, value) {
  const v = finite(name, value);
  if (v <= 0) throw new Error(`${name} must be greater than 0, got ${reprValue(value)}`);
  return v;
}

/** repr() of a value for fields the Python declares as int: whole numbers print without ".0". */
function reprInt(value) {
  return typeof value === "number" && Number.isInteger(value) ? String(value) : reprValue(value);
}

/** Whole-number count (conductors per phase, tiers) that must be >= minimum. */
export function countAtLeast(name, value, minimum = 1) {
  const v = finite(name, value);
  if (v !== Math.trunc(v) || v < minimum) {
    throw new Error(`${name} must be a whole number of at least ${minimum}, got ${reprInt(value)}`);
  }
  return Math.trunc(v);
}

/** Value must be finite and >= 0. */
export function nonNegative(name, value, unit = "") {
  const v = finite(name, value);
  if (v < 0) throw new Error(`${name} must be 0${unit ? " " + unit : ""} or greater, got ${reprValue(value)}`);
  return v;
}

/** Value must be finite and > 0. */
export function positive(name, value, unit = "") {
  const v = finite(name, value);
  if (v <= 0) throw new Error(`${name} must be greater than 0${unit ? " " + unit : ""}, got ${reprValue(value)}`);
  return v;
}

/** Value must be finite and within [low, high]. */
export function inRange(name, value, low, high, unit = "") {
  const v = finite(name, value);
  if (!(low <= v && v <= high)) {
    throw new Error(`${name} must be in the range [${pyG(low)}, ${pyG(high)}]${unit ? " " + unit : ""}, got ${reprValue(value)}`);
  }
  return v;
}

/** Value must be an integer (not bool, not a fractional float) >= minimum. */
export function integerAtLeast(name, value, minimum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value !== Math.trunc(value)) {
    throw new Error(`${name} must be a whole number, got ${reprInt(value)}`);
  }
  if (value < minimum) throw new Error(`${name} must be ${minimum} or greater, got ${reprInt(value)}`);
  return value;
}

/** Value must be one of the allowed choices (repr of the choices as a Python tuple). */
export function oneOf(name, value, allowed) {
  if (typeof value === "boolean" || !allowed.includes(value)) {
    throw new Error(`${name} must be one of (${allowed.map(reprInt).join(", ")}), got ${reprInt(value)}`);
  }
  return value;
}

// Python-style names alongside the camelCase ones.
export const power_factor = powerFactor;
export const clearing_time = clearingTime;
export const x_over_r = xOverR;
export const count_at_least = countAtLeast;
export const non_negative = nonNegative;
export const in_range = inRange;
export const integer_at_least = integerAtLeast;
export const one_of = oneOf;
