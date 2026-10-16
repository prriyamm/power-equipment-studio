/* "Calc package" button shared by every workspace: builds the printable calculation package (engine/report.js)
   and saves it as .html through the downloads capability, or shows it in a copy box when saving is unavailable. */
const { useState, useEffect } = React;
import { Btn, Icon, Field } from "./common.jsx";
import { buildReport } from "../engine/report.js";
import pkg from "../../package.json";

export const ENGINE_VERSION = pkg.version;

/* Serialise a rendered SVG element as standalone markup. The app styles drawings with CSS classes and variables,
   so the computed paint properties are copied onto each element; the result no longer needs the page stylesheet. */
const PAINT = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "stroke-opacity",
  "opacity", "font-family", "font-size", "font-weight", "text-anchor", "dominant-baseline", "display", "visibility", "font-variant-numeric"];

/* Deep clone of an SVG element with computed paint styles inlined and classes dropped. Elements marked
   data-noexport (chart crosshair, hover dots) are left out. */
function inlineClone(svg) {
  const clone = svg.cloneNode(true);
  const src = [svg, ...svg.querySelectorAll("*")], dst = [clone, ...clone.querySelectorAll("*")];
  src.forEach((el, i) => {
    const cs = getComputedStyle(el);
    const css = PAINT.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";");
    dst[i].setAttribute("style", css);
    dst[i].removeAttribute("class");
  });
  clone.querySelectorAll("[data-noexport]").forEach((n) => n.remove());
  clone.removeAttribute("class");
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return clone;
}

export function svgToString(svg) {
  if (!svg) return null;
  const clone = inlineClone(svg);
  const vb = svg.viewBox?.baseVal;
  if (vb && vb.width) { clone.setAttribute("width", String(vb.width)); clone.setAttribute("height", String(vb.height)); }
  clone.setAttribute("style", "max-width:100%;height:auto");
  return clone.outerHTML;
}

/* A report figure from a rendered chart: an <svg> (chart kit, drawings) or a canvas heatmap (.ck-heat), whose
   canvas becomes an embedded PNG <image> under its SVG overlay, with the colour bar below. */
export function figureSvg(el) {
  if (!el) return null;
  if (el.tagName?.toLowerCase() === "svg") return svgToString(el);
  const canvas = el.querySelector("canvas");
  if (!canvas) return svgToString(el.querySelector("svg"));
  const NS = "http://www.w3.org/2000/svg";
  const plot = canvas.getBoundingClientRect();
  const w = Math.round(plot.width || parseFloat(canvas.style.width) || canvas.width), h = Math.round(plot.height || parseFloat(canvas.style.height) || canvas.height);
  const bar = el.querySelector("svg.ck-colorbar");
  const bh = bar ? Number(bar.getAttribute("height")) + 8 : 0;
  const out = document.createElementNS(NS, "svg");
  out.setAttribute("xmlns", NS);
  out.setAttribute("viewBox", `0 0 ${w} ${h + bh}`);
  out.setAttribute("width", String(w)); out.setAttribute("height", String(h + bh));
  out.setAttribute("style", "max-width:100%;height:auto");
  let url = null;
  try { url = canvas.toDataURL("image/png"); } catch (e) { url = null; }
  if (url) {
    const im = document.createElementNS(NS, "image");
    im.setAttribute("href", url); im.setAttribute("width", String(w)); im.setAttribute("height", String(h));
    im.setAttribute("preserveAspectRatio", "none");
    out.appendChild(im);
  }
  const ov = el.querySelector("svg.ck-heat-overlay");
  if (ov) {
    const c = inlineClone(ov);
    c.setAttribute("x", "0"); c.setAttribute("y", "0"); c.setAttribute("width", String(w)); c.setAttribute("height", String(h));
    c.removeAttribute("style");
    out.appendChild(c);
  }
  if (bar) {
    const c = inlineClone(bar);
    c.setAttribute("x", "0"); c.setAttribute("y", String(h + 8)); c.removeAttribute("style");
    out.appendChild(c);
  }
  return out.outerHTML;
}

/* Every chart in `host` marked with data-report-fig="Title" (Chart reportTitle / Heatmap reportTitle), as
   buildReport() figures. Dark: the charts are drawn for the dark theme. */
export function reportFigures(host) {
  if (!host || typeof document === "undefined") return [];
  return [...host.querySelectorAll("[data-report-fig]")].map((el) => {
    let svg = null;
    try { svg = figureSvg(el); } catch (e) { svg = null; }
    return svg ? { title: el.getAttribute("data-report-fig"), svg, dark: true } : null;
  }).filter(Boolean);
}

const slug = (s) => String(s || "report").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "report";

/** getReport() returns the buildReport() options for the current workspace state (meta and version are added here). */
export function ReportButton({ getReport, filename, disabled }) {
  const [open, setOpen] = useState(false);
  const [downloads, setDownloads] = useState(null);
  const [form, setForm] = useState({ project: "", prepared: "", checked: "" });
  const [html, setHtml] = useState("");
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    let alive = true;
    try { window.claude?.use?.("downloads").then((d) => alive && setDownloads(d)).catch(() => {}); } catch (e) { /* not in a viewer */ }
    return () => { alive = false; };
  }, []);

  const make = () => {
    const o = getReport();
    return buildReport({ ...o, engineVersion: ENGINE_VERSION, meta: { ...(o.meta || {}), ...form, date: new Date().toISOString().slice(0, 10) } });
  };
  const show = () => { try { setHtml(make()); setMsg(null); } catch (e) { setHtml(""); setMsg({ crit: true, text: `Could not build the report: ${e.message}` }); } setOpen(true); };
  const name = `${slug(filename)}.html`;
  const copy = () => {
    try { navigator.clipboard.writeText(html).then(() => setMsg({ text: "HTML copied. Paste it into a .html file and open it in a browser." }), () => setMsg({ crit: true, text: "Clipboard blocked. Select the text and copy it manually." })); }
    catch (e) { setMsg({ crit: true, text: "Clipboard blocked. Select the text and copy it manually." }); }
  };
  const save = async () => {
    let text;
    try { text = make(); setHtml(text); } catch (e) { setMsg({ crit: true, text: `Could not build the report: ${e.message}` }); return; }
    try { await downloads.save({ filename: name, data: text }); setMsg({ text: `Saved ${name}. Open it and use Print to get a PDF.` }); }
    catch (e) { if (e?.code !== "declined") setMsg({ crit: true, text: `Could not save: ${e?.message || e?.code || "unknown error"}` }); }
  };
  const field = (k, label) => (
    <Field label={label}><input className="num-input" value={form[k]} onChange={(e) => setForm((s) => ({ ...s, [k]: e.target.value }))} /></Field>
  );
  return (
    <>
      <Btn onClick={show} disabled={disabled} title="Printable calculation package: inputs, results, checks, data status and sign-off block"><Icon name="save" size={14} />Calc package</Btn>
      {open && (
        <div className="modal-back" onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="modal panel" role="dialog" aria-label="Calculation package">
            <header className="flex items-start justify-between gap-3 p-4 border-b border-line">
              <div><div className="label">Calculation package</div><div className="text-[13px] text-muted">Standalone HTML. Open it in a browser and print to PDF.</div></div>
              <button className="row-x" onClick={() => setOpen(false)} aria-label="Close"><Icon name="x" /></button>
            </header>
            <div className="p-4 flex flex-col gap-3 overflow-auto">
              <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
                {field("project", "Project")}{field("prepared", "Prepared by")}{field("checked", "Checked by")}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {downloads && <Btn kind="primary" onClick={save}><Icon name="save" size={14} />Save {name}</Btn>}
                <Btn onClick={() => { try { setHtml(make()); setMsg(null); } catch (e) { setMsg({ crit: true, text: e.message }); } }}>Rebuild with these names</Btn>
                <Btn onClick={copy}><Icon name="copy" size={14} />Copy HTML</Btn>
              </div>
              {msg && <div className={`notice ${msg.crit ? "notice-crit" : "notice-info"}`}>{msg.text}</div>}
              {!downloads && <p className="text-faint text-[12px]">Saving files is not available here, so copy the HTML and paste it into a .html file.</p>}
              {!downloads && <textarea className="code-area" readOnly value={html} rows={12} style={{ width: "100%" }} onFocus={(e) => e.target.select()} />}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
