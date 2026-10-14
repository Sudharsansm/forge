import sys, pathlib; sys.path.insert(0, str(pathlib.Path(__file__).parent))
import os

os.environ.pop("FORGE_API_KEY", None)

import pytest  # noqa: E402

SAMPLE_APP = (
    'export default function App() {\n  return (\n    <div className="p-4 text-lg bg-gradient-to-r from-a-500">\n'
    '      <h1 className="text-4xl md:text-6xl">Hello</h1>\n      <img src="x.png" />\n    </div>\n  )\n}\n')


@pytest.fixture(scope="session", autouse=True)
def _seed():
    """The server starts empty (nothing is stored); the tests work on a default project holding one sample component."""
    from forge_core.core import core

    core.projects.get("default").files["src/App.tsx"] = SAMPLE_APP
    yield


@pytest.fixture(scope="session")
def client():
    """One app instance for the whole run (the MCP session manager can only be started once per process)."""
    from fastapi.testclient import TestClient

    from forge_core.api import app

    with TestClient(app, base_url="http://localhost") as c:
        yield c
