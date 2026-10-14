import base64
import io
import json

import pytest
from PIL import Image

from forge_core import formats as F
from forge_core.errors import ForgeError

MD = "# Title\n\nHello **world**.\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n"


def gen(fmt, name="doc", **kw):
    return F.generate(fmt, name, **kw)


def test_kind_detection():
    assert F.kind_of("a.chart.json") == "chart" and F.kind_of("b.diagram.json") == "diagram" and F.kind_of("c.json") == "json"
    assert F.kind_of("x.DOCX") == "docx" and F.kind_of("x.unknown") == "other" and F.kind_of("noext") == "other"


def test_svg_sanitizer_strips_active_content():
    dirty = ('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><script>alert(1)</script><foreignObject><div/></foreignObject>'
             '<rect width="5" height="5" onclick="y()" style="fill:url(http://evil/x)"/><a href="javascript:alert(1)"><circle r="2"/></a>'
             '<image href="http://evil/p.png"/><use href="#ok"/></svg>')
    clean = F.sanitize_svg(dirty)
    for bad in ("script", "foreignObject", "onload", "onclick", "evil", "javascript"):
        assert bad not in clean
    assert "<rect" in clean and 'href="#ok"' in clean
    with pytest.raises(ForgeError):
        F.sanitize_svg('<!DOCTYPE svg [<!ENTITY a "b">]><svg xmlns="http://www.w3.org/2000/svg"/>')
    with pytest.raises(ForgeError):
        F.sanitize_svg("<html/>")


def test_text_formats_roundtrip():
    for fmt, content in (("md", MD), ("txt", "plain"), ("html", "<p>x</p>"), ("json", '{"a":1}'), ("csv", "a,b\n1,2\n")):
        name, data, _ = gen(fmt, "t", content=content)
        kind = F.kind_of(name)
        v = F.view(kind, name, data)
        if kind == "csv":
            assert v["rows"] == [["a", "b"], ["1", "2"]]
            assert F.save(kind, name, data, v).data.decode() == "a,b\n1,2\n"
        else:
            assert v["text"] == content
            assert F.save(kind, name, data, {"text": v["text"] + "!"}).data.decode().endswith("!")
    with pytest.raises(ForgeError):
        gen("json", "bad", content="{nope")


def test_chart_and_diagram_normalize():
    name, data, _ = gen("chart", "sales", spec={"type": "bar", "title": "Sales", "labels": ["Q1", "Q2"], "series": [{"name": "A", "values": [1, "2.5"]}]})
    assert name == "sales.chart.json"
    spec = F.view("chart", name, data)["spec"]
    assert spec["series"][0]["values"] == [1.0, 2.5] and spec["legend"] is True
    with pytest.raises(ForgeError):
        gen("chart", "x", spec={"type": "radar"})
    d = {"nodes": [{"id": "a", "label": "A"}, {"id": "b", "label": "B", "kind": "weird"}, {"id": "a"}], "edges": [{"from": "a", "to": "b"}, {"from": "a", "to": "zzz"}]}
    name, data, _ = gen("diagram", "flow", spec=d)
    s = F.view("diagram", name, data)["spec"]
    assert len(s["nodes"]) == 2 and len(s["edges"]) == 1 and s["nodes"][1]["kind"] == "process"
    seq = {"participants": [{"id": "u", "label": "User"}, {"id": "s", "label": "Server"}], "messages": [{"from": "u", "to": "s", "label": "hi"}, {"from": "u", "to": "x"}]}
    s = F.normalize_diagram(seq)
    assert s["kind"] == "sequence" and len(s["messages"]) == 1


def test_docx_xlsx_pptx_pdf_generate_view_edit():
    name, data, _ = gen("docx", "memo", content=MD)
    v = F.view("docx", name, data)
    v["blocks"][1]["runs"] = [{"t": "Edited."}]
    out = F.save("docx", name, data, v).data
    assert "Edited." in F.text_of("docx", name, out)

    name, data, _ = gen("xlsx", "book", sheets=[{"name": "S", "rows": [["n", "v"], ["a", 1], ["b", 2], ["sum", "=SUM(B2:B3)"]]}])
    v = F.view("xlsx", name, data)
    assert v["sheets"][0]["rows"][3][1] == "=SUM(B2:B3)"
    v["sheets"][0]["rows"][1][1] = "10"
    v["sheets"][0]["rows"].append(["c", "7"])
    out = F.save("xlsx", name, data, v).data
    rows = F.view("xlsx", name, out)["sheets"][0]["rows"]
    assert rows[1][1] == 10 and rows[4] == ["c", 7] and rows[3][1] == "=SUM(B2:B3)"

    name, data, _ = gen("pptx", "deck", slides=[{"title": "Welcome", "subtitle": "Intro"}, {"title": "Plan", "bullets": ["one", "two"], "notes": "say hi"}])
    v = F.view("pptx", name, data)
    assert len(v["slides"]) == 2 and v["slides"][1]["notes"] == "say hi"
    body = next(s for s in v["slides"][1]["shapes"] if s.get("text") == "one\ntwo")
    body["text"] = "one\ntwo\nthree"
    v["slides"].append({"title": "Added", "bullets": ["x"]})
    v["slides"].pop(0)
    out = F.save("pptx", name, data, v).data
    v2 = F.view("pptx", name, out)
    assert len(v2["slides"]) == 2
    assert "three" in F.text_of("pptx", name, out) and "Added" in F.text_of("pptx", name, out) and "Welcome" not in F.text_of("pptx", name, out)

    name, data, side = gen("pdf", "rep", content=MD)
    v = F.view("pdf", name, data, side)
    assert v["editable"] and v["pages"] == 1 and "Hello world" in v["text"][0]
    v["blocks"][1]["runs"] = [{"t": "Changed text"}]
    saved = F.save("pdf", name, data, v, side)
    assert "Changed text" in F.view("pdf", name, saved.data, saved.sidecar)["text"][0]
    plain_pdf = F.view("pdf", name, data, None)
    assert plain_pdf["editable"] is False
    with pytest.raises(ForgeError):
        F.save("pdf", name, data, {"text": "x"}, None) if False else F.save("audio", "a.mp3", b"", {})


def test_image_and_save():
    buf = io.BytesIO()
    Image.new("RGB", (4, 3), "red").save(buf, "PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    name, data, _ = gen("png", "pic", data_b64=b64)
    v = F.view("image", name, data)
    assert (v["width"], v["height"]) == (4, 3) and v["base64"]
    assert F.save("image", name, data, {"base64": "data:image/png;base64," + b64}).data == buf.getvalue()
    with pytest.raises(ForgeError):
        F.save("image", name, data, {"base64": base64.b64encode(b"nope").decode()})


def test_replace_text_everywhere():
    for fmt, kw in (("md", {"content": "Hello world"}), ("docx", {"content": "Hello world"}),
                    ("pptx", {"slides": [{"title": "Hello world", "bullets": ["x"]}]}),
                    ("xlsx", {"sheets": [{"name": "S", "rows": [["Hello world"]]}]}), ("pdf", {"content": "Hello world"})):
        name, data, side = gen(fmt, "r", **kw)
        saved = F.replace_text(F.kind_of(name), name, data, "world", "Forge", True, side)
        assert "Hello Forge" in F.text_of(F.kind_of(name), name, saved.data, saved.sidecar)
        with pytest.raises(ForgeError):
            F.replace_text(F.kind_of(name), name, data, "absent-text", "x", True, side)


def test_conversions():
    name, data, _ = gen("md", "n", content=MD)
    n, d, _ = F.convert("markdown", name, data, "docx")
    assert n == "n.docx" and "Hello world" in F.text_of("docx", n, d)
    n, d, side = F.convert("docx", n, d, "pdf")
    assert n == "n.pdf" and "Hello world" in F.view("pdf", n, d, side)["text"][0]
    n, d, _ = F.convert("docx", "n.docx", F.convert("markdown", name, data, "docx")[1], "xlsx")
    assert F.view("xlsx", n, d)["sheets"][0]["rows"][0] == ["x", "y"]
    csvn, csvd, _ = gen("csv", "c", content="a,b\n1,2\n")
    xn, xd, _ = F.convert("csv", csvn, csvd, "xlsx")
    assert F.convert("xlsx", xn, xd, "csv")[1].decode() == "a,b\n1,2\n"
    with pytest.raises(ForgeError):
        F.convert("markdown", name, data, "markdown")


def test_more_types_can_be_previewed():
    import zipfile
    assert F.kind_of("main.go") == "text" and F.kind_of("lib.rs") == "text" and F.kind_of("run.ipynb") == "notebook" and F.kind_of("a.zip") == "archive"
    nb = {"cells": [{"cell_type": "markdown", "source": ["# Hi"]},
                    {"cell_type": "code", "source": ["print(1)"], "outputs": [{"output_type": "stream", "text": ["1\n"]}, {"output_type": "execute_result", "data": {"text/plain": ["2"]}}]}],
          "metadata": {"language_info": {"name": "python"}}}
    v = F.view("notebook", "n.ipynb", json.dumps(nb).encode())
    assert [c["type"] for c in v["cells"]] == ["markdown", "code"] and v["cells"][1]["outputs"] == ["1\n", "2"] and v["editable"] is False
    with pytest.raises(ForgeError):
        F.view("notebook", "n.ipynb", b"not json")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("a/b.txt", "hello"); z.writestr("c.md", "x")
    a = F.view("archive", "x.zip", buf.getvalue())
    assert a["count"] == 2 and {e["name"] for e in a["entries"]} == {"a/b.txt", "c.md"} and a["editable"] is False
    with pytest.raises(ForgeError):
        F.view("archive", "x.zip", b"nope")


def test_unknown_extension_that_is_text_is_detected():
    assert F.looks_like_text("héllo wörld\n".encode()) and F.looks_like_text(b"key: value\n")
    assert not F.looks_like_text(b"\x89PNG\r\n\x00\x00") and not F.looks_like_text(b"")
