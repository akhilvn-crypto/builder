"""The test-design stages as part of the builder plugin.

Static contract checks over the plugin's commands, agents and skills (every reference resolves, publishing is reachable only by the
user typing its command) and one behavioural check that the scripts the orchestrator's stage scopes rely on do what the contract says.
"""
from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

from helpers import PLUGIN, PLUGIN_ROOT, TempProject, run

COMMANDS = PLUGIN_ROOT / "commands"
AGENTS = PLUGIN_ROOT / "agents"
SKILLS = PLUGIN_ROOT / "skills"

DESIGN_COMMANDS = {"design-test-n-automation", "generate-test-cases", "publish-zephyr"}
# the plugin's whole user-facing command set: test design, design + automation, and the separate automation flow
ALL_COMMANDS = DESIGN_COMMANDS | {"do-automation"}
DESIGN_AGENTS = {"story-analyser", "story-worker", "test-coverage-designer", "test-case-generator", "test-case-quality-checker",
                 "test-design-orchestrator"}
DESIGN_SKILLS = {"story-analysis", "story-source-discovery", "test-case-authoring", "test-case-validation", "test-coverage-design",
                 "workflow-resume", "zephyr-publishing"}


def frontmatter(path: Path) -> dict[str, str]:
    m = re.match(r"---\n(.*?)\n---\n", path.read_text(encoding="utf-8"), re.S)
    assert m, f"{path} has no front matter"
    out = {}
    for line in m.group(1).splitlines():
        if ":" in line and not line.startswith(" "):
            k, v = line.split(":", 1)
            out[k.strip()] = v.strip()
    return out


def plugin_markdown() -> list[Path]:
    return [p for d in (COMMANDS, AGENTS, SKILLS) for p in d.rglob("*.md")]


class Inventory(unittest.TestCase):
    def test_the_design_stages_are_part_of_the_plugin(self):
        self.assertEqual(ALL_COMMANDS, {p.stem for p in COMMANDS.glob("*.md")})
        self.assertTrue(DESIGN_AGENTS <= {p.stem for p in AGENTS.glob("*.md")})
        self.assertTrue(DESIGN_SKILLS <= {p.parent.name for p in SKILLS.glob("*/SKILL.md")})

    def test_existing_automation_builder_commands_are_still_there(self):
        for name in ("do-automation",):
            self.assertTrue((COMMANDS / f"{name}.md").is_file(), name)
        for name in ("init", "playwright-pipeline", "generate-tests", "run-tests", "heal-tests", "reports"):
            self.assertTrue((SKILLS / name / "SKILL.md").is_file(), name)
        for name in ("test-analyst", "application-explorer", "playwright-generator", "test-reviewer", "test-executor", "failure-healer", "data-cleaner"):
            self.assertTrue((AGENTS / f"{name}.md").is_file(), name)

    def test_every_command_is_user_triggered_only(self):
        for p in COMMANDS.glob("*.md"):
            fm = frontmatter(p)
            self.assertEqual(fm.get("disable-model-invocation"), "true", p.name)
            self.assertTrue(fm.get("description"), p.name)

    def test_every_namespaced_reference_resolves(self):
        agents = {p.stem for p in AGENTS.glob("*.md")}
        skills = {frontmatter(p)["name"] for p in SKILLS.glob("*/SKILL.md")}
        commands = {p.stem for p in COMMANDS.glob("*.md")}
        for p in plugin_markdown():
            text = re.sub(r"<!--.*?-->", "", p.read_text(encoding="utf-8"), flags=re.S)  # the CLAUDE.md block markers are not references
            # "@builder:generated" is the marker line of pipeline-written test files, not a reference
            for ref in re.findall(r"(?<![/\w@-])builder:([a-z][a-z-]*)", text):
                self.assertIn(ref, agents | skills | commands, f"{p.relative_to(PLUGIN_ROOT)} refers to builder:{ref}")
            for ref in re.findall(r"/builder:([a-z][a-z-]*)", text):
                self.assertIn(ref, commands | skills, f"{p.relative_to(PLUGIN_ROOT)} refers to /builder:{ref}")
        self.assertNotIn("test-design-pipeline", "".join(p.read_text(encoding="utf-8") for p in plugin_markdown()))

    def test_every_plugin_path_in_the_docs_exists(self):
        for p in plugin_markdown():
            for rel in re.findall(r"\$\{CLAUDE_PLUGIN_ROOT\}/([A-Za-z0-9_./-]+)", p.read_text(encoding="utf-8")):
                rel = rel.rstrip(".,;:)")
                if "*" in rel or rel.endswith("/"):
                    self.assertTrue((PLUGIN_ROOT / rel.rstrip("/")).exists() or not rel.rstrip("/"), f"{p.name}: {rel}")
                    continue
                self.assertTrue((PLUGIN_ROOT / rel).exists(), f"{p.relative_to(PLUGIN_ROOT)} points at ${{CLAUDE_PLUGIN_ROOT}}/{rel}")
        # the relative links of the commands
        for p in COMMANDS.glob("*.md"):
            for rel in re.findall(r"\]\((\.\./[^)#]+)", p.read_text(encoding="utf-8")):
                self.assertTrue((p.parent / rel).resolve().exists(), f"{p.name}: {rel}")

    def test_agent_skill_lists_resolve(self):
        skills = {frontmatter(p)["name"] for p in SKILLS.glob("*/SKILL.md")}
        for p in AGENTS.glob("*.md"):
            listed = frontmatter(p).get("skills", "")
            for ref in [x.strip() for x in listed.split(",") if x.strip()]:
                self.assertIn(ref.split(":")[-1], skills, f"{p.name}: {ref}")

    def test_version_and_marketplace_agree(self):
        manifest = json.loads((PLUGIN_ROOT / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
        market = json.loads((PLUGIN_ROOT.parent.parent / ".claude-plugin" / "marketplace.json").read_text(encoding="utf-8"))
        self.assertEqual(market["plugins"][0]["version"], manifest["version"])


class PublishIsManualOnly(unittest.TestCase):
    """`publish-zephyr` runs only when the user types it. Nothing in any workflow may reach it."""

    ALLOWED = {  # files that may name the command, and then only to say it is not part of the workflow
        "commands/publish-zephyr.md", "skills/zephyr-publishing/SKILL.md", "commands/design-test-n-automation.md",
        "commands/generate-test-cases.md", "agents/test-design-orchestrator.md", "skills/playwright-pipeline/stages.md",
    }
    NEGATING = re.compile(r"never|not\b|manual|separate|only the user|types? ", re.I)

    def test_only_the_publish_command_and_its_skill_reach_zephyr(self):
        for p in plugin_markdown():
            rel = p.relative_to(PLUGIN_ROOT).as_posix()
            text = p.read_text(encoding="utf-8")
            if rel in ("commands/publish-zephyr.md", "skills/zephyr-publishing/SKILL.md"):
                continue
            if rel in self.ALLOWED:
                # allowed to name the command only to say it is manual / never part of the workflow
                for n, line in enumerate(text.splitlines(), 1):
                    if "publish-zephyr" in line or "zephyr-publish.py" in line:
                        self.assertRegex(line, self.NEGATING, f"{rel}:{n} mentions the publish command without saying it is manual/never: {line.strip()}")
            else:
                for needle in ("publish-zephyr", "zephyr-publish.py", "zephyr-publishing"):
                    self.assertNotIn(needle, text, f"{rel} mentions {needle}")

    def test_the_model_cannot_load_the_publish_skill_or_command_by_itself(self):
        self.assertEqual(frontmatter(COMMANDS / "publish-zephyr.md")["disable-model-invocation"], "true")
        self.assertEqual(frontmatter(SKILLS / "zephyr-publishing" / "SKILL.md")["disable-model-invocation"], "true")

    def test_no_agent_has_the_publish_skill_or_the_atlassian_tools(self):
        for p in AGENTS.glob("*.md"):
            fm = frontmatter(p)
            self.assertNotIn("zephyr", fm.get("skills", ""), p.name)
            self.assertNotIn("atlassian", fm.get("tools", "").lower(), p.name)
            self.assertNotIn("mcp__", fm.get("tools", ""), p.name)

    def test_the_end_to_end_command_and_the_orchestrator_say_they_never_publish(self):
        e2e = (COMMANDS / "design-test-n-automation.md").read_text(encoding="utf-8")
        self.assertIn("Publishing is not part of this command", e2e)
        self.assertRegex(e2e, r"Do not use the Atlassian/Jira connector")
        orch = (AGENTS / "test-design-orchestrator.md").read_text(encoding="utf-8")
        self.assertIn("**Never publish.**", orch)

    def test_the_engine_has_no_publish_path(self):
        engine = PLUGIN_ROOT / "template" / "dependencies" / "engine"
        for p in engine.rglob("*.ts"):
            text = p.read_text(encoding="utf-8").lower()
            self.assertNotIn("zephyr", text, p.name)
            self.assertNotIn("atlassian", text, p.name)


class StageScopes(unittest.TestCase):
    def test_the_design_command_names_its_scope(self):
        self.assertIn("`SCOPE` = `all`", (COMMANDS / "generate-test-cases.md").read_text(encoding="utf-8"))
        orch = (AGENTS / "test-design-orchestrator.md").read_text(encoding="utf-8")
        for scope in ("all", "analyse", "design", "generate"):
            self.assertRegex(orch, rf"\| `{scope}`")
        self.assertIn("state/conditions/S.json", orch)

    def test_the_orchestrator_does_not_run_earlier_stages_for_a_scoped_command(self):
        orch = (AGENTS / "test-design-orchestrator.md").read_text(encoding="utf-8")
        self.assertIn("do not run the earlier stage for the user", orch)


class SavedConditions(TempProject):
    """The orchestrator saves the design step's conditions with `safe-file-operations.py write`; check that is safe to rely on."""

    def test_saved_conditions_can_be_written_hashed_and_only_replaced_with_a_backup(self):
        root = self.root
        analysis = root / "analysis.json"
        analysis.write_text('{"story_id": "US-001"}', encoding="utf-8")
        code, h = run("safe-file-operations.py", "hash", analysis)
        self.assertEqual(code, 0)
        digest = h["hashes"][str(analysis)]
        self.assertEqual(len(digest), 64)

        src = root / "conditions-US-001.json"
        payload = {"version": 1, "storyId": "US-001", "analysisSha256": digest,
                   "conditions": [{"condition": "x", "technique": "positive", "covers": ["US-001#AC-1"]}], "uncovered": []}
        src.write_text(json.dumps(payload), encoding="utf-8")
        target = "test-design/state/conditions/US-001.json"
        code, out = run("safe-file-operations.py", "write", "--root", root, "--target", target, "--source", src)
        self.assertEqual(code, 0, out)
        saved = root / target
        self.assertEqual(json.loads(saved.read_text(encoding="utf-8")), payload)

        payload["conditions"].append({"condition": "y", "technique": "negative", "covers": ["US-001#AC-2"]})
        src.write_text(json.dumps(payload), encoding="utf-8")
        code, out = run("safe-file-operations.py", "write", "--root", root, "--target", target, "--source", src)
        self.assertNotEqual(code, 0, "replacing saved conditions needs --allow-overwrite")
        code, out = run("safe-file-operations.py", "write", "--root", root, "--target", target, "--source", src, "--allow-overwrite")
        self.assertEqual(code, 0, out)
        self.assertEqual(len(json.loads(saved.read_text(encoding="utf-8"))["conditions"]), 2)
        backups = list((root / "test-design" / "state" / "backups").rglob("*"))
        self.assertTrue([b for b in backups if b.is_file()], "the replaced conditions are backed up")

    def test_a_target_outside_the_design_folder_is_refused(self):
        src = self.root / "c.json"
        src.write_text("{}", encoding="utf-8")
        code, out = run("safe-file-operations.py", "write", "--root", self.root, "--target", "../outside.json", "--source", src)
        self.assertNotEqual(code, 0, out)


if __name__ == "__main__":
    unittest.main()
