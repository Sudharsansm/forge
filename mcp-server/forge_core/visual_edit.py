"""AST-based edits of a single JSX element (found by file:line:col), using tree-sitter.

The preview tags every host element with data-forge-src="path:line:col" where line is 1-based and col
is the 0-based column of the '<' that opens the element. These functions find that exact element and
change only it (its className / its text), leaving the rest of the file untouched.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

import tree_sitter_typescript as tsts
from tree_sitter import Language, Node, Parser

from .errors import EditError

_PARSER = Parser(Language(tsts.language_tsx()))

_COLOR_VAL = r"(?:\[(?:#|rgb|hsl|oklch|color:)[^\]]*\]|(?:white|black|transparent|current|inherit)|[a-z]+-\d{2,3})(?:/\d+)?"
GROUPS: dict[str, re.Pattern] = {
    "text_color": re.compile(rf"^text-{_COLOR_VAL}$"),
    "bg_color": re.compile(rf"^bg-{_COLOR_VAL}$"),
    "gradient": re.compile(r"^(?:bg-(?:gradient|linear|radial|conic)-\S+|from-\S+|via-\S+|to-\S+)$"),
    "font_size": re.compile(r"^text-(?:xs|sm|base|lg|xl|\d+xl|\[\d+(?:\.\d+)?(?:px|rem|em)\])$"),
    "padding": re.compile(r"^p[xytrblse]?-(?:\d+(?:\.\d+)?|px|\[[^\]]+\])$"),
    "font_weight": re.compile(r"^font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$"),
}
_HEX = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
_WEIGHTS = {"thin", "extralight", "light", "normal", "medium", "semibold", "bold", "extrabold", "black"}


def parse(src: str):
    return _PARSER.parse(src.encode("utf-8"))


def has_syntax_errors(src: str) -> bool:
    return parse(src).root_node.has_error


@dataclass
class Element:
    opening: Node  # jsx_opening_element or jsx_self_closing_element
    element: Node  # jsx_element, or the self-closing element itself
    data: bytes


def _byte_offset(src: str, line: int, col: int) -> int:
    lines = src.split("\n")
    if line < 1 or line > len(lines):
        raise EditError(f"Line {line} does not exist in this file")
    char_off = sum(len(x) + 1 for x in lines[: line - 1]) + col
    if char_off > len(src):
        raise EditError("Column is past the end of the file")
    return len(src[:char_off].encode("utf-8"))


def locate(src: str, line: int, col: int) -> Element:
    data = src.encode("utf-8")
    root = _PARSER.parse(data).root_node
    off = _byte_offset(src, line, col)
    node = root.descendant_for_byte_range(off, off + 1)
    while node is not None:
        if node.type in ("jsx_opening_element", "jsx_self_closing_element") and node.start_byte == off:
            parent = node.parent
            element = parent if node.type == "jsx_opening_element" and parent is not None else node
            return Element(node, element, data)
        node = node.parent
    raise EditError(f"No JSX element starts at {line}:{col}. The file may have changed; select the element again.")


def _text(node: Node, data: bytes) -> str:
    return data[node.start_byte:node.end_byte].decode("utf-8")


def _tag_name(el: Element) -> str:
    name = el.opening.child_by_field_name("name")
    return _text(name, el.data) if name else "?"


def _class_attr(el: Element) -> Node | None:
    for child in el.opening.children:
        if child.type == "jsx_attribute" and child.children and _text(child.children[0], el.data) == "className":
            return child
    return None


def _class_literal(el: Element, attr: Node) -> Node | None:
    """The string node holding className, or None when it is dynamic (cn(...), template, variable)."""
    value = attr.children[-1] if len(attr.children) >= 3 else None
    if value is None:
        return None
    if value.type == "string":
        return value
    if value.type == "jsx_expression":
        inner = [c for c in value.children if c.type not in ("{", "}")]
        if len(inner) == 1 and inner[0].type == "string":
            return inner[0]
    return None


def _simple_text(el: Element) -> str | None:
    if el.element.type != "jsx_element":
        return None
    kids = el.element.children[1:-1]
    if any(k.type != "jsx_text" for k in kids):
        return None
    return "".join(_text(k, el.data) for k in kids).strip()


def describe(src: str, line: int, col: int) -> dict:
    el = locate(src, line, col)
    attr = _class_attr(el)
    literal = _class_literal(el, attr) if attr else None
    return {
        "tag": _tag_name(el),
        "className": _text(literal, el.data)[1:-1] if literal else None,
        "dynamicClassName": bool(attr and not literal),
        "text": _simple_text(el),
        "selfClosing": el.opening.type == "jsx_self_closing_element",
    }


def _splice(data: bytes, start: int, end: int, new: str) -> str:
    return (data[:start] + new.encode("utf-8") + data[end:]).decode("utf-8")


def _utility(token: str) -> str:
    return token.rsplit(":", 1)[-1].lstrip("!")


def update_classes(src: str, line: int, col: int, add: list[str], remove_groups: list[str]) -> str:
    el = locate(src, line, col)
    attr = _class_attr(el)
    if attr is None:
        tokens: list[str] = []
    else:
        literal = _class_literal(el, attr)
        if literal is None:
            raise EditError("This element's className is dynamic (cn(...), a variable or a template). "
                            "Edit it in the code editor or ask the AI.")
        tokens = _text(literal, el.data)[1:-1].split()
    patterns = [GROUPS[g] for g in remove_groups]
    # Remove the group's classes under every variant (md:text-6xl, hover:bg-x ...) so the new value wins.
    kept = [t for t in tokens if not any(p.match(_utility(t)) for p in patterns)]
    for token in add:
        if token not in kept:
            kept.append(token)
    value = " ".join(kept)
    if attr is None:
        name = el.opening.child_by_field_name("name")
        if name is None:
            raise EditError("Could not find the element name")
        out = _splice(el.data, name.end_byte, name.end_byte, f' className="{value}"')
    else:
        literal = _class_literal(el, attr)
        assert literal is not None
        quote = _text(literal, el.data)[0]
        out = _splice(el.data, literal.start_byte, literal.end_byte, f"{quote}{value}{quote}")
    return _checked(src, out)


def set_text(src: str, line: int, col: int, new_text: str) -> str:
    el = locate(src, line, col)
    if el.element.type != "jsx_element":
        raise EditError("This element has no text content")
    kids = el.element.children[1:-1]
    if any(k.type != "jsx_text" for k in kids):
        raise EditError("This element contains nested elements or expressions; edit it in the code editor.")
    new_text = new_text.strip()
    body = json.dumps(new_text, ensure_ascii=False) if re.search(r"[{}<>&]", new_text) else new_text
    if body != new_text:
        body = "{" + body + "}"
    if kids:
        start, end = kids[0].start_byte, kids[-1].end_byte
        original = el.data[start:end].decode("utf-8")
        lead = original[: len(original) - len(original.lstrip())]
        trail = original[len(original.rstrip()):]
        replacement = lead + body + trail
    else:
        start = end = el.element.children[0].end_byte
        replacement = body
    return _checked(src, _splice(el.data, start, end, replacement))


def plan_classes(changes: dict) -> tuple[list[str], list[str]]:
    add: list[str] = []
    remove: list[str] = []
    if changes.get("textColor"):
        c = str(changes["textColor"])
        if not _HEX.match(c):
            raise EditError("textColor must be a hex color like #ff0000")
        add.append(f"text-[{c}]")
        remove.append("text_color")
    if changes.get("bgColor"):
        c = str(changes["bgColor"])
        if not _HEX.match(c):
            raise EditError("bgColor must be a hex color like #ff0000")
        add.append(f"bg-[{c}]")
        remove += ["bg_color", "gradient"]  # a gradient would hide a plain background color
    if changes.get("padding") is not None:
        n = _number(changes["padding"], 0, 400, "padding")
        add.append(f"p-[{n}px]")
        remove.append("padding")
    if changes.get("fontSize") is not None:
        n = _number(changes["fontSize"], 4, 200, "fontSize")
        add.append(f"text-[{n}px]")
        remove.append("font_size")
    if changes.get("fontWeight"):
        w = str(changes["fontWeight"])
        if w not in _WEIGHTS:
            raise EditError(f"fontWeight must be one of {sorted(_WEIGHTS)}")
        add.append(f"font-{w}")
        remove.append("font_weight")
    return add, remove


def _number(value, lo: int, hi: int, name: str) -> int:
    try:
        n = int(round(float(value)))
    except (TypeError, ValueError):
        raise EditError(f"{name} must be a number") from None
    if not lo <= n <= hi:
        raise EditError(f"{name} must be between {lo} and {hi}")
    return n


def apply_changes(src: str, line: int, col: int, changes: dict) -> str:
    out = src
    add, remove = plan_classes(changes)
    if add or remove:
        out = update_classes(out, line, col, add, remove)
    if changes.get("text") is not None:
        out = set_text(out, line, col, str(changes["text"]))
    if out == src and not (add or remove or changes.get("text") is not None):
        raise EditError("No changes were provided")
    return out


def _checked(before: str, after: str) -> str:
    if not has_syntax_errors(before) and has_syntax_errors(after):
        raise EditError("The edit would produce invalid code, so it was not applied.")
    return after
