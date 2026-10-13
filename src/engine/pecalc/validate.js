// Shared input validation: every module raises the same messages. Port of pecalc/validate.py.
//
// Checks are applied where a value enters the engine (the module entry points
// and the shared solvers), so a bad value fails loudly instead of producing a
// silent NaN, a negative ampacity or a zero-division.
//
// Messages quote the value as Python's repr would for a float input (the type the
// pecalc dataclass fields declare): 0 -> "0.0", 480 -> "480.0", Infinity -> "inf",
// NaN -> "nan", a string -> 'quoted', null/undefined -> None.
import { pyRepr } from "./util.js";

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

// Python-style names alongside the camelCase ones.
export const power_factor = powerFactor;
export const clearing_time = clearingTime;
export const x_over_r = xOverR;
