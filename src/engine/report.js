// Printable calculation package: one standalone, print-oriented HTML document.
// Pure: no DOM, no crypto.subtle (SHA-256 is implemented below so it runs in node and in the browser alike).
// Mirrors the structure of pecalc/report.py: header block with engine version and input hash, result banner,
// data-status warnings, inputs, results, checks with clauses, notes and a Prepared / Checked / Approved block.
// The header also carries the pecalc table-data fingerprint (pecalc/datainfo.py data_fingerprint), so a report shows
// which table data produced it.
import { PECALC_VERSION, PECALC_DATA_FINGERPRINT } from "./pecalc/datainfo.js";

/* ------------------------------------------------------------------ text helpers */
export function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Display form of a value: finite numbers to 6 significant digits without trailing zeros. */
export function fmtValue(v) {
  if (v === null || v === undefined || v === "") return "-";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "n/a";
    if (!Number.isFinite(v)) return v > 0 ? "∞" : "-∞";
    return String(Number(v.toPrecision(6)));
  }
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

/* ------------------------------------------------------------------ SHA-256 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
  0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
  0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
  0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function utf8(str) {
  const out = [];
  for (const ch of String(str)) {
    let c = ch.codePointAt(0);
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd; // lone surrogate
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** SHA-256 of a string (UTF-8), lower-case hex. */
export function sha256Hex(str) {
  const bytes = utf8(str);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
  for (const w of [hi, lo]) bytes.push((w >>> 24) & 255, (w >>> 16) & 255, (w >>> 8) & 255, w & 255);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < bytes.length; o += 64) {
    for (let t = 0; t < 16; t++) W[t] = (bytes[o + 4 * t] << 24) | (bytes[o + 4 * t + 1] << 16) | (bytes[o + 4 * t + 2] << 8) | bytes[o + 4 * t + 3];
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return Array.from(H, (x) => x.toString(16).padStart(8, "0")).join("");
}

/** JSON with sorted object keys, so equal inputs always hash equally. Non-finite numbers become strings. */
export function canonicalJson(v) {
  if (v === undefined) return "null";
  if (typeof v === "number" && !Number.isFinite(v)) return JSON.stringify(String(v));
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
}

export const inputHash = (inputs) => sha256Hex(canonicalJson(inputs ?? []));

/* ------------------------------------------------------------------ adapters for workspaces */
/** Flatten a plain object to [{label, value, unit}] rows ("kva_rating" -> "kva rating"); skips null and nested values. */
export function kvRows(obj, units = {}) {
  return Object.entries(obj || {})
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object" && typeof v !== "function")
    .map(([k, v]) => ({ label: k.replace(/_/g, " "), value: v, unit: units[k] ?? "" }));
}

/** Engine check objects ({name, value, limit, unit, passed, clause, note}) to the report check shape. */
export const checkRows = (checks) => (checks || []).map((c) => ({
  name: c.name, value: c.value, limit: c.limit, unit: c.unit, pass: c.pass ?? c.passed, clause: c.clause, note: c.note,
}));

/* ------------------------------------------------------------------ document */
const CSS = `
@page{size:A4;margin:20mm 14mm 18mm}
*{box-sizing:border-box}
html{background:#e9ecef}
body{font:12.5px/1.45 -apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#1b1f23;background:#fff;
max-width:210mm;margin:16px auto;padding:14mm 14mm 16mm;box-shadow:0 1px 6px rgba(0,0,0,.18)}
h1{font-size:21px;line-height:1.2;margin:0 0 2px;letter-spacing:-.01em}
.sub{color:#555;margin:0 0 10px;font-size:13px}
h2{font-size:13.5px;text-transform:uppercase;letter-spacing:.06em;color:#243b53;margin:20px 0 6px;padding-bottom:3px;border-bottom:1.5px solid #243b53;break-after:avoid}
h3{font-size:12.5px;margin:12px 0 4px;break-after:avoid}
table{border-collapse:collapse;width:100%;margin:4px 0 2px;font-variant-numeric:tabular-nums}
th,td{border:1px solid #cfd4d9;padding:3px 6px;text-align:left;vertical-align:top}
th{background:#eef1f4;font-weight:600;font-size:11.5px}
td.n,th.n{text-align:right}
td.u{color:#555;white-space:nowrap;width:9%}
th.k{font-weight:500;width:26%}table.kv:not(.two) th.k{width:42%}
tr{break-inside:avoid}
.meta th{width:18%;background:#f6f7f9;font-weight:600}
.meta td{width:32%}
.banner{padding:8px 12px;border-radius:4px;font-weight:700;margin:12px 0;border:1px solid}
.banner.pass{background:#e7f5ec;color:#14532d;border-color:#86c79c}
.banner.fail{background:#fdeaea;color:#7f1d1d;border-color:#e39a9a}
.banner.none{background:#f1f3f5;color:#444;border-color:#c9ced3}
.warn{border:2px solid #d97706;background:#fff4dc;color:#5c3b00;border-radius:4px;padding:9px 12px;margin:12px 0;break-inside:avoid}
.warn b.t{display:block;font-size:13px;margin-bottom:3px;text-transform:uppercase;letter-spacing:.04em}
.warn ul{margin:4px 0 0;padding-left:18px}
td.pass{background:#d9f0e1;color:#14532d;font-weight:700;text-align:center}
td.fail{background:#f8d4d4;color:#7f1d1d;font-weight:700;text-align:center}
td.na{background:#eef1f4;color:#555;text-align:center}
.clause{color:#444;font-size:11.5px}.note{color:#666;font-size:11px;display:block}
.fig{margin:8px 0;break-inside:avoid}.fig svg{max-width:100%;height:auto;display:block}
.fig.dark{background:#0a0f14;border-radius:4px;padding:6px}
.fig .cap{font-size:11.5px;color:#555;margin-bottom:3px}
.hash{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;word-break:break-all}
ul.notes{margin:4px 0;padding-left:18px}ul.notes li{margin:2px 0}
.sign td{height:44px}.sign th{width:33.3%}.sign td.d{height:22px;color:#555;font-size:11px}
.small{color:#555;font-size:11px;margin-top:14px}
.run-head,.run-foot{display:flex;justify-content:space-between;gap:12px;font-size:10.5px;color:#555}
.run-head{border-bottom:1px solid #cfd4d9;padding-bottom:4px;margin-bottom:10px}
.run-foot{border-top:1px solid #cfd4d9;padding-top:4px;margin-top:18px}
@media print{
html{background:#fff}
body{margin:0;padding:0;max-width:none;box-shadow:none;font-size:11.5px}
.run-head{position:fixed;top:-14mm;left:0;right:0;margin:0}
.run-foot{position:fixed;bottom:-13mm;left:0;right:0;margin:0}
.fig.dark,.banner,.warn,td.pass,td.fail,th{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
.tw{overflow-x:auto;max-width:100%;margin:4px 0 2px}.tw>table{margin:0}
/* phone screens: no paper margin, 16 px gutter, tables scroll inside .tw, drawings keep a readable width */
@media screen and (max-width:640px){
html{background:#fff}
body{margin:0;padding:16px;max-width:none;box-shadow:none;font-size:13px}
.run-head,.run-foot{flex-direction:column;gap:2px;font-size:11px}
.hash,.small,.note,.sign td.d{font-size:11px}
.fig{overflow-x:auto}.fig svg{max-width:none;min-width:600px}
}
@media print{.tw{overflow:visible}}
@page{@bottom-right{content:"Page " counter(page) " of " counter(pages);font:9px sans-serif;color:#666}}
`;

const E = escapeHtml;
const isBad = (s) => String(s ?? "").trim().toUpperCase() !== "VERIFIED";

/* Wide tables scroll inside their own box on a phone screen, never the page. */
const tw = (table) => `<div class="tw">${table}</div>`;

function pairTable(rows) {
  if (!rows?.length) return "<p class='small'>None.</p>";
  const cell = (r) => (r ? `<th class="k">${E(r.label)}</th><td class="n">${E(fmtValue(r.value))}</td><td class="u">${E(r.unit ?? "")}</td>` : "<td></td><td></td><td></td>");
  // Long lists run two columns of label / value / unit so the package stays compact.
  const two = rows.length > 8, half = Math.ceil(rows.length / 2), out = [];
  for (let k = 0; k < (two ? half : rows.length); k++) out.push(`<tr>${cell(rows[k])}${two ? cell(rows[half + k]) : ""}</tr>`);
  return tw(`<table class="kv${two ? " two" : ""}"><tbody>${out.join("")}</tbody></table>`);
}

function dataTable(t) {
  const cols = t.columns || [];
  const head = cols.length ? "<thead><tr>" + cols.map((c) => `<th>${E(c)}</th>`).join("") + "</tr></thead>" : "";
  const body = (t.rows || []).map((r) => "<tr>" + r.map((c) => `<td${typeof c === "number" ? ' class="n"' : ""}>${E(fmtValue(c))}</td>`).join("") + "</tr>").join("");
  return (t.title ? `<h3>${E(t.title)}</h3>` : "") + tw(`<table>${head}<tbody>${body}</tbody></table>`);
}

function checksTable(checks) {
  const rows = checks.map((c) => {
    const unit = c.unit ? " " + E(c.unit) : "";
    const res = c.pass === undefined || c.pass === null ? '<td class="na">-</td>' : c.pass ? '<td class="pass">PASS</td>' : '<td class="fail">FAIL</td>';
    return `<tr>${res}<td>${E(c.name)}${c.note ? `<span class="note">${E(c.note)}</span>` : ""}</td>` +
      `<td class="n">${E(fmtValue(c.value))}${unit}</td><td class="n">${E(fmtValue(c.limit))}${unit}</td><td class="clause">${E(c.clause ?? "")}</td></tr>`;
  });
  return tw("<table><thead><tr><th style='width:56px'>Result</th><th>Check</th><th class='n'>Value</th><th class='n'>Limit</th><th>Basis</th></tr></thead><tbody>" + rows.join("") + "</tbody></table>");
}

/**
 * Build the calculation package.
 * @param {object} o {title, module, subtitle, inputs, results, checks, tables, figures, notes, dataStatus, meta, engineVersion, dataFingerprint, pecalcVersion}
 * @returns {string} complete HTML document
 */
export function buildReport(o = {}) {
  const inputs = o.inputs || [], results = o.results || [], checks = o.checks || [], tables = o.tables || [];
  const figures = o.figures || [], notes = o.notes || [], dataStatus = o.dataStatus || [], meta = o.meta || {};
  const title = o.title || "Calculation package";
  const version = o.engineVersion ?? o.version ?? "unknown";
  const hash = inputHash(inputs);

  const judged = checks.filter((c) => c.pass !== undefined && c.pass !== null);
  const failed = judged.filter((c) => !c.pass).length;
  const banner = !judged.length ? ["none", "RESULT: no pass/fail checks in this package"]
    : failed ? ["fail", `RESULT: FAIL - ${failed} of ${judged.length} checks fail`] : ["pass", `RESULT: PASS - all ${judged.length} checks pass`];

  // Data-status warning: any table not VERIFIED, plus any UNVERIFIED / PLACEHOLDER marker in notes or check clauses.
  const flagged = dataStatus.filter((d) => isBad(d.status));
  const markers = new Set();
  for (const t of [...notes, ...checks.flatMap((c) => [c.clause, c.note])]) {
    for (const w of ["UNVERIFIED", "PLACEHOLDER"]) if (String(t ?? "").includes(w)) markers.add(w);
  }
  flagged.forEach((d) => markers.add(String(d.status || "UNKNOWN").toUpperCase()));
  let warn = "";
  if (flagged.length || markers.size) {
    const items = flagged.map((d) => `<li><b>${E(d.table)}</b>: ${E(d.status || "UNKNOWN")}${d.source ? ` - ${E(d.source)}` : ""}</li>`).join("");
    warn = `<div class="warn" role="alert"><b class="t">Data status warning: ${E([...markers].join(" / "))}</b>` +
      "This calculation uses data or methods that are not marked VERIFIED. Check them against the licensed code or standard before relying on the result." +
      (items ? `<ul>${items}</ul>` : "") + "</div>";
  }

  const date = meta.date || "-";
  const head = `<div class="run-head"><span>${E(meta.project || "-")} / ${E(title)}</span><span>${E(o.module || "")} / input hash ${E(hash.slice(0, 12))}</span></div>`;
  const foot = `<div class="run-foot"><span>Engineering aid. Not valid until reviewed and approved by a licensed professional engineer.</span><span>Power Equipment Studio ${E(version)} / ${E(date)}</span></div>`;

  const parts = [
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${E(title)} - calculation package</title><style>${CSS}</style></head><body>`,
    head,
    `<h1>${E(title)}</h1>`,
    o.subtitle ? `<p class="sub">${E(o.subtitle)}</p>` : "",
    tw(`<table class="meta"><tbody>` +
      `<tr><th>Project</th><td>${E(meta.project || "-")}</td><th>Date</th><td>${E(date)}</td></tr>` +
      `<tr><th>Module</th><td>${E(o.module || "-")}</td><th>Engine version</th><td>Power Equipment Studio ${E(version)}</td></tr>` +
      `<tr><th>Input hash</th><td colspan="3" class="hash">SHA-256 ${E(hash)}</td></tr>` +
      `<tr><th>Table data</th><td class="hash">${E(o.dataFingerprint ?? PECALC_DATA_FINGERPRINT)}</td><th>pecalc</th><td>${E(o.pecalcVersion ?? PECALC_VERSION)}</td></tr></tbody></table>`),
    `<div class="banner ${banner[0]}">${E(banner[1])}</div>`,
    warn,
  ];
  if (inputs.length) parts.push("<h2>Inputs</h2>", pairTable(inputs));
  if (results.length) parts.push("<h2>Results</h2>", pairTable(results));
  tables.forEach((t) => parts.push(dataTable(t)));
  if (checks.length) parts.push("<h2>Checks</h2>", checksTable(checks));
  figures.forEach((f) => parts.push(`<div class="fig${f.dark ? " dark" : ""}">${f.title ? `<div class="cap">${E(f.title)}</div>` : ""}${f.svg}</div>`));
  if (dataStatus.length) {
    parts.push("<h2>Data status</h2>", dataTable({ columns: ["Table", "Status", "Source"], rows: dataStatus.map((d) => [d.table, d.status, d.source ?? ""]) }));
  }
  if (notes.length) parts.push("<h2>Notes</h2><ul class='notes'>" + notes.map((n) => `<li>${E(n)}</li>`).join("") + "</ul>");
  parts.push(
    "<h2>Sign-off</h2>",
    tw("<table class='sign'><thead><tr><th>Prepared by</th><th>Checked by</th><th>Approved (P.Eng. / PE seal)</th></tr></thead><tbody>" +
      `<tr><td>${E(meta.prepared || "")}</td><td>${E(meta.checked || "")}</td><td>${E(meta.approved || "")}</td></tr>` +
      "<tr><td class='d'>Signature / date:</td><td class='d'>Signature / date:</td><td class='d'>Signature / date:</td></tr></tbody></table>"),
    "<p class='small'>Generated by Power Equipment Studio, an engineering aid. Results must be reviewed and approved by a licensed professional engineer before use in design, certification or construction.</p>",
    foot,
    "</body></html>",
  );
  return parts.join("\n");
}
