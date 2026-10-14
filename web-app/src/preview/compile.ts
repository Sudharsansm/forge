// Compiles an app INSIDE the Forge window, like Claude Artifacts: no server, no npm, no files on disk.
// Every source file is tagged (data-forge-src) so elements can be selected, transpiled with Sucrase (TypeScript + JSX to plain JS),
// and everything - the app's modules, the libraries it imports, Tailwind - is inlined into ONE html document for the preview iframe.
import { parse } from "@babel/parser";
import MagicString from "magic-string";
import { transform } from "sucrase";
import { INSPECTOR_CLIENT } from "./inspector-client";
import { LIB_ALIASES, LIB_CHUNKS, TAILWIND_BROWSER } from "./generated";
import { URL_SHIM } from "./shim";

export type CompileResult = { ok: boolean; html?: string; error?: string };

const CODE = /\.(tsx|jsx|ts|js|mjs)$/i;
const ALWAYS = ["react", "react/jsx-runtime", "react-dom", "react-dom/client"];
export const AVAILABLE_PACKAGES = ["react", "react-dom", "react-router-dom", "lucide-react", "recharts", "clsx", "framer-motion"];

const esc = (s: string) => s.replace(/<\/script/gi, "<\\/script");
const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.?\//, "");

type Node = { type: string; name?: { type: string; name: string; end: number }; loc: { start: { line: number; column: number } }; [k: string]: unknown };
function walk(node: unknown, visit: (n: Node) => void): void {
  if (!node || typeof (node as Node).type !== "string") return;
  visit(node as Node);
  for (const key of Object.keys(node as object)) {
    if (key === "loc" || key === "extra") continue;
    const v = (node as Record<string, unknown>)[key];
    if (Array.isArray(v)) v.forEach((c) => walk(c, visit));
    else if (v && typeof v === "object") walk(v, visit);
  }
}

/** Adds data-forge-src="path:line:col" to every host element (<div>, <h1>, ...), where col is the 0-based column of the "<". */
export function tagSource(code: string, path: string): string {
  const isTs = /\.tsx?$/i.test(path);
  const ast = parse(code, { sourceType: "module", errorRecovery: false, plugins: path.endsWith(".ts") ? ["typescript"] : isTs ? ["jsx", "typescript"] : ["jsx"] });
  const s = new MagicString(code);
  let changed = false;
  walk(ast.program, (node) => {
    if (node.type !== "JSXOpeningElement") return;
    const name = node.name;
    if (!name || name.type !== "JSXIdentifier" || !/^[a-z]/.test(name.name)) return; // host elements only
    s.appendLeft(name.end, ` data-forge-src="${path}:${node.loc.start.line}:${node.loc.start.column}"`);
    changed = true;
  });
  return changed ? s.toString() : code;
}

const bareImports = (code: string): string[] => {
  const out = new Set<string>();
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'./][^"']*)["']/g;
  for (let m = re.exec(code); m; m = re.exec(code)) out.add(m[1]);
  return [...out];
};

const libName = (spec: string): string => {
  if (LIB_CHUNKS[spec]) return spec;
  const alias = LIB_ALIASES[spec];
  return alias ?? spec;
};

// The tiny module system that runs in the preview: relative imports resolve to the project's files, bare imports to the libraries above.
const RUNTIME = `
(function(){
var mods={},cache={},libs=window.__forgeLibs||{},AV=${JSON.stringify(AVAILABLE_PACKAGES)},ALIAS=${JSON.stringify(LIB_ALIASES)};
window.__d=function(id,fn){mods[id]=fn};
var EXT=['','.tsx','.ts','.jsx','.js','.mjs','.json','.css','.svg','/index.tsx','/index.ts','/index.jsx','/index.js'];
function join(from,spec){var base=spec.charAt(0)==='/'?[]:from.split('/').slice(0,-1),parts=base.concat(spec.split('/')),out=[];
for(var i=0;i<parts.length;i++){var p=parts[i];if(p===''||p==='.')continue;if(p==='..')out.pop();else out.push(p)}return out.join('/')}
function load(id,from){var fn=mods[id];if(!fn)throw new Error('Cannot find module '+id+(from?' (imported from '+from+')':''));
if(cache[id])return cache[id].exports;var module={exports:{}};cache[id]=module;
fn.call(module.exports,module,module.exports,function(s){return req(id,s)});return module.exports}
function req(from,spec){
if(spec.charAt(0)==='.'||spec.charAt(0)==='/'){var base=join(from,spec);
for(var i=0;i<EXT.length;i++){if(mods[base+EXT[i]])return load(base+EXT[i],from)}
throw new Error('Cannot find '+spec+' (imported from '+from+')')}
var name=ALIAS[spec]||spec;
if(libs[name])return libs[name];
throw new Error('The package "'+spec+'" is not available in the Forge preview. Available: '+AV.join(', ')+'.')}
window.__forgeRun=function(entry){return load(entry,'')};
})();`;

export function compileProject(files: Record<string, string>): CompileResult {
  const paths = Object.keys(files).map(norm);
  const get = (p: string) => files[p] ?? files["./" + p];
  const codeFiles = paths.filter((p) => CODE.test(p) && !/\.d\.ts$/.test(p));
  if (codeFiles.length === 0) return { ok: false, error: "There are no code files yet. Write src/App.tsx with a default-exported React component." };

  let entry = ["src/main.tsx", "src/main.jsx", "src/main.ts", "src/main.js", "src/index.tsx", "src/index.jsx", "main.tsx", "index.tsx"].find((p) => paths.includes(p));
  const app = ["src/App.tsx", "src/App.jsx", "src/App.ts", "src/App.js", "App.tsx", "App.jsx"].find((p) => paths.includes(p));
  const modules: string[] = [];
  const used = new Set<string>(ALWAYS);
  const unknown = new Set<string>();

  try {
    for (const path of codeFiles) {
      const src = get(path) ?? "";
      let tagged: string;
      try {
        tagged = tagSource(src, path);
      } catch (e) {
        const err = e as { loc?: { line: number; column: number }; message?: string };
        return { ok: false, error: `${path}${err.loc ? `:${err.loc.line}:${err.loc.column + 1}` : ""}  ${String(err.message ?? e).replace(/\s*\(\d+:\d+\)$/, "")}` };
      }
      let out: string;
      try {
        out = transform(tagged, { transforms: [...(/\.tsx?$/i.test(path) ? ["typescript" as const] : []), "jsx", "imports"], jsxRuntime: "automatic", production: true, filePath: path }).code;
      } catch (e) {
        return { ok: false, error: `${path}  ${String((e as Error).message ?? e)}` };
      }
      for (const spec of bareImports(src)) {
        const lib = libName(spec);
        if (LIB_CHUNKS[lib]) used.add(lib); else unknown.add(spec);
      }
      modules.push(`__d(${JSON.stringify(path)},function(module,exports,require){${out}\n});`);
    }
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }

  if (!entry) {
    if (!app) return { ok: false, error: "Write src/App.tsx with a default-exported React component: that is the entry of the app." };
    entry = "__forge_entry__.tsx";
    modules.push(`__d("__forge_entry__.tsx",function(module,exports,require){"use strict";var R=require("react"),D=require("react-dom/client"),A=require(${JSON.stringify("./" + app)});` +
      `var C=A.default||A.App;if(!C)throw new Error(${JSON.stringify(app + " must default-export the App component")});` +
      `D.createRoot(document.getElementById("root")).render(R.createElement(C));});`);
  }

  // data modules: JSON and SVG files can be imported; stylesheets are applied globally (below), importing them is a no-op
  for (const p of paths) {
    if (p.endsWith(".json")) modules.push(`__d(${JSON.stringify(p)},function(module){module.exports=JSON.parse(${JSON.stringify(get(p) ?? "null")});});`);
    else if (p.endsWith(".svg")) modules.push(`__d(${JSON.stringify(p)},function(module,exports){exports.__esModule=true;exports.default=${JSON.stringify("data:image/svg+xml;charset=utf-8," + encodeURIComponent(get(p) ?? ""))};});`);
    else if (p.endsWith(".css")) modules.push(`__d(${JSON.stringify(p)},function(){});`);
  }

  let css = paths.filter((p) => p.endsWith(".css")).sort((a, b) => (a.includes("index") ? -1 : 0) - (b.includes("index") ? -1 : 0)).map((p) => get(p) ?? "").join("\n");
  if (!/@import\s+["']tailwindcss/.test(css)) css = `@import "tailwindcss";\n` + css;

  const libScripts = ALWAYS.concat([...used].filter((l) => !ALWAYS.includes(l))).map((l) => `<script>${esc(LIB_CHUNKS[l])}</script>`).join("\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<script>${esc(URL_SHIM)}</script>` +
    `<script>${esc(TAILWIND_BROWSER)}</script>` +
    `<style type="text/tailwindcss">${css.replace(/<\/style/gi, "<\\/style")}</style></head>` +
    `<body><div id="root"></div>\n${libScripts}\n<script>${esc(RUNTIME)}</script>\n<script>${esc(modules.join("\n"))}</script>\n` +
    `<script>${esc(INSPECTOR_CLIENT)}</script>\n` +
    `<script>try{window.__forgeRun(${JSON.stringify(entry)})}catch(e){var m=e&&e.message?e.message:String(e);` +
    `try{parent.postMessage({type:"forge:error",message:m,stack:e&&e.stack?String(e.stack):""},"*")}catch(x){}` +
    `document.getElementById("root").innerHTML='<pre style="margin:16px;padding:12px;border-radius:8px;background:#fef2f2;color:#991b1b;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap"></pre>';` +
    `document.querySelector("#root pre").textContent=m}</script></body></html>`;
  void unknown;
  return { ok: true, html };
}
