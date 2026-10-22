// Small helpers shared by the pecalc ports: Python-compatible repr/round and complex arithmetic.
// Complex numbers are plain {re, im} objects. Real numbers are accepted wherever a complex is expected.

export function pyRepr(x) {
  if (typeof x === "string") {
    const q = x.includes("'") && !x.includes('"') ? '"' : "'";
    return q + x.replace(/\\/g, "\\\\").replace(q === "'" ? /'/g : /"/g, "\\" + q) + q;
  }
  return String(x);
}

/**
 * Python round(x, n): round-half-to-even on the exact binary value. toFixed also works on the exact value but
 * sends exact ties upward, so a true tie is detected from the exact decimal expansion and rounded to even.
 */
export function pyRound(x, n = 0) {
  if (!Number.isFinite(x)) return x;
  if (Math.abs(x) < 1e15) {
    const ex = Math.abs(x).toFixed(Math.min(100, n + 30));
    const tail = ex.slice(ex.indexOf(".") + 1 + n);
    if (/^50*$/.test(tail)) {
      const lo = Math.floor(Math.abs(x) * 10 ** n);
      const even = lo % 2 === 0 ? lo : lo + 1;
      return Math.sign(x) * (n === 0 ? even : Number((even / 10 ** n).toFixed(n)));
    }
  }
  return Number(x.toFixed(n));
}

/** Python format(x, ".<n>f"): half-even on exact ties, "inf"/"nan" for non-finite values. */
export function pyFixed(x, n) {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  return pyRound(x, n).toFixed(n);
}

/** Python format(x, "g"): six significant digits, trailing zeros stripped. */
export function pyG(x) {
  if (x === 0) return "0";
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  const exp = Math.floor(Math.log10(Math.abs(Number(x.toPrecision(6)))));
  if (exp < -4 || exp >= 6) {
    const [m, e] = x.toExponential(5).split("e");
    const sign = e[0] === "-" ? "-" : "+";
    const digits = e.replace(/^[+-]/, "").padStart(2, "0");
    return `${m.replace(/0+$/, "").replace(/\.$/, "")}e${sign}${digits}`;
  }
  const s = x.toPrecision(6);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
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
