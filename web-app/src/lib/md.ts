/** A small, safe Markdown renderer: everything is HTML-escaped first; links are limited to http(s)/mailto/#; images to data: URLs. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(raw: string): string {
  let s = esc(raw);
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/!\[([^\]]*)\]\((data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+)\)/g, (_, a, u) => `<img alt="${a}" src="${u}">`);
  s = s.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:|#)[^)\s]*)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  s = s.replace(/(\*\*|__)(.+?)\1/g, "<strong>$2</strong>");
  s = s.replace(/(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])/g, "<em>$1</em>").replace(/(?<!\w)_([^_\s][^_]*?)_(?!\w)/g, "<em>$1</em>");
  s = s.replace(/~~(.+?)~~/g, "<del>$1</del>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
}

export function mdToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0, para: string[] = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } };
  const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++]);
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`); i++; continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push("<hr>"); i++; continue; }
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    if (line.trimStart().startsWith(">")) {
      flush();
      const q: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith(">")) q.push(lines[i++].trimStart().slice(1).trim());
      out.push(`<blockquote>${inline(q.join(" "))}</blockquote>`); continue;
    }
    if (/^(\s*)([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const stack: { tag: string; indent: number }[] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        const indent = m[1].replace(/\t/g, "  ").length, tag = /\d/.test(m[2]) ? "ol" : "ul";
        while (stack.length && indent < stack[stack.length - 1].indent) out.push(`</${stack.pop()!.tag}>`);
        if (!stack.length || indent > stack[stack.length - 1].indent) { out.push(`<${tag}>`); stack.push({ tag, indent }); }
        out.push(`<li>${inline(m[3])}</li>`); i++;
      }
      while (stack.length) out.push(`</${stack.pop()!.tag}>`);
      continue;
    }
    para.push(line.trim()); i++;
  }
  flush();
  return out.join("\n");
}
