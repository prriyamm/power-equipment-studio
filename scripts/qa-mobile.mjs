#!/usr/bin/env node
/* Phone-width layout QA. Opens every workspace view of dist/index.html in headless Chromium at several
   widths and reports layout problems. Needs a browser, so it is NOT part of `npm run check`.

     npm run build
     node scripts/qa-mobile.mjs                      # 375, 390, 768 and 1440 px
     node scripts/qa-mobile.mjs --widths=375 --only=system,feeder --reports --verbose

   Playwright is not a project dependency. Install it anywhere (e.g. `npm i playwright-core` in a scratch
   directory) and point PLAYWRIGHT_MODULE at its folder, or have `playwright`/`playwright-core` resolvable.
   CHROME_PATH selects a Chromium binary (defaults to Playwright's own, then /usr/bin/chromium).

   Checks per view and width:
     overflow   no viewport meta, document.scrollingElement.scrollWidth > innerWidth, or a workspace scroll area (.main, .ws …)
                scrolls sideways: the page itself pans. Exit code 1 when any view overflows.
     offscreen  visible elements past the right edge that no scroll container clips (clipped controls)
     table      a table wider than its box with no overflow-x container of its own
     tap        buttons / inputs / tabs smaller than 40 px in either dimension (phone widths only)
     font       HTML text under 11 px (phone widths only); SVG text under 8 px after the drawing is scaled
     canvas     a 3D canvas whose size does not follow the viewport after a resize
     nav        the workspace nav must collapse to a menu button at phone width
   --reports also builds each workspace's printable calc package and checks it at the same widths. */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const WIDTHS = String(args.widths || "375,390,768,1440").split(",").map(Number);
const HEIGHT = { 375: 812, 390: 844, 768: 1024, 1440: 900 };
const PHONE = 640;
const only = args.only ? String(args.only).split(",") : null;
const file = resolve(root, args.file || "dist/index.html");
if (!existsSync(file)) { console.error(`${file} not found: run npm run build first`); process.exit(2); }

async function loadPlaywright() {
  const tries = [];
  if (process.env.PLAYWRIGHT_MODULE) tries.push(() => createRequire(resolve(process.env.PLAYWRIGHT_MODULE, "x.js"))("playwright-core"), () => createRequire(resolve(process.env.PLAYWRIGHT_MODULE, "x.js"))("playwright"));
  tries.push(() => import("playwright"), () => import("playwright-core"));
  for (const t of tries) { try { const m = await t(); return m.chromium ? m : m.default; } catch { /* next */ } }
  console.error("Playwright not found. Install it outside the repo (npm i playwright-core) and set PLAYWRIGHT_MODULE=<that dir>.");
  process.exit(2);
}

/* Views: [name, hash, optional click sequence of [selector, text]]. */
const VIEWS = [
  ["system/site", "system"],
  ["system/3d", "system-3d"],
  ["system/one-line", "system-sld"],
  ["system/schedule", "system-schedule"],
  ["system/tcc", "system-tcc"],
  ["system/lineup", "system-lineup"],
  ["loadflow/diagram", "loadflow"],
  ["loadflow/data", "loadflow", [[".tab", "Data"]]],
  ["loadflow/results", "loadflow", [[".tab", "Results"]]],
  ["loadflow/studies", "loadflow", [[".tab", "Studies"]]],
  ["loadflow/cases", "loadflow", [[".tab", "Cases"]]],
  ["cablebus/check", "cablebus"],
  ["cablebus/designer", "cablebus", [[".btn", "Designer"]]],
  ["feeder", "feeder"],
  ["switchgear", "switchgear"],
  ["transformer", "transformer"],
];
const REPORTS = ["system", "cablebus", "feeder", "switchgear", "transformer"]; // load flow has no calc package

/* Runs in the page. Returns the findings for the current view. */
function inspect({ phone, width }) {
  // pan/zoom canvases (site plan, load-flow diagram) have their own zoom controls: small text there is expected
  const PANZOOM = ".canvas-wrap:not(.sld-wrap)";
  // compare with the requested width: mobile emulation widens the layout viewport to fit overflowing content
  const vw = Math.min(innerWidth, width || innerWidth), out = { overflow: [], offscreen: [], table: [], tap: [], font: [], svgfont: [] };
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width === 0 && r.height === 0) return false; const cs = getComputedStyle(el); return cs.visibility !== "hidden" && cs.display !== "none" && el.offsetParent !== null || cs.position === "fixed"; };
  const desc = (el) => { const c = typeof el.className === "string" ? el.className : el.className?.baseVal || ""; const t = (el.innerText || el.textContent || el.getAttribute?.("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 28); return `${el.tagName.toLowerCase()}${c ? "." + c.trim().split(/\s+/).slice(0, 2).join(".") : ""}${t ? ` "${t}"` : ""}`; };
  const sc = document.scrollingElement;
  if (!document.querySelector('meta[name="viewport"]')) out.overflow.push("no <meta name=viewport>: phones lay the page out at 980 px and zoom out");
  if (sc.scrollWidth > vw + 1 || innerWidth > vw + 1) out.overflow.push(`page scrollWidth ${sc.scrollWidth} > ${vw} (layout viewport ${innerWidth})`);
  for (const el of document.querySelectorAll(".shell-main, .ws-host, .ws, .main, .inspector")) {
    if (!vis(el)) continue;
    const ox = getComputedStyle(el).overflowX;
    if (ox !== "hidden" && ox !== "clip" && el.scrollWidth > el.clientWidth + 1) out.overflow.push(`${desc(el).split(" ")[0]} scrolls sideways ${el.scrollWidth} > ${el.clientWidth}`);
  }
  // clipped scroller = ancestor that scrolls/clips horizontally and itself fits the viewport
  const clippedBy = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const ox = getComputedStyle(p).overflowX; if (ox !== "visible") { if (/^(auto|scroll)$/.test(ox) && p.matches(".shell-main, .ws-host, .ws, .main, .inspector")) return null; const r = p.getBoundingClientRect(); return r.right <= vw + 1 ? p : null; } } return null; };
  const seen = new Set();
  for (const el of document.querySelectorAll("body *")) {
    if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.right <= vw + 1 || !vis(el)) continue;
    if ([...seen].some((s) => s.contains(el))) continue;
    if (clippedBy(el)) continue;
    seen.add(el); out.offscreen.push(`${desc(el)} right=${Math.round(r.right)}`);
  }
  for (const t of document.querySelectorAll("table")) {
    if (!vis(t)) continue;
    let ok = false;
    for (let p = t.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (/^(auto|scroll)$/.test(ox)) { ok = !p.matches(".shell-main, .ws-host, .ws, .main, .inspector"); break; }
    }
    if (!ok && t.getBoundingClientRect().width > t.parentElement.getBoundingClientRect().width + 1) out.table.push(desc(t.closest("section") || t).slice(0, 60));
  }
  if (phone) {
    for (const el of document.querySelectorAll("button, a[href], select, input:not([type=hidden]), textarea, [role=tab], summary")) {
      if (!vis(el) || el.closest(".modal-back[hidden]")) continue;
      let r = el.getBoundingClientRect();
      if (/checkbox|radio/.test(el.type)) { const l = el.closest("label"); if (l) r = l.getBoundingClientRect(); }
      if (r.height < 40 || r.width < 40) out.tap.push(`${desc(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) {
    const el = n.parentElement; if (!el || !n.textContent.trim() || !vis(el)) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    const svg = el.closest("svg");
    if (svg) { const m = svg.getScreenCTM?.(); const eff = fs * (m ? Math.hypot(m.a, m.b) : 1); if (eff < 8 && !svg.closest(PANZOOM)) out.svgfont.push(`${desc(svg).split(" ")[0]} "${n.textContent.trim().slice(0, 12)}" ${eff.toFixed(1)}px`); }
    else if (phone && fs < 11 && !el.closest("sub, sup")) out.font.push(`${desc(el).slice(0, 40)} ${fs}px`);
  }
  out.nav = (() => { const rail = document.querySelector(".rail"); if (!rail) return "no nav"; const menuBtn = document.querySelector(".rail-menu-btn"); const mvis = menuBtn && menuBtn.getBoundingClientRect().width > 0; return phone && !mvis ? "nav does not collapse to a menu" : null; })();
  return out;
}

async function canvasCheck(page) {
  return page.evaluate(() => [...document.querySelectorAll("canvas")].filter((c) => c.offsetParent).map((c) => {
    const r = c.getBoundingClientRect(), p = c.parentElement.getBoundingClientRect();
    const dpr = devicePixelRatio, bw = c.width / dpr;
    const bad = r.right > innerWidth + 1 || Math.abs(r.width - p.width) > 4 || Math.abs(bw - r.width) > 4;
    return bad ? `canvas ${Math.round(r.width)}px (buffer ${Math.round(bw)}px) in ${Math.round(p.width)}px box` : null;
  }).filter(Boolean));
}

const pw = await loadPlaywright();
const exe = process.env.CHROME_PATH || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
const browser = await pw.chromium.launch({ executablePath: exe, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const url = pathToFileURL(file).href;
const rows = [];
let failed = false;

async function openView(page, hash, clicks) {
  await page.goto("about:blank"); // a hash-only change would not remount the app
  await page.goto(`${url}#${hash}`, { waitUntil: "load" });
  await page.waitForSelector(".ws", { timeout: 20000 });
  for (const [sel, text] of clicks || []) await page.locator(`.ws-host:not([hidden]) ${sel}`, { hasText: text }).first().click();
  await page.waitForTimeout(700);
}

for (const width of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width, height: HEIGHT[width] || 900 }, deviceScaleFactor: 1, isMobile: width <= PHONE, hasTouch: width <= PHONE });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`  [${width}] page error: ${e.message}`));
  for (const [name, hash, clicks] of VIEWS) {
    if (only && !only.some((o) => name.startsWith(o))) continue;
    await openView(page, hash, clicks);
    const f = await page.evaluate(inspect, { phone: width <= PHONE, width });
    if (name.endsWith("3d") || name === "cablebus/check" || name === "switchgear") {
      await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(400);
      await page.setViewportSize({ width, height: HEIGHT[width] || 900 }); await page.waitForTimeout(600);
      f.canvas = await canvasCheck(page);
    }
    if (args.shots) await page.screenshot({ path: resolve(String(args.shots), `${name.replace("/", "_")}-${width}.png`), fullPage: false });
    if (f.overflow.length) failed = true;
    rows.push({ width, name, ...f });
  }
  if (args.reports) for (const key of REPORTS) {
    if (only && !only.some((o) => key.startsWith(o))) continue;
    await openView(page, key);
    const btn = page.locator(".btn", { hasText: "Calc package" }).first();
    if (!(await btn.count()) || (await btn.isDisabled())) { rows.push({ width, name: `report/${key}`, error: "no Calc package button" }); continue; }
    await btn.click(); await page.waitForTimeout(400);
    const modal = await page.evaluate(inspect, { phone: width <= PHONE, width });
    rows.push({ width, name: `report-dialog/${key}`, ...modal });
    const html = await page.locator("textarea.code-area").first().inputValue().catch(() => "");
    if (!html) { rows.push({ width, name: `report/${key}`, error: "no report HTML" }); continue; }
    const rp = await ctx.newPage(); await rp.setContent(html, { waitUntil: "load" });
    const f = await rp.evaluate(inspect, { phone: false, width }); f.nav = null; f.tap = [];
    if (args.shots) await rp.screenshot({ path: resolve(String(args.shots), `report_${key}-${width}.png`), fullPage: true });
    await rp.close();
    if (f.overflow.length) failed = true;
    rows.push({ width, name: `report/${key}`, ...f });
  }
  await ctx.close();
}
await browser.close();

const n = (a) => (a && a.length ? a.length : 0);
console.log(`\n${"view".padEnd(26)} ${"width".padStart(5)}  overflow offscreen table  tap  font svgfont canvas nav`);
for (const r of rows) {
  if (r.error) { console.log(`${r.name.padEnd(26)} ${String(r.width).padStart(5)}  ${r.error}`); continue; }
  console.log(`${r.name.padEnd(26)} ${String(r.width).padStart(5)}  ${String(n(r.overflow)).padStart(8)} ${String(n(r.offscreen)).padStart(9)} ${String(n(r.table)).padStart(5)} ${String(n(r.tap)).padStart(4)} ${String(n(r.font)).padStart(5)} ${String(n(r.svgfont)).padStart(7)} ${String(n(r.canvas)).padStart(6)} ${r.nav ? "FAIL" : "ok"}`);
  if (args.verbose) for (const k of ["overflow", "offscreen", "table", "tap", "font", "svgfont", "canvas"]) if (n(r[k])) console.log(`    ${k}: ${[...new Set(r[k])].slice(0, 8).join(" | ")}${r[k].length > 8 ? ` (+${r[k].length - 8})` : ""}`);
}
if (args.json) console.log(JSON.stringify(rows, null, 1));
console.log(failed ? "\nFAIL: horizontal page scroll in at least one view" : "\nOK: no horizontal page scroll");
process.exit(failed ? 1 : 0);
