// Bundle src/ into dist/index.html: one self-contained page (React/Tailwind from CDN, everything else inline).
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const out = await build({
  entryPoints: ["src/main.jsx"], bundle: true, format: "iife", target: "es2020",
  write: false, minify: process.argv.includes("--minify"), legalComments: "none",
  loader: { ".jsx": "jsx", ".json": "json" }, logLevel: "warning",
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const head = readFileSync("src/head.html", "utf8");
const html = `${head}<script>\n${js}</script>\n`;
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
if (Buffer.byteLength(html) > 15 * 1024 * 1024) throw new Error(`dist/index.html is ${kb} KB, over the 16 MB artifact limit`);
console.log(`dist/index.html  ${kb} KB`);
