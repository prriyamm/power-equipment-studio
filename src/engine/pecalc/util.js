// Small helpers shared by the pecalc ports: Python-compatible repr/round and complex arithmetic.
// Complex numbers are plain {re, im} objects. Real numbers are accepted wherever a complex is expected.

export function pyRepr(x) {
  if (typeof x === "string") {
    const q = x.includes("'") && !x.includes('"') ? '"' : "'";
    return q + x.replace(/\\/g, "\\\\").replace(q === "'" ? /'/g : /"/g, "\\" + q) + q;
  }
  return String(x);
}

/** Python round(x, n): round-half-to-even on exact ties. */
export function pyRound(x, n = 0) {
  const p = 10 ** n;
  const s = x * p;
  const fl = Math.floor(s);
  if (s - fl === 0.5 && s / p === x) return (fl % 2 === 0 ? fl : fl + 1) / p;
  return Number(x.toFixed(n));
}

/** Python format(x, ".<n>f"): half-even on exact ties, "inf"/"nan" for non-finite values. */
export function pyFixed(x, n) {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  return pyRound(x, n).toFixed(n);
}

export const C = (re, im = 0) => ({ re, im });
export const toC = (z) => (typeof z === "number" ? { re: z, im: 0 } : z);
export const cabs = (z) => Math.hypot(z.re, z.im);
export const cadd = (a, b) => ({ re: a.re + b.re, im: a.im + b.im });
export const csub = (a, b) => ({ re: a.re - b.re, im: a.im - b.im });
export const cmul = (a, b) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
export const cscale = (a, k) => ({ re: a.re * k, im: a.im * k });
export const cpolar = (r, phi) => ({ re: r * Math.cos(phi), im: r * Math.sin(phi) });

/** Complex division using Smith's algorithm (the same scaling CPython uses). */
export function cdiv(a, b) {
  const abr = Math.abs(b.re), abi = Math.abs(b.im);
  if (abr >= abi) {
    if (abr === 0) throw new Error("complex division by zero");
    const ratio = b.im / b.re, denom = b.re + b.im * ratio;
    return { re: (a.re + a.im * ratio) / denom, im: (a.im - a.re * ratio) / denom };
  }
  const ratio = b.re / b.im, denom = b.re * ratio + b.im;
  return { re: (a.re * ratio + a.im) / denom, im: (a.im * ratio - a.re) / denom };
}

export class KeyError extends Error {
  constructor(key) { super(pyRepr(key)); this.name = "KeyError"; }
}
/** obj[key] that throws KeyError like a Python dict lookup. */
export function lookup(obj, key) {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) throw new KeyError(key);
  return obj[key];
}
