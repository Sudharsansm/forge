import pytest

from forge_core import visual_edit as ve
from forge_core.errors import EditError

SRC = (
    'export default function App() {\n  return (\n    <div className="p-4 text-lg bg-gradient-to-r from-a-500">\n'
    '      <h1 className="text-4xl md:text-6xl">Hello</h1>\n      <img src="x.png" />\n'
    '      <p className={cn("a", b)}>Dyn</p>\n    </div>\n  )\n}\n')


def test_describe():
    info = ve.describe(SRC, 4, 6)
    assert info["tag"] == "h1" and info["text"] == "Hello" and info["className"] == "text-4xl md:text-6xl"


def test_font_size_removes_every_variant():
    out = ve.apply_changes(SRC, 4, 6, {"fontSize": 20})
    assert 'className="text-[20px]"' in out and "md:text-6xl" not in out
    assert not ve.has_syntax_errors(out)


def test_background_replaces_gradient_but_keeps_others():
    out = ve.apply_changes(SRC, 3, 4, {"bgColor": "#112233"})
    assert 'className="p-4 text-lg bg-[#112233]"' in out


def test_adds_className_to_self_closing_element():
    out = ve.apply_changes(SRC, 5, 6, {"padding": 8})
    assert '<img className="p-[8px]" src="x.png" />' in out


def test_text_with_special_characters_is_escaped():
    out = ve.apply_changes(SRC, 4, 6, {"text": "a < b"})
    assert '{"a < b"}' in out and not ve.has_syntax_errors(out)


def test_dynamic_classname_is_refused():
    with pytest.raises(EditError):
        ve.apply_changes(SRC, 6, 6, {"padding": 8})


@pytest.mark.parametrize("changes", [{"textColor": "red"}, {"padding": 9999}, {"fontWeight": "huge"}, {}])
def test_invalid_changes_rejected(changes):
    with pytest.raises(EditError):
        ve.apply_changes(SRC, 4, 6, changes)


def test_wrong_position_is_a_clear_error():
    with pytest.raises(EditError):
        ve.apply_changes(SRC, 1, 0, {"padding": 4})
    with pytest.raises(EditError):
        ve.apply_changes(SRC, 99, 0, {"padding": 4})
