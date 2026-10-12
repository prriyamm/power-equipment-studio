import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildReport, sha256Hex, canonicalJson, inputHash, escapeHtml, kvRows, checkRows } from "../src/engine/report.js";

const base = () => ({
  title: "Cable bus <A&B>", module: "cablebus", subtitle: "15 kV",
  inputs: [{ label: "Current", value: 2000, unit: "A" }, { label: "Size", value: "750", unit: "kcmil" }],
  results: [{ label: "Voltage drop", value: 0.4321987, unit: "%" }],
  checks: [
    { name: "Ampacity", value: 90, limit: 100, unit: "%", pass: true, clause: "NEC 310" },
    { name: "Drop", value: 4, limit: 3, unit: "%", pass: false, clause: "NEC 215", note: "too long" },
  ],
  tables: [{ title: "Schedule", columns: ["Tag", "kA"], rows: [["A", 1.5]] }],
  figures: [{ title: "Section", svg: "<svg id='fig1'><rect/></svg>" }],
  notes: ["note one"], dataStatus: [{ table: "NEC 310.16", status: "VERIFIED", source: "book" }],
  meta: { project: "P1", prepared: "A. Eng", checked: "B", approved: "C", date: "2026-01-01" }, engineVersion: "9.9.9",
});

test("sha256 vectors match node crypto", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  for (const s of ["a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(1000), "café Ω \u{1F600}"]) {
    assert.equal(sha256Hex(s), createHash("sha256").update(s, "utf8").digest("hex"), s.slice(0, 10));
  }
});

test("canonical json sorts keys; hash is order independent", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  assert.equal(inputHash([{ label: "x", value: 1 }]), inputHash([{ value: 1, label: "x" }]));
  assert.notEqual(inputHash([{ label: "x", value: 1 }]), inputHash([{ label: "x", value: 2 }]));
});

test("escapes all text", () => {
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  const html = buildReport({ ...base(), title: "<script>alert(1)</script>", notes: ["<img src=x onerror=1>"],
    inputs: [{ label: "<b>l</b>", value: "<i>", unit: "&" }], meta: { project: '"><x>' } });
  assert.ok(!html.includes("<script>alert"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes("<b>l</b>"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
});

test("structure: sections, hash, version, signature block, inline svg", () => {
  const html = buildReport(base());
  assert.match(html, /^<!doctype html>/i);
  for (const s of ["<h2>Inputs</h2>", "<h2>Results</h2>", "<h2>Checks</h2>", "<h2>Notes</h2>", "<h2>Data status</h2>", "<h2>Sign-off</h2>"]) assert.ok(html.includes(s), s);
  assert.ok(html.includes(inputHash(base().inputs)));
  assert.ok(html.includes("9.9.9"));
  assert.ok(html.includes("<svg id='fig1'><rect/></svg>"));
  assert.ok(html.includes("Prepared by") && html.includes("Checked by") && html.includes("Approved"));
  assert.ok(html.includes("A. Eng"));
  assert.ok(html.includes("@page"));
  assert.ok(html.includes('<td class="pass">PASS</td>') && html.includes('<td class="fail">FAIL</td>'));
  assert.ok(html.includes("RESULT: FAIL - 1 of 2"));
  assert.ok(html.includes("0.432199"));
});

test("all-pass banner", () => {
  const b = base(); b.checks = [b.checks[0]];
  assert.ok(buildReport(b).includes("RESULT: PASS - all 1 checks pass"));
});

test("data-status warning box appears only when needed", () => {
  assert.ok(!buildReport(base()).includes('class="warn"'));
  const b = base(); b.dataStatus = [{ table: "NEC 310.16", status: "UNVERIFIED", source: "from memory" }];
  const html = buildReport(b);
  assert.ok(html.includes('class="warn"') && html.includes("UNVERIFIED") && html.includes("from memory"));
  const c = base(); c.checks[0].clause = "UL 891 [limit UNVERIFIED]";
  assert.ok(buildReport(c).includes('class="warn"'));
  const d = base(); d.dataStatus = [{ table: "CEC", status: "PLACEHOLDER" }];
  assert.ok(buildReport(d).includes("PLACEHOLDER"));
});

test("adapters and empty input", () => {
  assert.deepEqual(kvRows({ a_b: 1, n: null, o: {} }, { a_b: "A" }), [{ label: "a b", value: 1, unit: "A" }]);
  assert.equal(checkRows([{ name: "x", passed: false }])[0].pass, false);
  assert.match(buildReport({}), /no pass\/fail checks/);
});
