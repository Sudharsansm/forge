"""Reading, writing, generating and converting every document kind the library supports.

Kinds: text, markdown, html, csv, json, svg, chart, diagram, image, docx, xlsx, pptx, pdf, audio, video, other.
`view()` builds the payload the window edits, `save()` writes an edited payload back (in place where possible),
`generate()` makes a new file from AI-provided content, `text_of()` renders a readable version for the AI.
"""
from __future__ import annotations

import base64
import copy
import csv
import datetime as dt
import io
import json
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Any

from . import blocks as B
from .errors import ForgeError

# ------------------------------------------------------------------------------------------------ kinds
EXT_KIND = {
    **{e: "text" for e in ("txt log py js jsx ts tsx mjs cjs css scss sass less yaml yml toml ini cfg conf sh bash zsh sql xml rtf env gitignore "
                           "c h cpp hpp cc cs java kt kts go rs rb php swift lua r pl scala dart vue svelte astro mdx jsonl ndjson tex rst "
                           "graphql gql proto gradle mmd mermaid diff patch properties lock").split()},
    "ipynb": "notebook", "zip": "archive",
    "md": "markdown", "markdown": "markdown", "html": "html", "htm": "html", "csv": "csv", "tsv": "csv", "json": "json", "svg": "svg",
    **{e: "image" for e in "png jpg jpeg gif webp bmp ico".split()},
    "docx": "docx", "xlsx": "xlsx", "xlsm": "xlsx", "pptx": "pptx", "pdf": "pdf",
    **{e: "audio" for e in "mp3 wav ogg m4a flac".split()}, **{e: "video" for e in "mp4 webm mov".split()},
}
MIME = {"txt": "text/plain", "md": "text/markdown", "html": "text/html", "csv": "text/csv", "tsv": "text/tab-separated-values",
        "json": "application/json", "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "gif": "image/gif", "webp": "image/webp", "bmp": "image/bmp", "ico": "image/x-icon", "pdf": "application/pdf",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "ipynb": "application/x-ipynb+json", "zip": "application/zip", "mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg", "mp4": "video/mp4", "webm": "video/webm", "mov": "video/quicktime"}
TEXT_KINDS = {"text", "markdown", "html", "csv", "json", "svg", "chart", "diagram"}
KIND_LABEL = {"text": "Text", "markdown": "Markdown", "html": "HTML", "csv": "Table (CSV)", "json": "JSON", "svg": "Image (SVG)", "chart": "Chart",
              "diagram": "Diagram", "image": "Image", "docx": "Word document", "xlsx": "Spreadsheet", "pptx": "Presentation", "pdf": "PDF",
              "audio": "Audio", "video": "Video", "notebook": "Notebook", "archive": "Archive (ZIP)", "other": "File"}
MAX_VIEW_BINARY = 8_000_000
MAX_TEXT_VIEW = 2_000_000
MAX_GRID_ROWS, MAX_GRID_COLS = 3000, 100


def ext_of(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def kind_of(name: str) -> str:
    low = name.lower()
    if low.endswith(".chart.json"):
        return "chart"
    if low.endswith(".diagram.json"):
        return "diagram"
    return EXT_KIND.get(ext_of(name), "other")


def looks_like_text(data: bytes) -> bool:
    """An unknown file type is still shown as text when it clearly is text (no NUL bytes, decodes as UTF-8)."""
    if not data or len(data) > MAX_TEXT_VIEW:
        return False
    head = data[:8192]
    if b"\x00" in head:
        return False
    try:
        head.decode("utf-8")
        return True
    except UnicodeDecodeError as exc:
        return exc.start >= len(head) - 4  # a multi-byte character cut by the 8 KB window


def mime_of(name: str) -> str:
    return MIME.get(ext_of(name), "application/octet-stream")


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def _decode_text(data: bytes) -> str:
    for enc in ("utf-8-sig", "utf-16", "latin-1"):
        try:
            return data.decode(enc)
        except (UnicodeDecodeError, UnicodeError):
            continue
    return data.decode("utf-8", "replace")


# ------------------------------------------------------------------------------------------------ svg
_SVG_NS = "http://www.w3.org/2000/svg"
_XLINK = "http://www.w3.org/1999/xlink"
_SVG_TAGS = {"svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "defs", "lineargradient",
             "radialgradient", "stop", "clippath", "mask", "pattern", "use", "image", "title", "desc", "marker", "symbol", "style", "filter",
             "fegaussianblur", "feoffset", "fecolormatrix", "feblend", "femerge", "femergenode", "feflood", "fecomposite", "fedropshadow", "textpath"}
for _p, _u in (("", _SVG_NS), ("xlink", _XLINK)):
    ET.register_namespace(_p, _u)


def sanitize_svg(text: str) -> str:
    """Strip everything that can run code or reach the network: scripts, foreignObject, on* handlers, external references."""
    if re.search(r"<!DOCTYPE|<!ENTITY", text, re.I):
        raise ForgeError("SVG files with a DOCTYPE or entities are not accepted")
    try:
        root = ET.fromstring(text.strip())
    except ET.ParseError as exc:
        raise ForgeError(f"Invalid SVG: {exc}") from None
    if root.tag.split("}")[-1].lower() != "svg":
        raise ForgeError("The file is not an SVG image")

    def clean_css(css: str) -> str:
        css = re.sub(r"@import[^;]*;?", "", css, flags=re.I)
        return re.sub(r"url\(\s*(?!['\"]?(?:#|data:image/))[^)]*\)", "none", css, flags=re.I)

    def walk(el: ET.Element) -> None:
        for child in list(el):
            name = child.tag.split("}")[-1].lower() if isinstance(child.tag, str) else ""
            if name not in _SVG_TAGS:
                el.remove(child)
                continue
            walk(child)
        for attr in list(el.attrib):
            local = attr.split("}")[-1].lower()
            val = el.attrib[attr]
            if local.startswith("on") or local in ("srcdoc",):
                del el.attrib[attr]
            elif local == "href":
                ok = val.startswith("#") or re.match(r"^data:image/(png|jpe?g|gif|webp|svg\+xml);", val)
                if not ok or (el.tag.split("}")[-1].lower() == "image" and val.startswith("data:image/svg")):
                    del el.attrib[attr]
            elif local == "style":
                el.attrib[attr] = clean_css(val)
            elif re.search(r"javascript:|expression\(", val, re.I):
                del el.attrib[attr]
        if el.tag.split("}")[-1].lower() == "style" and el.text:
            el.text = clean_css(el.text)

    walk(root)
    if not root.get("xmlns") and root.tag == "svg":
        root.set("xmlns", _SVG_NS)
    return ET.tostring(root, encoding="unicode")


def svg_size(text: str) -> tuple[float, float] | None:
    m = re.search(r'viewBox="\s*[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)', text)
    if m:
        return float(m.group(1)), float(m.group(2))
    w, h = re.search(r'\swidth="([\d.]+)', text), re.search(r'\sheight="([\d.]+)', text)
    return (float(w.group(1)), float(h.group(1))) if w and h else None


# ------------------------------------------------------------------------------------------------ charts and diagrams
CHART_TYPES = ("bar", "hbar", "stacked", "line", "area", "pie", "donut", "scatter")


def _num(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and abs(f) != float("inf") else None


def normalize_chart(spec: dict) -> dict:
    if not isinstance(spec, dict):
        raise ForgeError("A chart spec must be an object")
    kind = str(spec.get("type", "bar")).lower()
    if kind not in CHART_TYPES:
        raise ForgeError(f"Chart type must be one of: {', '.join(CHART_TYPES)}")
    labels = [str(x) for x in (spec.get("labels") or [])][:500]
    series_in = spec.get("series")
    if series_in is None and "values" in spec:
        series_in = [{"name": spec.get("name", "Value"), "values": spec["values"]}]
    out_series = []
    for s in (series_in or [])[:20]:
        if not isinstance(s, dict):
            continue
        if kind == "scatter":
            pts = [{"x": _num(p.get("x")), "y": _num(p.get("y"))} for p in (s.get("points") or []) if isinstance(p, dict)][:2000]
            out_series.append({"name": str(s.get("name", f"Series {len(out_series) + 1}")), "points": [p for p in pts if p["x"] is not None and p["y"] is not None],
                               **({"color": s["color"]} if s.get("color") else {})})
        else:
            vals = [_num(v) for v in (s.get("values") or [])][: len(labels) or 500]
            vals += [None] * (len(labels) - len(vals))
            out_series.append({"name": str(s.get("name", f"Series {len(out_series) + 1}")), "values": vals,
                               **({"color": s["color"]} if s.get("color") else {})})
    if kind != "scatter" and out_series and not labels:
        labels = [str(i + 1) for i in range(len(out_series[0]["values"]))]
        for s in out_series:
            s["values"] = s["values"][: len(labels)]
    return {"version": 1, "type": kind, "title": str(spec.get("title", ""))[:200], "subtitle": str(spec.get("subtitle", ""))[:300],
            "labels": labels, "series": out_series, "xLabel": str(spec.get("xLabel", ""))[:80], "yLabel": str(spec.get("yLabel", ""))[:80],
            "legend": bool(spec.get("legend", True)), "showValues": bool(spec.get("showValues", False)), "grid": bool(spec.get("grid", True)),
            "pointColors": {str(k): v for k, v in (spec.get("pointColors") or {}).items()} if isinstance(spec.get("pointColors"), dict) else {}}


NODE_KINDS = {"start", "end", "page", "action", "process", "decision", "entry", "root", "component", "hook", "store", "data", "util", "style",
              "asset", "service", "state", "output", "user", "effect", "html", "package", "config", "module", "types", "note", "actor"}


def normalize_diagram(spec: dict) -> dict:
    if not isinstance(spec, dict):
        raise ForgeError("A diagram spec must be an object")
    if spec.get("kind") == "sequence" or "participants" in spec:
        parts, seen = [], set()
        for p in spec.get("participants") or []:
            pid = str(p.get("id") or p.get("label") or "").strip()
            if pid and pid not in seen:
                seen.add(pid)
                parts.append({**{k: p[k] for k in ("file", "color") if k in p}, "id": pid, "label": str(p.get("label") or pid)[:60],
                              "kind": p.get("kind") if p.get("kind") in NODE_KINDS else "component"})
        msgs = []
        for i, m in enumerate(spec.get("messages") or []):
            if str(m.get("from")) in seen and str(m.get("to")) in seen:
                msgs.append({"id": str(m.get("id") or f"m{i + 1}"), "from": str(m["from"]), "to": str(m["to"]), "label": str(m.get("label", ""))[:120],
                             "kind": m.get("kind") if m.get("kind") in ("call", "return", "self", "note") else "call",
                             **({"phase": str(m["phase"])} if m.get("phase") else {})})
        return {"version": 1, "kind": "sequence", "type": "sequence", "title": str(spec.get("title", ""))[:200], "participants": parts, "messages": msgs,
                **({"generated": spec["generated"]} if spec.get("generated") else {})}
    nodes, ids = [], set()
    for n in spec.get("nodes") or []:
        nid = str(n.get("id") or n.get("label") or "").strip()
        if not nid or nid in ids:
            continue
        ids.add(nid)
        node = {k: n[k] for k in ("sub", "group", "file", "line", "color", "x", "y") if k in n}
        node.update({"id": nid, "label": str(n.get("label") or nid)[:80], "kind": n.get("kind") if n.get("kind") in NODE_KINDS else "process"})
        nodes.append(node)
    edges = []
    for i, e in enumerate(spec.get("edges") or []):
        a, b = str(e.get("from", "")), str(e.get("to", ""))
        if a in ids and b in ids and a != b:
            edges.append({"id": str(e.get("id") or f"e{i + 1}"), "from": a, "to": b, **({"label": str(e["label"])[:80]} if e.get("label") else {}),
                          **({"dashed": True} if e.get("dashed") else {})})
    groups = [{"id": str(g["id"]), "label": str(g.get("label", g["id"]))} for g in (spec.get("groups") or []) if isinstance(g, dict) and g.get("id")]
    return {"version": 1, "kind": "graph", "type": str(spec.get("type", "flowchart"))[:30], "title": str(spec.get("title", ""))[:200],
            "direction": "TB" if spec.get("direction") == "TB" else "LR", "groups": groups, "nodes": nodes, "edges": edges,
            **({"generated": spec["generated"]} if spec.get("generated") else {})}


def _json_text(spec: dict) -> bytes:
    return (json.dumps(spec, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


# ------------------------------------------------------------------------------------------------ csv / xlsx
def _sniff(text: str, name: str) -> str:
    if name.lower().endswith(".tsv"):
        return "\t"
    try:
        return csv.Sniffer().sniff(text[:4096], delimiters=",;\t|").delimiter
    except csv.Error:
        return ","


def csv_read(text: str, name: str) -> dict:
    delim = _sniff(text, name)
    rows = []
    truncated = False
    for i, row in enumerate(csv.reader(io.StringIO(text), delimiter=delim)):
        if i >= MAX_GRID_ROWS:
            truncated = True
            break
        rows.append(row[:MAX_GRID_COLS])
    return {"rows": rows or [[""]], "delimiter": delim, "truncated": truncated}


def csv_write(rows: list[list[Any]], delim: str = ",") -> bytes:
    out = io.StringIO()
    w = csv.writer(out, delimiter=delim, lineterminator="\n")
    for r in rows:
        w.writerow(["" if c is None else c for c in r])
    return out.getvalue().encode("utf-8")


def _cell(v: Any) -> Any:
    if isinstance(v, (dt.datetime, dt.date, dt.time)):
        return v.isoformat()
    if v is None or isinstance(v, (int, float, bool, str)):
        return v
    return str(v)


def xlsx_read(data: bytes) -> dict:
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(data), data_only=False)
    cached = load_workbook(io.BytesIO(data), data_only=True)
    sheets = []
    for ws in wb.worksheets:
        rows, calc, truncated, has_formula = [], [], False, False
        for r_i, row in enumerate(ws.iter_rows(min_row=1, max_row=min(ws.max_row, MAX_GRID_ROWS), max_col=min(ws.max_column, MAX_GRID_COLS))):
            vals = [_cell(c.value) for c in row]
            rows.append(vals)
            has_formula = has_formula or any(isinstance(v, str) and v.startswith("=") for v in vals)
        if ws.max_row > MAX_GRID_ROWS:
            truncated = True
        if has_formula:
            cws = cached[ws.title]
            for row in cws.iter_rows(min_row=1, max_row=len(rows), max_col=min(ws.max_column, MAX_GRID_COLS)):
                calc.append([_cell(c.value) for c in row])
        sheets.append({"name": ws.title, "rows": rows or [[None]], "calc": calc or None, "truncated": truncated})
    return {"sheets": sheets or [{"name": "Sheet1", "rows": [[None]], "calc": None, "truncated": False}]}


def _typed(v: Any) -> Any:
    if isinstance(v, str):
        s = v.strip()
        if s == "":
            return None
        if s.startswith("="):
            return s
        if re.fullmatch(r"-?\d+", s) and len(s) < 16:
            return int(s)
        if re.fullmatch(r"-?\d*\.\d+(e-?\d+)?|-?\d+\.\d*", s):
            return float(s)
        return v
    return v


def xlsx_write(original: bytes | None, sheets: list[dict], header: bool = False) -> bytes:
    from openpyxl import Workbook, load_workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    if original:
        wb = load_workbook(io.BytesIO(original))
    else:
        wb = Workbook()
        wb.remove(wb.active)
    wanted = [s.get("name") or f"Sheet{i + 1}" for i, s in enumerate(sheets)]
    for ws in list(wb.worksheets):
        if ws.title not in wanted:
            wb.remove(ws)
    for i, s in enumerate(sheets):
        name = str(s.get("name") or f"Sheet{i + 1}")[:31]
        ws = wb[name] if name in wb.sheetnames else wb.create_sheet(name)
        rows = s.get("rows") or [[None]]
        for r_i, row in enumerate(rows, start=1):
            for c_i, val in enumerate(row[:MAX_GRID_COLS], start=1):
                new = _typed(val)
                cell = ws.cell(row=r_i, column=c_i)
                if cell.value != new:
                    cell.value = new
        if ws.max_row > len(rows):
            ws.delete_rows(len(rows) + 1, ws.max_row - len(rows))
        width = max((len(r) for r in rows), default=0)
        if ws.max_column > width and width:
            ws.delete_cols(width + 1, ws.max_column - width)
        if header and not original:
            for c in ws[1]:
                c.font = Font(bold=True, color="FFFFFF")
                c.fill = PatternFill("solid", fgColor="2F4F8F")
                c.alignment = Alignment(vertical="center")
            ws.freeze_panes = "A2"
            for ci in range(1, width + 1):
                longest = max((len(str(r[ci - 1])) for r in rows if ci - 1 < len(r) and r[ci - 1] is not None), default=8)
                ws.column_dimensions[get_column_letter(ci)].width = min(60, max(10, longest + 2))
    order = [wb[n[:31]] for n in wanted if n[:31] in wb.sheetnames]
    wb._sheets = order  # noqa: SLF001 - openpyxl has no public reorder API
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


# ------------------------------------------------------------------------------------------------ pptx
def _tf_text(tf) -> str:
    return "\n".join("".join(r.text for r in p.runs) if p.runs else p.text for p in tf.paragraphs)


def pptx_read(data: bytes) -> dict:
    from pptx import Presentation
    from pptx.enum.shapes import MSO_SHAPE_TYPE
    prs = Presentation(io.BytesIO(data))
    sw, sh = int(prs.slide_width), int(prs.slide_height)
    slides = []
    for idx, slide in enumerate(prs.slides):
        shapes = []
        for shape in slide.shapes:
            try:
                box = {"x": int(shape.left or 0) / sw, "y": int(shape.top or 0) / sh, "w": int(shape.width or 0) / sw, "h": int(shape.height or 0) / sh}
            except Exception:  # noqa: BLE001
                box = {"x": 0, "y": 0, "w": 1, "h": 0.1}
            item: dict[str, Any] = {"id": shape.shape_id, "name": shape.name, **box}
            if shape.has_text_frame:
                item.update(kind="text", text=_tf_text(shape.text_frame))
                try:
                    sizes = [r.font.size.pt for p in shape.text_frame.paragraphs for r in p.runs if r.font.size]
                    if sizes:
                        item["fontPt"] = sizes[0]
                except Exception:  # noqa: BLE001
                    pass
            elif getattr(shape, "has_table", False) and shape.has_table:
                item.update(kind="table", rows=[[c.text for c in r.cells] for r in shape.table.rows])
            elif shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
                item["kind"] = "picture"
                try:
                    blob = shape.image.blob
                    if len(blob) <= B.MAX_INLINE_IMAGE:
                        item["src"] = f"data:{shape.image.content_type};base64,{_b64(blob)}"
                except Exception:  # noqa: BLE001
                    pass
            else:
                item["kind"] = "other"
            shapes.append(item)
        notes = slide.notes_slide.notes_text_frame.text if slide.has_notes_slide and slide.notes_slide.notes_text_frame is not None else ""
        slides.append({"index": idx, "shapes": shapes, "notes": notes})
    return {"slides": slides, "width": sw, "height": sh, "ratio": sw / sh}


def _set_tf(tf, text: str) -> None:
    lines = text.split("\n")
    paras = list(tf.paragraphs)
    while len(paras) < len(lines):
        new = copy.deepcopy(paras[-1]._p)
        paras[-1]._p.addnext(new)
        paras = list(tf.paragraphs)
    while len(paras) > len(lines):
        last = paras.pop()
        last._p.getparent().remove(last._p)
    for p, line in zip(paras, lines):
        runs = list(p.runs)
        if runs:
            runs[0].text = line
            for r in runs[1:]:
                r._r.getparent().remove(r._r)
        else:
            p.text = line


def _add_slide(prs, spec: dict) -> Any:
    from pptx.util import Emu, Pt
    layout_idx = 0 if spec.get("layout") == "title" else 1
    layout = prs.slide_layouts[layout_idx if layout_idx < len(prs.slide_layouts) else 0]
    slide = prs.slides.add_slide(layout)
    sw, sh = prs.slide_width, prs.slide_height
    title = slide.shapes.title
    bullets = spec.get("bullets") or []
    if spec.get("layout") == "title":
        if title is not None:
            title.text = str(spec.get("title", ""))
            title.left, title.top, title.width, title.height = int(sw * 0.08), int(sh * 0.30), int(sw * 0.84), int(sh * 0.2)
            for p in title.text_frame.paragraphs:
                for r in p.runs:
                    r.font.size = Pt(44); r.font.bold = True
        for ph in slide.placeholders:
            if ph.placeholder_format.idx == 1:
                ph.text = str(spec.get("subtitle", ""))
                ph.left, ph.top, ph.width, ph.height = int(sw * 0.08), int(sh * 0.52), int(sw * 0.84), int(sh * 0.15)
    else:
        if title is not None:
            title.text = str(spec.get("title", ""))
            title.left, title.top, title.width, title.height = int(sw * 0.06), int(sh * 0.06), int(sw * 0.88), int(sh * 0.14)
            for p in title.text_frame.paragraphs:
                for r in p.runs:
                    r.font.size = Pt(32); r.font.bold = True
        body = next((ph for ph in slide.placeholders if ph.placeholder_format.idx == 1), None)
        if body is None:
            body = slide.shapes.add_textbox(Emu(int(sw * 0.06)), Emu(int(sh * 0.24)), Emu(int(sw * 0.88)), Emu(int(sh * 0.66)))
        body.left, body.top, body.width, body.height = int(sw * 0.06), int(sh * 0.24), int(sw * 0.88), int(sh * 0.66)
        tf = body.text_frame
        tf.word_wrap = True
        items = [(b, 0) if isinstance(b, str) else (str(b.get("text", "")), int(b.get("level", 0))) for b in bullets] or [("", 0)]
        for i, (text, level) in enumerate(items):
            p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            p.text = text
            p.level = min(level, 4)
            for r in p.runs:
                r.font.size = Pt(22 if level == 0 else 18)
    if spec.get("notes"):
        slide.notes_slide.notes_text_frame.text = str(spec["notes"])
    return slide


def pptx_write(original: bytes | None, slides: list[dict]) -> bytes:
    from pptx import Presentation
    from pptx.util import Inches
    if original:
        prs = Presentation(io.BytesIO(original))
    else:
        prs = Presentation()
        prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
    sld_ids = list(prs.slides._sldIdLst)  # noqa: SLF001
    order: list[Any] = []
    keep: set[int] = set()
    for spec in slides:
        idx = spec.get("index")
        if isinstance(idx, int) and 0 <= idx < len(sld_ids) and idx not in keep and original:
            keep.add(idx)
            slide = prs.slides[idx]
            by_id = {s.shape_id: s for s in slide.shapes}
            for sh in spec.get("shapes") or []:
                shape = by_id.get(sh.get("id"))
                if shape is None:
                    continue
                if sh.get("kind") == "text" and shape.has_text_frame and "text" in sh and _tf_text(shape.text_frame) != sh["text"]:
                    _set_tf(shape.text_frame, str(sh["text"]))
                elif sh.get("kind") == "table" and getattr(shape, "has_table", False) and shape.has_table and sh.get("rows"):
                    tbl = shape.table
                    for r_i, row in enumerate(sh["rows"][: len(tbl.rows)]):
                        for c_i, val in enumerate(row[: len(tbl.columns)]):
                            if tbl.cell(r_i, c_i).text != str(val):
                                tbl.cell(r_i, c_i).text = str(val)
            if "notes" in spec:
                cur = slide.notes_slide.notes_text_frame.text if slide.has_notes_slide else ""
                if cur != spec["notes"] and (spec["notes"] or slide.has_notes_slide):
                    slide.notes_slide.notes_text_frame.text = str(spec["notes"])
            order.append(sld_ids[idx])
        else:
            _add_slide(prs, spec)
            order.append(list(prs.slides._sldIdLst)[-1])  # noqa: SLF001
    lst = prs.slides._sldIdLst  # noqa: SLF001
    for i, sid in enumerate(sld_ids):
        if i not in keep and original:
            prs.part.drop_rel(sid.rId)
    for el in list(lst):
        lst.remove(el)
    for el in order:
        lst.append(el)
    out = io.BytesIO()
    prs.save(out)
    return out.getvalue()


# ------------------------------------------------------------------------------------------------ pdf / image
def pdf_info(data: bytes) -> dict:
    from pypdf import PdfReader
    try:
        reader = PdfReader(io.BytesIO(data))
        pages = []
        for i, page in enumerate(reader.pages):
            if i >= 200:
                break
            try:
                pages.append((page.extract_text() or "").strip())
            except Exception:  # noqa: BLE001
                pages.append("")
        meta = reader.metadata
        return {"pages": len(reader.pages), "text": pages, "title": (meta.title if meta else "") or ""}
    except Exception as exc:  # noqa: BLE001
        raise ForgeError(f"Could not read this PDF: {exc}") from None


def image_info(data: bytes) -> dict:
    from PIL import Image
    try:
        with Image.open(io.BytesIO(data)) as im:
            return {"width": im.width, "height": im.height, "format": im.format}
    except Exception as exc:  # noqa: BLE001
        raise ForgeError(f"Not a valid image: {exc}") from None


# ------------------------------------------------------------------------------------------------ notebook / archive (view only)
def notebook_read(data: bytes) -> dict:
    """A Jupyter notebook as read-only cells: markdown, code and the text of each output."""
    try:
        nb = json.loads(_decode_text(data))
        raw = nb.get("cells") or (nb.get("worksheets") or [{}])[0].get("cells") or []
    except (json.JSONDecodeError, AttributeError, IndexError):
        raise ForgeError("This is not a valid notebook (.ipynb).") from None
    join = lambda v: "".join(v) if isinstance(v, list) else str(v or "")  # noqa: E731
    cells = []
    for c in raw[:500]:
        outs = []
        for o in c.get("outputs", []) if isinstance(c, dict) else []:
            if o.get("output_type") == "stream":
                outs.append(join(o.get("text")))
            elif o.get("output_type") in ("execute_result", "display_data"):
                d = o.get("data", {})
                if "image/png" in d:
                    outs.append({"png": join(d["image/png"]).replace("\n", "")})
                else:
                    outs.append(join(d.get("text/plain")))
            elif o.get("output_type") == "error":
                outs.append(f"{o.get('ename', 'Error')}: {o.get('evalue', '')}")
        cells.append({"type": c.get("cell_type", "code"), "source": join(c.get("source")), "outputs": outs[:20]})
    lang = ((nb.get("metadata") or {}).get("language_info") or {}).get("name", "python")
    return {"cells": cells, "language": lang, "editable": False}


def archive_read(data: bytes) -> dict:
    import zipfile
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            entries = [{"name": i.filename, "size": i.file_size, "dir": i.is_dir()} for i in z.infolist()[:2000]]
            total = len(z.infolist())
    except zipfile.BadZipFile:
        raise ForgeError("This is not a valid ZIP file.") from None
    return {"entries": entries, "count": total, "editable": False}


# ------------------------------------------------------------------------------------------------ view / save
def view(kind: str, name: str, data: bytes, sidecar: bytes | None = None) -> dict:
    """The payload the window shows and edits for this document."""
    info: dict[str, Any] = {"kind": kind, "editable": kind in TEXT_KINDS | {"docx", "xlsx", "pptx", "image"}}
    if kind in ("text", "markdown", "html", "json"):
        if len(data) > MAX_TEXT_VIEW:
            raise ForgeError("This file is too large to open in the editor. Download it instead.")
        text = _decode_text(data)
        info["text"] = text
        if kind == "json":
            try:
                json.loads(text)
                info["valid"] = True
            except json.JSONDecodeError as exc:
                info.update(valid=False, error=f"{exc.msg} (line {exc.lineno})")
    elif kind == "svg":
        text = _decode_text(data)
        info["text"] = sanitize_svg(text)
        info["size"] = svg_size(info["text"])
    elif kind == "csv":
        info.update(csv_read(_decode_text(data), name))
    elif kind in ("chart", "diagram"):
        try:
            spec = json.loads(_decode_text(data))
            info["spec"] = normalize_chart(spec) if kind == "chart" else normalize_diagram(spec)
        except (json.JSONDecodeError, ForgeError) as exc:
            raise ForgeError(f"This {kind} file is not valid: {exc}") from None
    elif kind == "docx":
        info.update(B.docx_read(data))
    elif kind == "xlsx":
        info.update(xlsx_read(data))
    elif kind == "pptx":
        info.update(pptx_read(data))
    elif kind == "pdf":
        info.update(pdf_info(data))
        if len(data) <= MAX_VIEW_BINARY:
            info["base64"] = _b64(data)
        if sidecar:
            info.update(editable=True, blocks=B.ensure_ids(json.loads(sidecar)))
    elif kind == "image":
        info.update(image_info(data))
        if len(data) <= MAX_VIEW_BINARY:
            info["base64"], info["mime"] = _b64(data), mime_of(name)
    elif kind == "notebook":
        info.update(notebook_read(data))
    elif kind == "archive":
        info.update(archive_read(data))
    elif kind in ("audio", "video"):
        if len(data) <= MAX_VIEW_BINARY * 2:
            info["base64"], info["mime"] = _b64(data), mime_of(name)
    return info


@dataclass
class Saved:
    data: bytes
    sidecar: bytes | None = None


def save(kind: str, name: str, original: bytes | None, payload: dict, sidecar: bytes | None = None) -> Saved:
    """Write an edited payload back to file bytes."""
    if kind in ("text", "markdown", "html", "json"):
        return Saved(str(payload.get("text", "")).encode("utf-8"))
    if kind == "svg":
        return Saved(sanitize_svg(str(payload.get("text", ""))).encode("utf-8"))
    if kind == "csv":
        return Saved(csv_write(payload.get("rows") or [[""]], payload.get("delimiter") or ","))
    if kind == "chart":
        return Saved(_json_text(normalize_chart(payload.get("spec") or {})))
    if kind == "diagram":
        return Saved(_json_text(normalize_diagram(payload.get("spec") or {})))
    if kind == "docx":
        return Saved(B.docx_write(original, payload.get("blocks") or []))
    if kind == "xlsx":
        return Saved(xlsx_write(original, payload.get("sheets") or []))
    if kind == "pptx":
        return Saved(pptx_write(original, payload.get("slides") or []))
    if kind == "image":
        raw = payload.get("base64") or ""
        data = base64.b64decode(raw.split(",", 1)[-1]) if raw else b""
        image_info(data)
        return Saved(data)
    if kind == "pdf" and (sidecar is not None or payload.get("blocks") is not None):
        blocks = B.ensure_ids(payload.get("blocks") or [])
        return Saved(B.blocks_to_pdf(blocks, str(payload.get("title", ""))), json.dumps(blocks).encode("utf-8"))
    raise ForgeError(f"{KIND_LABEL.get(kind, 'This file type')} cannot be edited here. Download it, or ask the AI to create an editable version.")


# ------------------------------------------------------------------------------------------------ text for the AI
def text_of(kind: str, name: str, data: bytes, sidecar: bytes | None = None, limit: int = 60_000) -> str:
    if kind in TEXT_KINDS:
        text = _decode_text(data)
        if kind == "csv":
            text = "\n".join("\t".join(r) for r in csv_read(text, name)["rows"][:300])
    elif kind == "docx":
        text = B.blocks_to_text(B.docx_read(data)["blocks"], with_ids=True)
    elif kind == "xlsx":
        parts = []
        for s in xlsx_read(data)["sheets"]:
            parts.append(f"## Sheet: {s['name']}")
            for i, row in enumerate(s["rows"][:300], start=1):
                parts.append(f"{i}\t" + "\t".join("" if v is None else str(v) for v in row))
        text = "\n".join(parts)
    elif kind == "pptx":
        parts = []
        for s in pptx_read(data)["slides"]:
            parts.append(f"## Slide {s['index'] + 1}")
            for sh in s["shapes"]:
                if sh.get("kind") == "text" and sh.get("text"):
                    parts.append(f"[shape {sh['id']}] {sh['text']}")
                elif sh.get("kind") == "table":
                    parts.append(f"[table {sh['id']}]\n" + "\n".join("\t".join(r) for r in sh["rows"]))
            if s["notes"]:
                parts.append(f"[notes] {s['notes']}")
        text = "\n".join(parts)
    elif kind == "pdf":
        if sidecar:
            text = B.blocks_to_text(json.loads(sidecar), with_ids=True)
        else:
            info = pdf_info(data)
            text = "\n\n".join(f"--- page {i + 1} ---\n{t}" for i, t in enumerate(info["text"]))
    elif kind == "image":
        i = image_info(data)
        text = f"Image {i['format']} {i['width']}x{i['height']} px (raster image; the AI cannot see its pixels here)."
    else:
        text = f"{KIND_LABEL.get(kind, 'File')}, {len(data)} bytes. No text view is available."
    if len(text) > limit:
        text = text[:limit] + f"\n… [truncated, {len(text) - limit} more characters]"
    return text


# ------------------------------------------------------------------------------------------------ replace
def replace_text(kind: str, name: str, data: bytes, find: str, replace: str, replace_all: bool, sidecar: bytes | None = None) -> Saved:
    if not find:
        raise ForgeError("'find' must not be empty")
    count = 0

    def sub(s: str) -> str:
        nonlocal count
        n = s.count(find)
        if n == 0 or (count and not replace_all):
            return s
        count += n if replace_all else 1
        return s.replace(find, replace) if replace_all else s.replace(find, replace, 1)

    if kind in TEXT_KINDS:
        out = sub(_decode_text(data))
        if count == 0:
            raise ForgeError("The text was not found")
        payload: dict[str, Any] = {"text": out}
        if kind in ("chart", "diagram"):
            payload = {"spec": json.loads(out)}
        elif kind == "csv":
            payload = {"rows": csv_read(out, name)["rows"], "delimiter": _sniff(out, name)}
        return save(kind, name, data, payload)
    if kind == "docx":
        v = B.docx_read(data)
        for b in v["blocks"]:
            for r in b.get("runs", []):
                r["t"] = sub(r["t"])
            if b.get("rows"):
                b["rows"] = [[sub(c) for c in row] for row in b["rows"]]
        if count == 0:
            raise ForgeError("The text was not found (it may span formatting changes; try a shorter phrase)")
        return save(kind, name, data, v)
    if kind == "xlsx":
        v = xlsx_read(data)
        for s in v["sheets"]:
            s["rows"] = [[sub(c) if isinstance(c, str) and not c.startswith("=") else c for c in row] for row in s["rows"]]
        if count == 0:
            raise ForgeError("The text was not found")
        return save(kind, name, data, v)
    if kind == "pptx":
        v = pptx_read(data)
        for s in v["slides"]:
            for sh in s["shapes"]:
                if sh.get("kind") == "text":
                    sh["text"] = sub(sh["text"])
            s["notes"] = sub(s["notes"])
        if count == 0:
            raise ForgeError("The text was not found")
        return save(kind, name, data, v)
    if kind == "pdf" and sidecar:
        blocks = json.loads(sidecar)
        for b in blocks:
            for r in b.get("runs", []):
                r["t"] = sub(r["t"])
        if count == 0:
            raise ForgeError("The text was not found")
        return save(kind, name, data, {"blocks": blocks}, sidecar)
    raise ForgeError(f"Text replacement is not supported for {KIND_LABEL.get(kind, 'this file type')}")


# ------------------------------------------------------------------------------------------------ generate
FORMATS = {"md": "markdown", "markdown": "markdown", "txt": "text", "text": "text", "html": "html", "csv": "csv", "json": "json", "svg": "svg",
           "docx": "docx", "word": "docx", "xlsx": "xlsx", "excel": "xlsx", "pptx": "pptx", "powerpoint": "pptx", "slides": "pptx", "pdf": "pdf",
           "chart": "chart", "diagram": "diagram", "png": "image", "jpg": "image", "jpeg": "image"}
DEFAULT_EXT = {"markdown": "md", "text": "txt", "html": "html", "csv": "csv", "json": "json", "svg": "svg", "docx": "docx", "xlsx": "xlsx",
               "pptx": "pptx", "pdf": "pdf", "chart": "chart.json", "diagram": "diagram.json", "image": "png"}


def _filename(name: str, kind: str, fmt: str) -> str:
    name = re.sub(r"[\\/:*?\"<>|\x00-\x1f]+", "-", name.strip()) or "document"
    ext = DEFAULT_EXT[kind]
    if kind == "image" and fmt in ("jpg", "jpeg"):
        ext = "jpg"
    if kind == "csv" and name.lower().endswith(".tsv"):
        return name
    for e in (ext, "markdown" if kind == "markdown" else ext, "htm" if kind == "html" else ext):
        if name.lower().endswith("." + e):
            return name
    if kind in ("chart", "diagram"):
        name = re.sub(r"\.json$", "", name, flags=re.I)
    return f"{name}.{ext}"


def generate(fmt: str, name: str, *, content: str | None = None, blocks: list[dict] | None = None, sheets: list[dict] | None = None,
             slides: list[dict] | None = None, spec: dict | None = None, data_b64: str | None = None) -> tuple[str, bytes, bytes | None]:
    """Create a new file. Returns (filename, bytes, sidecar)."""
    key = fmt.lower().lstrip(".")
    kind = FORMATS.get(key)
    if kind is None:
        raise ForgeError(f"Unknown format '{fmt}'. Use one of: md, txt, html, csv, json, svg, docx, xlsx, pptx, pdf, chart, diagram, png")
    filename = _filename(name, kind, key)
    sidecar = None
    if kind in ("markdown", "text", "html", "csv", "json"):
        if content is None:
            raise ForgeError("'content' is required for this format")
        if kind == "json":
            try:
                json.loads(content)
            except json.JSONDecodeError as exc:
                raise ForgeError(f"content is not valid JSON: {exc.msg}") from None
        data = content.encode("utf-8")
    elif kind == "svg":
        data = sanitize_svg(content or "").encode("utf-8")
    elif kind == "chart":
        data = _json_text(normalize_chart(spec or {}))
    elif kind == "diagram":
        data = _json_text(normalize_diagram(spec or {}))
    elif kind in ("docx", "pdf"):
        bl = blocks if blocks else B.md_to_blocks(content or "")
        if not bl:
            raise ForgeError("Provide 'content' (Markdown) or 'blocks' for a document")
        bl = B.ensure_ids([dict(b) for b in bl])
        title = next((B.runs_text(b.get("runs", [])) for b in bl if b.get("type") in B.HEADINGS), "")
        if kind == "docx":
            data = B.docx_write(None, bl, title=title or None)
        else:
            data, sidecar = B.blocks_to_pdf(bl, title), json.dumps(bl).encode("utf-8")
    elif kind == "xlsx":
        if not sheets:
            raise ForgeError("'sheets' is required for a spreadsheet: [{name, rows:[[...]]}]")
        data = xlsx_write(None, sheets, header=True)
    elif kind == "pptx":
        if not slides:
            raise ForgeError("'slides' is required for a presentation: [{title, bullets:[...], notes}]")
        specs = [dict(s) for s in slides]
        if specs and specs[0].get("layout") != "title" and (specs[0].get("subtitle") is not None or not specs[0].get("bullets")):
            specs[0]["layout"] = "title"
        data = pptx_write(None, specs)
    else:  # image
        if not data_b64:
            raise ForgeError("'png_base64' is required for a raster image (or use format svg)")
        data = base64.b64decode(data_b64.split(",", 1)[-1])
        image_info(data)
    return filename, data, sidecar


# ------------------------------------------------------------------------------------------------ convert
def to_blocks(kind: str, name: str, data: bytes, sidecar: bytes | None = None) -> list[dict]:
    if kind in ("markdown", "html"):
        text = _decode_text(data)
        if kind == "html":
            text = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", text, flags=re.S | re.I)
            text = re.sub(r"</(p|div|h\d|li|tr|br)>", "\n\n", text, flags=re.I)
            text = re.sub(r"<[^>]+>", "", text)
        return B.md_to_blocks(text, plain=(kind == "html"))
    if kind == "text":
        return B.md_to_blocks(_decode_text(data), plain=True)
    if kind == "docx":
        return B.docx_read(data)["blocks"]
    if kind == "pdf":
        if sidecar:
            return B.ensure_ids(json.loads(sidecar))
        return B.md_to_blocks("\n\n".join(pdf_info(data)["text"]), plain=True)
    if kind == "csv":
        return [{"id": "b0", "type": "table", "rows": csv_read(_decode_text(data), name)["rows"]}]
    if kind == "xlsx":
        out = []
        for i, s in enumerate(xlsx_read(data)["sheets"]):
            out.append({"id": f"h{i}", "type": "h2", "runs": [B.run(s["name"])]})
            out.append({"id": f"t{i}", "type": "table", "rows": [["" if v is None else str(v) for v in r] for r in s["rows"]]})
        return out
    if kind == "pptx":
        out = []
        for s in pptx_read(data)["slides"]:
            texts = [sh["text"] for sh in s["shapes"] if sh.get("kind") == "text" and sh.get("text")]
            if texts:
                out.append({"id": f"s{s['index']}", "type": "h2", "runs": [B.run(texts[0].split("\n")[0])]})
                for t in texts[1:] + texts[0].split("\n")[1:]:
                    for line in t.split("\n"):
                        out.append({"id": f"s{s['index']}-{len(out)}", "type": "li", "level": 0, "runs": [B.run(line)]})
        return out
    raise ForgeError(f"Cannot convert {KIND_LABEL.get(kind, 'this file type')} to a document")


CONVERT_TO = {"docx": "docx", "pdf": "pdf", "md": "markdown", "markdown": "markdown", "txt": "text", "xlsx": "xlsx", "csv": "csv"}


def convert(kind: str, name: str, data: bytes, to: str, sidecar: bytes | None = None) -> tuple[str, bytes, bytes | None]:
    target = CONVERT_TO.get(to.lower())
    if target is None:
        raise ForgeError(f"Cannot convert to '{to}'. Use one of: {', '.join(sorted(CONVERT_TO))}")
    stem = re.sub(r"\.[A-Za-z0-9]+$", "", name)
    if kind == target:
        raise ForgeError("The document already has that format")
    if target in ("xlsx", "csv"):
        if kind == "csv" and target == "xlsx":
            return f"{stem}.xlsx", xlsx_write(None, [{"name": "Sheet1", "rows": csv_read(_decode_text(data), name)["rows"]}], header=True), None
        if kind == "xlsx" and target == "csv":
            first = xlsx_read(data)["sheets"][0]
            return f"{stem}.csv", csv_write(first["rows"]), None
        if kind in ("markdown", "docx", "pdf"):
            tables = [b["rows"] for b in to_blocks(kind, name, data, sidecar) if b.get("type") == "table"]
            if not tables:
                raise ForgeError("The document has no table to convert")
            if target == "csv":
                return f"{stem}.csv", csv_write(tables[0]), None
            return f"{stem}.xlsx", xlsx_write(None, [{"name": f"Table {i + 1}", "rows": t} for i, t in enumerate(tables)], header=True), None
        raise ForgeError(f"Cannot convert {KIND_LABEL.get(kind, 'this file')} to {to}")
    blocks = B.ensure_ids(to_blocks(kind, name, data, sidecar))
    if target == "docx":
        return f"{stem}.docx", B.docx_write(None, blocks), None
    if target == "pdf":
        return f"{stem}.pdf", B.blocks_to_pdf(blocks, stem), json.dumps(blocks).encode("utf-8")
    if target == "markdown":
        return f"{stem}.md", B.blocks_to_md(blocks).encode("utf-8"), None
    return f"{stem}.txt", B.blocks_to_text(blocks).encode("utf-8"), None
