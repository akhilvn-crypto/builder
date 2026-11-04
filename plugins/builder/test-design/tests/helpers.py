"""Shared test helpers: run a plugin script and parse its JSON output."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN = HERE.parent                # .../builder/test-design (scripts, rules, schemas, templates)
PLUGIN_ROOT = PLUGIN.parent         # .../builder (agents, skills, commands, .claude-plugin)
SCRIPTS = PLUGIN / "scripts"
FIXTURES = HERE / "fixtures"
sys.path.insert(0, str(SCRIPTS))

import td_common as td  # noqa: E402,F401


def run(script: str, *args, cwd: Path | None = None) -> tuple[int, dict]:
    proc = subprocess.run([sys.executable, str(SCRIPTS / script), *map(str, args)],
                          capture_output=True, text=True, cwd=cwd, encoding="utf-8")
    try:
        data = json.loads(proc.stdout) if proc.stdout.strip() else {}
    except ValueError:
        raise AssertionError(f"{script} did not print JSON.\nstdout={proc.stdout}\nstderr={proc.stderr}")
    return proc.returncode, data


class TempProject(unittest.TestCase):
    """A throw-away project root with copies of the story fixtures."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name).resolve()
        shutil.copytree(FIXTURES / "stories", self.root / "stories")

    @property
    def cases_path(self) -> Path:
        return self.root / "test-design" / "test-cases" / "test-cases.md"

    def story_path(self, story_id: str) -> Path:
        """Where the per-story test-case file for ``story_id`` lives."""
        return self.root / "test-design" / "test-cases" / f"{story_id}-testcase.md"

    def write(self, name: str, text: str) -> Path:
        p = self.root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8", newline="\n")
        return p


def case(cid: str, title: str, *, step: str = "Open the page", expected: str = 'The page shows "Welcome"',
         extra: str = "") -> str:
    """Minimal valid test case block."""
    return f"## {cid}: {title}\n{extra}\n### Steps\n1. {step}\n\n### Expected Results\n- {expected}\n"
