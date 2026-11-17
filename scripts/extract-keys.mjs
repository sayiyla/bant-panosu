// Lists every translatable key (the English text passed to t()) found in web/*.js. Used to check translations-tr.js.
import fs from "node:fs";
const keys = new Set();
const STR = String.raw`"(?:[^"\\]|\\.)*"`;
for (const f of ["app", "command", "graph", "i18n"]) {
  const s = fs.readFileSync(new URL(`../web/${f}.js`, import.meta.url), "utf8");
  for (const m of s.matchAll(new RegExp(String.raw`\bt\(\s*(${STR})`, "g"))) keys.add(JSON.parse(m[1]));
  for (const m of s.matchAll(new RegExp(String.raw`\bt\(\s*[A-Za-z.]+\s*\?\s*(${STR})\s*:\s*(${STR})`, "g"))) { keys.add(JSON.parse(m[1])); keys.add(JSON.parse(m[2])); }
  for (const m of s.matchAll(new RegExp(String.raw`\bcount\([^,]+,\s*(${STR}),\s*(${STR})`, "g"))) { keys.add(JSON.parse(m[1])); keys.add(JSON.parse(m[2])); }
}
const list = [...keys].sort();
if (process.argv.includes("--check")) {
  const src = fs.readFileSync(new URL("../web/translations-tr.js", import.meta.url), "utf8");
  const dict = new Function("window", src + "; return window.PanoTranslations_TR;")({});
  const missing = list.filter((k) => dict[k] === undefined);
  const unused = Object.keys(dict).filter((k) => !keys.has(k));
  console.log(`keys: ${list.length}, missing in TR: ${missing.length}, unused in TR: ${unused.length}`);
  for (const k of missing) console.log("MISSING", JSON.stringify(k));
  for (const k of unused) console.log("UNUSED", JSON.stringify(k));
  process.exit(missing.length ? 1 : 0);
}
console.log(list.map((k) => JSON.stringify(k)).join("\n"));
