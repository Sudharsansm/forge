"""'Edit with Claude': send the selected element + its file to the Claude API, write the result back."""
from __future__ import annotations

import os
import re

from . import config, visual_edit
from .core import core
from .errors import EditError, ForgeError

SYSTEM = (
    "You are a senior React + TypeScript + Tailwind CSS engineer editing one file of a React project (compiled in the browser). "
    "Apply the user's instruction. If an element location is given, change that element (and only what "
    "the instruction needs); keep everything else identical. Return the COMPLETE updated file inside "
    "<file> and </file> tags and nothing else."
)


def _build_prompt(path: str, content: str, instruction: str, selection: dict | None, line: int | None, col: int | None) -> str:
    parts = [f"File: {path}", f"Instruction: {instruction}"]
    if line is not None and col is not None:
        parts.append(f"Selected element starts at line {line}, column {col} (0-based).")
        if selection:
            parts.append(f"It renders as <{selection.get('tag')}> with classes: {selection.get('className')!r} "
                         f"and text: {selection.get('text')!r}.")
    parts.append(f"Current file:\n<file>\n{content}\n</file>")
    return "\n\n".join(parts)


def edit_with_claude(project: str, instruction: str, path: str | None = None,
                     line: int | None = None, col: int | None = None) -> dict:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise ForgeError("ANTHROPIC_API_KEY is not set on the server. Set it, or use 'Send to MCP assistant'.")
    state = core.state(project)
    selection = state.selection
    if selection and path is None:
        path, line, col = selection.get("path"), selection.get("line"), selection.get("col")
    if not path:
        raise ForgeError("Select a component or choose a file first")
    files = core.files(project)
    current = files.read(path)

    import anthropic  # imported lazily so the server starts without the key

    client = anthropic.Anthropic()
    message = client.messages.create(
        model=config.AI_MODEL,
        max_tokens=16000,
        system=SYSTEM,
        messages=[{"role": "user", "content": _build_prompt(path, current["content"], instruction, selection, line, col)}],
    )
    text = "".join(block.text for block in message.content if getattr(block, "type", "") == "text")
    match = re.search(r"<file>\n?(.*)</file>", text, re.S)
    if not match:
        raise EditError("The model did not return a file; nothing was changed.")
    new_content = match.group(1)
    if path.endswith((".tsx", ".ts", ".jsx", ".js")) and visual_edit.has_syntax_errors(new_content) \
            and not visual_edit.has_syntax_errors(current["content"]):
        raise EditError("The model returned code with syntax errors; nothing was changed.")
    result = files.write(path, new_content, source="ai", base_hash=current["hash"])
    return {**result, "model": config.AI_MODEL}
