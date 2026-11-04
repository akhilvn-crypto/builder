"""Shared helpers for the Test Design scripts (Python standard library only).

The CLI scripts in this folder have hyphenated names (``validate-test-cases.py``), so they
cannot be imported. Everything they share lives here: story splitting, the canonical
test-case parser and validator, a small JSON-Schema checker, secret detection and the
confined atomic writer.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

SCHEMA_DIR = Path(__file__).resolve().parent.parent / "schemas"
OUTPUT_DIRNAME = "test-design"
TESTCASE_DIRNAME = "test-cases"
TESTCASE_SUFFIX = "-testcase.md"          # one file per user story: <USER_STORY_ID>-testcase.md
LEGACY_TESTCASE_FILE = "test-cases.md"    # the consolidated file written by plugin versions before 0.5.0

# Exit codes shared by every script.
EXIT_OK, EXIT_FINDINGS, EXIT_USAGE, EXIT_CONFLICT, EXIT_MISSING, EXIT_CONFINED, EXIT_IO = 0, 1, 2, 3, 4, 5, 6


# --------------------------------------------------------------------------- basics

def utc_now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def sha256_file(path: Path) -> str:
    return sha256_bytes(Path(path).read_bytes())


def read_text(path: Path) -> str:
    """Read UTF-8 (BOM tolerated)."""
    return Path(path).read_bytes().decode("utf-8-sig")


def detect_newline(text: str) -> str:
    return "\r\n" if text.count("\r\n") > text.count("\n") / 2 and "\r\n" in text else "\n"


def emit(obj: Any) -> None:
    """Print JSON that is safe on any console code page."""
    sys.stdout.write(json.dumps(obj, indent=2, ensure_ascii=True) + "\n")


def fail(code: str, message: str, exit_code: int) -> "SystemExit":
    emit({"ok": False, "error": {"code": code, "message": message}})
    return SystemExit(exit_code)


def slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-")


def normalize_title(title: str) -> str:
    t = unicodedata.normalize("NFKC", title).lower()
    return re.sub(r"[^a-z0-9]+", " ", t).strip()


# --------------------------------------------------------------------------- stories

STORY_HEADING_RE = re.compile(
    r"^(#{1,6})[ \t]+(?:Story[ \t]+)?([A-Z][A-Z0-9]{1,9}-\d+)\b[ \t]*[—–:\-]?[ \t]*(.*?)[ \t]*#*[ \t]*$"
)
ANY_HEADING_RE = re.compile(r"^(#{1,6})[ \t]+\S")
FENCE_RE = re.compile(r"^\s*(```|~~~)")


@dataclass
class Story:
    id: str
    title: str
    level: int
    start: int  # 1-based, inclusive
    end: int  # 1-based, inclusive
    sha256: str
    id_inferred: bool = False

    def brief(self) -> dict:
        return {"id": self.id, "title": self.title, "startLine": self.start, "endLine": self.end,
                "sha256": self.sha256, "idInferred": self.id_inferred}


def _normalise_for_hash(lines: list[str]) -> str:
    return "\n".join(l.rstrip() for l in lines).strip() + "\n"


def split_stories(text: str, fallback_name: str = "STORY") -> list[Story]:
    """Split a Markdown file into stories by story-ID headings (``## US-001 - Title``).

    A story runs until the next story heading or the next heading of the same or higher
    level. A file without any story heading is one story whose ID is inferred from the
    file name (``idInferred`` is true so the orchestrator can ask the user).
    """
    lines = text.splitlines()
    heads: list[tuple[int, int, Optional[tuple[str, str]]]] = []  # (index, level, (id,title)|None)
    in_fence = False
    for i, raw in enumerate(lines):
        if FENCE_RE.match(raw):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = STORY_HEADING_RE.match(raw)
        if m:
            heads.append((i, len(m.group(1)), (m.group(2), m.group(3) or m.group(2))))
        else:
            h = ANY_HEADING_RE.match(raw)
            if h:
                heads.append((i, len(h.group(1)), None))

    stories: list[Story] = []
    for n, (idx, level, ident) in enumerate(heads):
        if ident is None:
            continue
        end = len(lines)
        for j_idx, j_level, _ in heads[n + 1:]:
            if j_level <= level or _is_story(heads, j_idx):
                end = j_idx
                break
        body = lines[idx:end]
        while body and not body[-1].strip():
            body.pop()
        stories.append(Story(ident[0], ident[1], level, idx + 1, idx + len(body),
                             sha256_text(_normalise_for_hash(body))))
    if stories:
        return stories

    body = [l for l in lines]
    first_heading = next((l.lstrip("# ").strip() for l in lines if ANY_HEADING_RE.match(l)), "")
    sid = slug(fallback_name).upper() or "STORY"
    return [Story(sid, first_heading or fallback_name, 0, 1, max(len(body), 1),
                  sha256_text(_normalise_for_hash(body)), id_inferred=True)]


def _is_story(heads, idx) -> bool:
    return any(h[0] == idx and h[2] is not None for h in heads)


# --------------------------------------------------------------------------- findings

@dataclass
class Finding:
    code: str
    severity: str  # "error" | "warning"
    message: str
    line: Optional[int] = None
    case_id: Optional[str] = None

    def as_dict(self) -> dict:
        d = {"code": self.code, "severity": self.severity, "message": self.message}
        if self.line is not None:
            d["line"] = self.line
        if self.case_id:
            d["caseId"] = self.case_id
        return d


# --------------------------------------------------------------------------- secrets

SECRET_TOKEN_PATTERNS = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]{20,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"(?i)\b(password|passwd|secret|api[_-]?key|token)\b\s*=\s*[^\s'\"]{4,}"),
    re.compile(r"(?i)\"(password|passwd|secret|api[_-]?key|token)\"\s*:\s*\"(?!env:)[^\"]{4,}\""),
]


def contains_secret(text: str) -> bool:
    return any(p.search(text) for p in SECRET_TOKEN_PATTERNS)


_SECRET_LONG = ("password", "passwd", "passcode", "secret", "token", "apikey", "credential", "privatekey")
_SECRET_SHORT = {"pwd", "otp", "cvv", "ssn", "pin", "pass"}


def is_secret_name(name: str) -> bool:
    """True when a Test Data variable name suggests a credential (``password``, ``api_key``...)."""
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", name)
    tokens = {t for t in re.split(r"[^A-Za-z0-9]+", spaced.lower()) if t}
    if tokens & _SECRET_SHORT:
        return True
    joined = re.sub(r"[^a-z0-9]", "", name.lower())
    return any(w in joined for w in _SECRET_LONG)


# --------------------------------------------------------------------------- JSON schema subset

class SchemaError(Exception):
    pass


def load_schema(name: str) -> dict:
    path = SCHEMA_DIR / (name if name.endswith(".json") else f"{name}.schema.json")
    if not path.is_file():
        raise SchemaError(f"unknown schema '{name}'")
    return json.loads(path.read_text(encoding="utf-8"))


def _type_ok(value: Any, t: str) -> bool:
    if t == "string":
        return isinstance(value, str)
    if t == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if t == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if t == "boolean":
        return isinstance(value, bool)
    if t == "object":
        return isinstance(value, dict)
    if t == "array":
        return isinstance(value, list)
    if t == "null":
        return value is None
    return False


def validate_json(value: Any, schema: dict, path: str = "$") -> list[str]:
    """Validate against the JSON-Schema subset the plugin schemas use.

    Supported: type, enum, const, required, properties, additionalProperties, items,
    minItems, minLength, minimum, pattern, ``$ref`` to a sibling schema file.
    """
    errors: list[str] = []
    if "$ref" in schema:
        return validate_json(value, load_schema(schema["$ref"]), path)
    t = schema.get("type")
    if t is not None:
        types = t if isinstance(t, list) else [t]
        if not any(_type_ok(value, x) for x in types):
            return [f"{path}: expected {'|'.join(types)}, got {type(value).__name__}"]
    if "const" in schema and value != schema["const"]:
        errors.append(f"{path}: must equal {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: must be one of {schema['enum']}")
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(f"{path}: shorter than {schema['minLength']}")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append(f"{path}: does not match pattern {schema['pattern']}")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}: below minimum {schema['minimum']}")
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}: missing required '{key}'")
        props = schema.get("properties", {})
        extra = schema.get("additionalProperties", True)
        for key, sub in value.items():
            if key in props:
                errors += validate_json(sub, props[key], f"{path}.{key}")
            elif extra is False:
                errors.append(f"{path}: unexpected property '{key}'")
            elif isinstance(extra, dict):
                errors += validate_json(sub, extra, f"{path}.{key}")
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{path}: needs at least {schema['minItems']} item(s)")
        if "items" in schema:
            for i, sub in enumerate(value):
                errors += validate_json(sub, schema["items"], f"{path}[{i}]")
    return errors


# --------------------------------------------------------------------------- test-case parser

CASE_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)+$")
AUTO_ID_RE = re.compile(r"^AUTO-[0-9a-f]{8}$")
_HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(\S.*?)[ \t]*$")
_CASE_HEAD_RE = re.compile(r"^(?P<id>[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)+)[ \t]*:[ \t]*(?P<title>.*)$")
_FIELD_RE = re.compile(r"^(Priority|Tags|Depends on):[ \t]*(.*)$")
_STORY_FIELD_RE = re.compile(r"^User Story ID:[ \t]*(.*)$")
# Story IDs are free-form tokens such as US-001 or PROJ-123 (also tolerates IDs inferred from a file name).
STORY_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
STORY_FIELD = "User Story ID"
_STEP_RE = re.compile(r"^(\d+)\.[ \t]+(.*)$")
_BULLET_RE = re.compile(r"^[-*][ \t]+(.*)$")
_DATA_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$")
_VAR_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")
_EXPECTED_SPLIT_RE = re.compile(r"[ \t]*->[ \t]*[Ee]xpected[ \t]*:[ \t]*")
ENV_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")

SECTION_NAMES = ("Preconditions", "Test Data", "Steps", "Expected Results")
KNOWN_PRIORITIES = {"critical", "high", "medium", "low"}

_IMPL_PATTERNS = [
    re.compile(r"\bpage\.\w+\("), re.compile(r"\b(getBy\w+|locator|querySelector\w*)\("),
    re.compile(r"\b(await|expect)\s*\("), re.compile(r"\bawait\s+\w"), re.compile(r"\bcy\.\w+"),
    re.compile(r"\bdriver\.\w+"), re.compile(r"\bBy\.\w+"), re.compile(r"\bdocument\.\w+"),
    re.compile(r"//[A-Za-z*]+\[@"), re.compile(r"\[data-[\w-]+"), re.compile(r"\[@\w+"),
    re.compile(r"(?:^|\s)#[A-Za-z][\w-]*(?=\s|$|[,.;:])"),
]
_VAGUE_RE = re.compile(r"(?i)\b(correctly|properly|as expected|appropriately|gracefully|works? fine|is fine|no issues?)\b")
_WEAK_WHOLE_RE = re.compile(r"(?i)^(it )?(works?|ok|okay|passes|succeeds|is (correct|successful|fine))\.?$")
_PLACEHOLDER_RE = re.compile(r"(?i)(\bTBD\b|\bTODO\b|\bFIXME\b|\?\?\?|<[^>\n]{1,40}>|\blorem ipsum\b)")


@dataclass
class Section:
    name: str
    line: int  # 1-based heading line
    lines: list[tuple[int, str]] = field(default_factory=list)  # (1-based line, text)


@dataclass
class Step:
    num: int
    text: str
    line: int
    expected: Optional[str] = None


@dataclass
class DataItem:
    name: str
    raw: str
    line: int

    @property
    def kind(self) -> str:
        if self.raw.startswith("env:"):
            return "env"
        if self.raw.startswith("literal:"):
            return "literal"
        return "plain"

    @property
    def value(self) -> str:
        return self.raw.split(":", 1)[1] if self.kind != "plain" else self.raw


@dataclass
class Case:
    id: Optional[str]
    title: str
    module: Optional[str]
    line: int  # 1-based heading line
    start: int  # 0-based index of heading line
    end: int = 0  # 0-based exclusive, trailing blank lines trimmed
    fields: dict[str, str] = field(default_factory=dict)
    field_lines: dict[str, int] = field(default_factory=dict)
    sections: dict[str, Section] = field(default_factory=dict)
    section_order: list[str] = field(default_factory=list)
    preconditions: list[str] = field(default_factory=list)
    data: dict[str, DataItem] = field(default_factory=dict)
    steps: list[Step] = field(default_factory=list)
    expected: list[tuple[int, str]] = field(default_factory=list)
    story_id: Optional[str] = None  # inherited from the enclosing module's "User Story ID:" line

    @property
    def depends_on(self) -> list[str]:
        raw = self.fields.get("Depends on", "")
        return [d.strip() for d in raw.split(",") if d.strip()]

    @property
    def tags(self) -> list[str]:
        return [t.strip() for t in self.fields.get("Tags", "").split(",") if t.strip()]


@dataclass
class ModuleSpan:
    name: str
    line_idx: int  # 0-based heading index
    end_idx: int = 0  # 0-based exclusive (next module heading or EOF)
    story_id: Optional[str] = None  # value of the "User Story ID:" line, None when absent or invalid
    story_line_idx: Optional[int] = None  # 0-based index of that line


@dataclass
class Doc:
    lines: list[str]
    cases: list[Case]
    modules: list[ModuleSpan]
    findings: list[Finding]
    newline: str = "\n"

    def by_id(self) -> dict[str, Case]:
        return {c.id: c for c in self.cases if c.id}

    def case_text(self, case: Case) -> list[str]:
        return self.lines[case.start:case.end]


def parse_test_cases(text: str) -> Doc:
    newline = detect_newline(text)
    lines = text.splitlines()
    findings: list[Finding] = []
    cases: list[Case] = []
    modules: list[ModuleSpan] = []
    cur_mod: Optional[str] = None
    cur_span: Optional[ModuleSpan] = None
    cur_case: Optional[Case] = None
    cur_sec: Optional[Section] = None
    in_fence = False

    def close_case(at: int) -> None:
        nonlocal cur_case, cur_sec
        if cur_case is not None:
            end = at
            while end > cur_case.start + 1 and not lines[end - 1].strip():
                end -= 1
            cur_case.end = end
            _analyse_case(cur_case, findings)
        cur_case, cur_sec = None, None

    for i, raw in enumerate(lines):
        s = raw.rstrip()
        if FENCE_RE.match(s):
            in_fence = not in_fence
            if cur_sec is not None:
                cur_sec.lines.append((i + 1, s))
            continue
        h = None if in_fence else _HEADING_RE.match(s)
        if h:
            level, title = len(h.group(1)), h.group(2)
            if level == 1:
                close_case(i)
                if modules:
                    modules[-1].end_idx = i
                cur_span = ModuleSpan(title, i)
                modules.append(cur_span)
                cur_mod = title
            elif level == 2:
                close_case(i)
                m = _CASE_HEAD_RE.match(title)
                cid, ctitle = (m.group("id"), m.group("title").strip()) if m else (None, title)
                cur_case = Case(cid, ctitle, cur_mod, i + 1, i,
                                story_id=cur_span.story_id if cur_span else None)
                cases.append(cur_case)
            elif level == 3:
                if cur_case is None:
                    findings.append(Finding("STRAY_CONTENT", "error",
                                            f"Section heading '{title}' is outside any test case", i + 1))
                    continue
                if title not in SECTION_NAMES:
                    findings.append(Finding("UNKNOWN_SECTION", "error",
                                            f"Unknown section '{title}'; allowed: {', '.join(SECTION_NAMES)}",
                                            i + 1, cur_case.id))
                    cur_sec = Section(title, i + 1)  # swallow its lines without adding to the case
                    continue
                if title in cur_case.sections:
                    findings.append(Finding("DUPLICATE_SECTION", "error",
                                            f"Section '{title}' appears twice", i + 1, cur_case.id))
                cur_sec = Section(title, i + 1)
                cur_case.sections[title] = cur_sec
                cur_case.section_order.append(title)
            else:
                findings.append(Finding("UNKNOWN_HEADING", "error",
                                        f"Heading level {level} is not part of the contract: '{title}'",
                                        i + 1, cur_case.id if cur_case else None))
            continue
        if not s.strip():
            continue
        # non-blank content line
        sm = _STORY_FIELD_RE.match(s)
        if sm and cur_sec is None:
            if cur_case is None and cur_span is not None:
                _read_story_id(cur_span, sm.group(1).strip(), i, findings)
            elif cur_case is None:
                findings.append(Finding("STORY_ID_PLACEMENT", "error",
                                        f"'{STORY_FIELD}:' must come directly under a '# Module' heading", i + 1))
            else:
                findings.append(Finding("STORY_ID_PLACEMENT", "error",
                                        f"'{STORY_FIELD}:' belongs directly under the module heading, "
                                        "not inside a test case", i + 1, cur_case.id))
            continue
        if cur_case is None:
            where = "before the first heading" if not modules else f"under module '{cur_mod}' before a test case"
            findings.append(Finding("STRAY_CONTENT", "error", f"Text {where} is not part of the contract", i + 1))
        elif cur_sec is None:
            fm = _FIELD_RE.match(s)
            if fm:
                key = fm.group(1)
                if key in cur_case.fields:
                    findings.append(Finding("DUPLICATE_FIELD", "error", f"'{key}' appears twice", i + 1, cur_case.id))
                cur_case.fields[key] = fm.group(2).strip()
                cur_case.field_lines[key] = i + 1
            else:
                findings.append(Finding("UNKNOWN_FIELD", "error",
                                        "Only 'Priority:', 'Tags:' and 'Depends on:' may appear before the first section",
                                        i + 1, cur_case.id))
        else:
            cur_sec.lines.append((i + 1, s))
    close_case(len(lines))
    if modules:
        modules[-1].end_idx = len(lines)
    return Doc(lines, cases, modules, findings, newline)


def _read_story_id(span: ModuleSpan, value: str, idx: int, findings: list[Finding]) -> None:
    """Record a module's ``User Story ID:`` line; a bad value is reported, never guessed at."""
    line = idx + 1
    if span.story_line_idx is not None:
        findings.append(Finding("DUPLICATE_FIELD", "error",
                                f"'{STORY_FIELD}:' appears twice under module '{span.name}'", line))
        return
    span.story_line_idx = idx
    if not value:
        findings.append(Finding("STORY_ID_EMPTY", "error",
                                f"'{STORY_FIELD}:' is present but empty (omit it instead)", line))
    elif re.search(r"[,;\s]", value):
        findings.append(Finding("STORY_ID_MULTIPLE", "error",
                                f"'{STORY_FIELD}:' takes exactly one story ID. For several stories, repeat the "
                                f"'# {span.name}' heading once per story", line))
    elif not STORY_ID_RE.match(value):
        findings.append(Finding("STORY_ID_FORMAT", "error",
                                f"'{value[:40]}' is not a valid story ID (expected something like US-001)", line))
    else:
        span.story_id = value


def _analyse_case(case: Case, findings: list[Finding]) -> None:
    cid = case.id

    def add(code: str, sev: str, msg: str, line: Optional[int]) -> None:
        findings.append(Finding(code, sev, msg, line, cid))

    sec = case.sections.get("Preconditions")
    if sec:
        for ln, t in sec.lines:
            m = _BULLET_RE.match(t.strip())
            if m:
                case.preconditions.append(m.group(1).strip())
            else:
                add("BULLET_FORMAT", "error", "Preconditions must be '- ' bullets", ln)

    sec = case.sections.get("Test Data")
    if sec:
        for ln, t in sec.lines:
            m = _BULLET_RE.match(t.strip())
            d = _DATA_RE.match(m.group(1).strip()) if m else None
            if not d or not d.group(2).strip():
                add("DATA_FORMAT", "error", "Test Data lines must be '- name: value'", ln)
                continue
            name = d.group(1)
            if name in case.data:
                add("DUPLICATE_DATA", "error", f"Test Data variable '{name}' is declared twice", ln)
            case.data[name] = DataItem(name, d.group(2).strip(), ln)

    sec = case.sections.get("Steps")
    if sec:
        for ln, t in sec.lines:
            m = _STEP_RE.match(t.strip()) if not t.startswith((" ", "\t")) else None
            if m:
                body = m.group(2).strip()
                parts = _EXPECTED_SPLIT_RE.split(body, maxsplit=1)
                step = Step(int(m.group(1)), parts[0].strip(), ln, parts[1].strip() if len(parts) > 1 else None)
                case.steps.append(step)
            elif t.startswith((" ", "\t")) and case.steps:
                case.steps[-1].text += " " + t.strip()  # wrapped continuation
            else:
                add("STEP_FORMAT", "error", "Steps must be numbered lines ('1. Do something')", ln)

    sec = case.sections.get("Expected Results")
    if sec:
        for ln, t in sec.lines:
            m = _BULLET_RE.match(t.strip())
            if m:
                case.expected.append((ln, m.group(1).strip()))
            else:
                add("BULLET_FORMAT", "error", "Expected Results must be '- ' bullets", ln)


# --------------------------------------------------------------------------- test-case validation

def case_signature(case: Case) -> str:
    parts = [normalize_title(p) for p in case.preconditions]
    parts += sorted(f"{d.name}={d.raw}" for d in case.data.values())
    parts += [normalize_title(s.text) + "->" + normalize_title(s.expected or "") for s in case.steps]
    parts += [normalize_title(t) for _, t in case.expected]
    return sha256_text("\n".join(parts))


def validate_doc(doc: Doc, existing: Optional[Doc] = None, external_ids: Optional[set[str]] = None,
                 require_story_id: bool = False, story_id: Optional[str] = None,
                 foreign_ids: Optional[dict[str, str]] = None) -> list[Finding]:
    """Structural and mechanical-quality checks (rule list in rules/test-case-format.md).

    ``existing`` is a parsed copy of cases already saved: its IDs are valid dependency
    targets, and its titles/scenarios are checked for duplicates. ``User Story ID:`` is
    optional so files written before the field existed stay valid; ``require_story_id``
    (used for newly generated drafts) makes a module without a valid one an error.

    Per-story files: ``story_id`` asserts that the file holds only that story's cases (and implies
    ``require_story_id``). ``foreign_ids`` maps test IDs that belong to *other* stories' files to
    that story: reusing one is a ``DUPLICATE_ID``, and depending on one is ``DEPENDENCY_CROSS_FILE``,
    because every file must be usable on its own.
    """
    out: list[Finding] = list(doc.findings)
    foreign_ids = foreign_ids or {}
    if story_id:
        require_story_id = True
        for m in doc.modules:
            if m.story_id and m.story_id != story_id:
                out.append(Finding("FILE_STORY_MISMATCH", "error",
                                   f"Module '{m.name}' is for story {m.story_id}, but this file holds only {story_id}",
                                   m.story_line_idx + 1 if m.story_line_idx is not None else m.line_idx + 1))
    if require_story_id:
        for m in doc.modules:
            # a present-but-bad line already produced its own STORY_ID_* finding
            if m.story_line_idx is None:
                out.append(Finding("STORY_ID_MISSING", "error",
                                   f"Module '{m.name}' has no '{STORY_FIELD}:' line directly under its heading",
                                   m.line_idx + 1))
        for c in doc.cases:
            if c.module is None:
                out.append(Finding("STORY_ID_MISSING", "error",
                                   "Test case is outside any '# Module' section, so it has no User Story ID",
                                   c.line, c.id))
    existing_ids = {c.id for c in existing.cases if c.id} if existing else set()
    known_ids = {c.id for c in doc.cases if c.id} | existing_ids | (external_ids or set())

    if not doc.cases:
        out.append(Finding("NO_CASES", "error", "The file contains no test cases ('## ID: Title' headings)"))

    seen_ids: dict[str, int] = {}
    seen_sig: dict[str, str] = {}
    seen_title: dict[tuple, str] = {}
    if existing:
        for c in existing.cases:
            seen_sig.setdefault(case_signature(c), c.id or c.title)
            seen_title.setdefault((c.module or "", normalize_title(c.title)), c.id or c.title)

    for c in doc.cases:
        cid = c.id

        def add(code: str, sev: str, msg: str, line: Optional[int] = None, _cid=cid) -> None:
            out.append(Finding(code, sev, msg, line if line is not None else c.line, _cid))

        # 1 title + unique stable id
        if not c.title:
            add("TITLE_MISSING", "error", "The test case has no title")
        if not cid:
            add("ID_MISSING", "error",
                "No ID. Generate one with scripts/generate-stable-id.py and write it as '## ID: Title'")
        else:
            if cid.upper().startswith("AUTO-") and not AUTO_ID_RE.match(cid):
                add("ID_FORMAT", "error", "AUTO IDs must look like AUTO-0a1b2c3d (8 lowercase hex digits)")
            if cid in seen_ids:
                add("DUPLICATE_ID", "error", f"ID {cid} is already used on line {seen_ids[cid]}")
            seen_ids.setdefault(cid, c.line)
            if cid in existing_ids:
                add("DUPLICATE_ID", "error", f"ID {cid} already exists in the saved test cases")
            if cid in foreign_ids:
                add("DUPLICATE_ID", "error",
                    f"ID {cid} is already used by a test case of story {foreign_ids[cid]}; IDs are unique across all files")

        # structure
        if "Steps" not in c.sections:
            add("STEPS_MISSING", "error", "Missing '### Steps' section")
        elif not c.steps:
            add("STEPS_EMPTY", "error", "'### Steps' has no numbered steps", c.sections["Steps"].line)
        order = [n for n in SECTION_NAMES if n in c.section_order]
        if order != [n for n in c.section_order if n in SECTION_NAMES]:
            add("SECTION_ORDER", "warning",
                "Sections should appear in the order Preconditions, Test Data, Steps, Expected Results")
        if "Priority" in c.fields and c.fields["Priority"].lower() not in KNOWN_PRIORITIES:
            add("PRIORITY_VALUE", "warning", "Priority is normally one of Critical, High, Medium, Low",
                c.field_lines.get("Priority"))
        for key in ("Priority", "Tags", "Depends on"):
            if key in c.fields and not c.fields[key]:
                add("FIELD_EMPTY", "error", f"'{key}:' is present but empty (omit optional fields instead)",
                    c.field_lines.get(key))

        nums = [s.num for s in c.steps]
        if nums and nums != list(range(1, len(nums) + 1)):
            add("STEP_NUMBERING", "warning", "Step numbers are not 1..n in order (auto-fixable)",
                c.sections["Steps"].line)

        # 2/7 expected results
        inline = [s for s in c.steps if s.expected]
        if not c.expected and not inline:
            add("EXPECTED_MISSING", "error", "No expected result: add '### Expected Results' bullets or an inline '-> Expected:'")
        if "Expected Results" in c.sections and not c.expected:
            add("EXPECTED_EMPTY", "error", "'### Expected Results' has no bullets", c.sections["Expected Results"].line)
        for ln, text in c.expected + [(s.line, s.expected) for s in inline]:
            if _WEAK_WHOLE_RE.match(text.strip()):
                add("EXPECTED_WEAK", "error", "Expected result is not assertable (e.g. 'works'); state what is observable", ln)
            elif _VAGUE_RE.search(text) and '"' not in text and "'" not in text:
                add("EXPECTED_VAGUE", "warning", "Expected result uses vague wording; state the observable outcome", ln)

        final = {normalize_title(t) for _, t in c.expected}
        for s in inline:
            if normalize_title(s.expected) in final:
                add("EXPECTED_DUPLICATED", "warning",
                    "An inline '-> Expected:' repeats an Expected Results bullet; keep it in one place", s.line)

        # placeholders and implementation detail
        texts = [(c.line, c.title)] + [(s.line, s.text) for s in c.steps] + c.expected + \
                [(ln, t) for ln, t in [(s.line, s.expected) for s in inline] if t] + \
                [(0, p) for p in c.preconditions]
        for ln, t in texts:
            if _PLACEHOLDER_RE.search(t):
                add("PLACEHOLDER_TEXT", "error", "Placeholder text (TBD/TODO/<...>) is not allowed", ln or c.line)
                break
        for s in c.steps:
            if any(p.search(s.text) or (s.expected and p.search(s.expected)) for p in _IMPL_PATTERNS):
                add("IMPLEMENTATION_DETAIL", "error",
                    "Step contains a selector or automation code; describe the user action instead", s.line)

        # 3 variables
        used: set[str] = set()
        for s in c.steps:
            used |= set(_VAR_RE.findall(s.text)) | set(_VAR_RE.findall(s.expected or ""))
        for _, t in c.expected:
            used |= set(_VAR_RE.findall(t))
        for name in sorted(used - set(c.data)):
            add("VARIABLE_UNDECLARED", "error", f"{{{name}}} is used but not declared under '### Test Data'")
        for name in sorted(set(c.data) - used):
            add("VARIABLE_UNUSED", "warning", f"Test Data '{name}' is declared but never used", c.data[name].line)

        # 4 env and secrets (never echo values)
        for d in c.data.values():
            if d.kind == "env" and not ENV_NAME_RE.match(d.value):
                add("ENV_REF_INVALID", "error",
                    f"'{d.name}': env: must be followed by an UPPER_SNAKE_CASE variable name, never a value", d.line)
            elif d.kind == "plain" and is_secret_name(d.name):
                add("SECRET_PLAIN_VALUE", "error",
                    f"'{d.name}' looks like a credential: use env:VARIABLE_NAME (or literal: for a deliberately fake value)",
                    d.line)
            elif d.kind == "plain" and contains_secret(d.value):
                add("SECRET_DETECTED", "error", f"'{d.name}' holds what looks like a secret or token", d.line)
        body = "\n".join(doc.lines[c.start:c.end])
        if contains_secret(body):
            add("SECRET_DETECTED", "error", "The test case text contains what looks like a secret or token")

        # 5 dependencies
        for dep in c.depends_on:
            if not CASE_ID_RE.match(dep):
                add("DEPENDENCY_FORMAT", "error", f"'{dep}' is not a valid test ID", c.field_lines.get("Depends on"))
            elif dep == cid:
                add("DEPENDENCY_SELF", "error", "A test case cannot depend on itself", c.field_lines.get("Depends on"))
            elif dep in foreign_ids and dep not in known_ids:
                add("DEPENDENCY_CROSS_FILE", "error",
                    f"Dependency {dep} belongs to story {foreign_ids[dep]}'s file. Each file must be usable on its own: "
                    "put the setup in Preconditions or in this story's own cases", c.field_lines.get("Depends on"))
            elif dep not in known_ids:
                add("DEPENDENCY_UNKNOWN", "error", f"Dependency {dep} does not exist", c.field_lines.get("Depends on"))

        # 9 duplicates
        sig = case_signature(c)
        if c.steps and sig in seen_sig and seen_sig[sig] != cid:
            add("DUPLICATE_SCENARIO", "error", f"Same preconditions, data, steps and results as {seen_sig[sig]}")
        else:
            seen_sig.setdefault(sig, cid or c.title)
        tkey = (c.module or "", normalize_title(c.title))
        if tkey in seen_title and seen_title[tkey] != cid:
            add("DUPLICATE_TITLE", "warning", f"Same title as {seen_title[tkey]} in this module")
        else:
            seen_title.setdefault(tkey, cid or c.title)

    # dependency cycles over this file plus existing cases
    graph: dict[str, list[str]] = {}
    for src in ([existing] if existing else []) + [doc]:
        for c in src.cases:
            if c.id:
                graph[c.id] = [d for d in c.depends_on if CASE_ID_RE.match(d)]
    cycle = find_cycle(graph)
    if cycle:
        out.append(Finding("DEPENDENCY_CYCLE", "error", "Circular dependency: " + " -> ".join(cycle), None, cycle[0]))
    return out


def find_cycle(graph: dict[str, list[str]]) -> Optional[list[str]]:
    WHITE, GREY, BLACK = 0, 1, 2
    color = {n: WHITE for n in graph}
    for root in graph:
        if color[root] != WHITE:
            continue
        stack = [(root, iter(graph[root]))]
        path = [root]
        color[root] = GREY
        while stack:
            node, it = stack[-1]
            nxt = next(it, None)
            if nxt is None:
                color[node] = BLACK
                stack.pop()
                path.pop()
                continue
            if nxt not in graph:
                continue
            if color[nxt] == GREY:
                return path[path.index(nxt):] + [nxt]
            if color[nxt] == WHITE:
                color[nxt] = GREY
                stack.append((nxt, iter(graph[nxt])))
                path.append(nxt)
    return None


def validation_report(doc: Doc, findings: list[Finding], label: str = "") -> dict:
    per_case = []
    for c in doc.cases:
        errs = sum(1 for f in findings if f.severity == "error" and f.case_id == c.id and c.id)
        # findings with no id (ID_MISSING) are matched by line
        errs += sum(1 for f in findings if f.severity == "error" and not c.id and f.line and c.line <= f.line <= c.end)
        warns = sum(1 for f in findings if f.severity == "warning" and f.case_id == c.id and c.id)
        per_case.append({"id": c.id, "title": c.title, "module": c.module, "storyId": c.story_id, "line": c.line,
                         "errors": errs, "warnings": warns, "valid": errs == 0})
    n_err = sum(1 for f in findings if f.severity == "error")
    n_warn = sum(1 for f in findings if f.severity == "warning")
    return {"file": label, "ok": n_err == 0,
            "summary": {"cases": len(doc.cases), "errors": n_err, "warnings": n_warn},
            "cases": per_case, "findings": [f.as_dict() for f in findings]}


def fix_safe(text: str) -> tuple[str, list[str]]:
    """Deterministic formatting fixes that never change meaning."""
    nl = detect_newline(text)
    fixes: list[str] = []
    lines = [l.rstrip() for l in text.splitlines()]
    if [l.rstrip() for l in text.splitlines()] != text.splitlines():
        fixes.append("trimmed trailing whitespace")
    out: list[str] = []
    in_steps = False
    in_fence = False
    counter = 0
    renumbered = False
    for raw in lines:
        s = raw
        if FENCE_RE.match(s):
            in_fence = not in_fence
        if not in_fence:
            h = _HEADING_RE.match(s)
            if h:
                in_steps = h.group(2) == "Steps" and len(h.group(1)) == 3
                counter = 0
            elif in_steps:
                m = _STEP_RE.match(s)
                if m:
                    counter += 1
                    body = _EXPECTED_SPLIT_RE.sub(" -> Expected: ", m.group(2))
                    if int(m.group(1)) != counter:
                        renumbered = True
                    if body != m.group(2):
                        fixes.append("normalised '-> Expected:' spacing")
                    s = f"{counter}. {body}"
            if re.match(r"^\*[ \t]+", s):
                s = "- " + s[1:].lstrip()
                fixes.append("converted '*' bullets to '-'")
            fm = _FIELD_RE.match(s)
            if fm and fm.group(1) in ("Tags", "Depends on") and fm.group(2).strip():
                items = ", ".join(p.strip() for p in fm.group(2).split(",") if p.strip())
                if items != fm.group(2).strip():
                    fixes.append(f"normalised '{fm.group(1)}' spacing")
                s = f"{fm.group(1)}: {items}"
        out.append(s)
    if renumbered:
        fixes.append("renumbered steps 1..n")
    # one blank line before headings, never two blanks in a row
    final: list[str] = []
    for s in out:
        blank = not s.strip()
        if blank and final and not final[-1].strip():
            continue
        if _HEADING_RE.match(s) and not FENCE_RE.match(s) and final and final[-1].strip():
            final.append("")
            fixes.append("added blank line before heading")
        final.append(s)
    while final and not final[-1].strip():
        final.pop()
    new = nl.join(final) + nl if final else ""
    if new != text and not fixes:
        fixes.append("normalised line endings / final newline")
    return new, sorted(set(fixes))


# --------------------------------------------------------------------------- per-story files

def testcase_filename(story_id: str) -> str:
    """``US-001`` -> ``US-001-testcase.md``. Refuses anything that is not a safe file-name stem."""
    if not STORY_ID_RE.match(story_id or "") or ".." in story_id:
        raise SafeOpError("BAD_STORY_ID", f"Story ID '{story_id}' cannot be used as a test-case file name "
                          "(letters, digits, '.', '_' and '-' only).", EXIT_USAGE)
    return story_id + TESTCASE_SUFFIX


def testcase_rel_path(story_id: str) -> str:
    """Project-root-relative path of a story's test-case file."""
    return f"{OUTPUT_DIRNAME}/{TESTCASE_DIRNAME}/{testcase_filename(story_id)}"


def story_id_from_filename(name: str) -> Optional[str]:
    """``US-001-testcase.md`` -> ``US-001``; None for any other name (including the legacy file)."""
    if not name.endswith(TESTCASE_SUFFIX):
        return None
    stem = name[:-len(TESTCASE_SUFFIX)]
    return stem if STORY_ID_RE.match(stem) and ".." not in stem else None


def foreign_case_ids(trace: Optional[dict], story_id: str) -> dict[str, str]:
    """Test IDs that traceability.json maps to stories other than ``story_id`` (id -> that story).

    This is the cheap index used to keep IDs unique across files without opening any other file.
    """
    out: dict[str, str] = {}
    cases = trace.get("cases", {}) if isinstance(trace, dict) and isinstance(trace.get("cases"), dict) else {}
    for cid, meta in cases.items():
        sids = meta.get("storyIds", []) if isinstance(meta, dict) else []
        if sids and story_id not in sids:
            out[cid] = sids[0]
    return out


# --------------------------------------------------------------------------- merge helpers

def case_block(doc: Doc, case: Case) -> list[str]:
    return doc.lines[case.start:case.end]


def module_header(name: str, story_id: Optional[str]) -> list[str]:
    """Module heading, with its ``User Story ID:`` line directly below when there is one."""
    return [f"# {name}"] + ([f"{STORY_FIELD}: {story_id}"] if story_id else [])


def merge_cases_text(target_text: str, source: Doc) -> tuple[str, dict]:
    """Insert the source cases into the target text without touching existing bytes.

    A module section is identified by its name *and* its ``User Story ID`` (a file may hold
    several sections with the same name, one per story). New cases go at the end of the section
    with the same name and story ID (``# General`` when the source case has no module). When no
    such section exists, a new one is appended at the end of the file, so a legacy section
    without a story ID is never silently attributed to a story.
    """
    target = parse_test_cases(target_text) if target_text.strip() else Doc([], [], [], [], "\n")
    nl = target.newline if target_text.strip() else source.newline
    lines = list(target.lines)
    inserts: dict[int, list[list[str]]] = {}
    new_modules: dict[tuple[str, Optional[str]], list[list[str]]] = {}
    placed = {"general": [], "newModules": [], "perModule": {}, "perStory": {}}

    for c in source.cases:
        mod = c.module or "General"
        key = (mod, c.story_id)
        if c.module is None:
            placed["general"].append(c.id)
        block = case_block(source, c)
        spans = [m for m in target.modules if (m.name, m.story_id) == key]
        if spans:
            span = spans[-1]
            ends = [t.end for t in target.cases if span.line_idx < t.start < span.end_idx]
            at = max(ends) if ends else max(span.line_idx, span.story_line_idx or 0) + 1
            inserts.setdefault(at, []).append(block)
        else:
            if key not in new_modules:
                placed["newModules"].append(mod)
            new_modules.setdefault(key, []).append(block)
        placed["perModule"].setdefault(mod, []).append(c.id)
        if c.story_id:
            placed["perStory"].setdefault(c.story_id, []).append(c.id)

    out = list(lines)
    for at in sorted(inserts, reverse=True):
        chunk: list[str] = []
        for block in inserts[at]:
            chunk += [""] + block
        out[at:at] = chunk
    for (mod, sid), blocks in new_modules.items():
        while out and not out[-1].strip():
            out.pop()
        out += ([""] if out else []) + module_header(mod, sid)
        for block in blocks:
            out += [""] + block
    while out and not out[-1].strip():
        out.pop()
    while out and not out[0].strip():  # an empty target would otherwise start with a blank line
        out.pop(0)
    return nl.join(out) + nl, placed


def remove_case_text(text: str, case_id: str) -> str:
    doc = parse_test_cases(text)
    c = doc.by_id().get(case_id)
    if not c:
        return text
    lines = doc.lines[:c.start] + doc.lines[c.end:]
    return doc.newline.join(lines) + doc.newline


# --------------------------------------------------------------------------- confined atomic writer

class SafeOpError(Exception):
    def __init__(self, code: str, message: str, exit_code: int):
        super().__init__(message)
        self.code, self.exit_code = code, exit_code


def output_dir(root: Path) -> Path:
    return Path(root).resolve() / OUTPUT_DIRNAME


def confine(root: Path, target: Path) -> Path:
    """Resolve ``target`` and require it to sit inside ``<root>/test-design/``."""
    out = output_dir(root)
    t = Path(target)
    t = (t if t.is_absolute() else Path(root) / t).resolve()
    try:
        t.relative_to(out)
    except ValueError:
        raise SafeOpError("OUTSIDE_OUTPUT_DIR",
                          f"Refusing to write outside {out}. Generated artefacts and source stories are never modified.",
                          EXIT_CONFINED)
    return t


def check_dir_access(path: Path, probe: bool) -> dict:
    p = Path(path)
    probe_dir = p
    while not probe_dir.exists() and probe_dir != probe_dir.parent:
        probe_dir = probe_dir.parent
    res = {"path": str(p), "exists": p.exists(), "probeDir": str(probe_dir),
           "readable": os.access(probe_dir, os.R_OK), "writable": os.access(probe_dir, os.W_OK)}
    if probe and res["writable"]:
        try:
            fd, tmp = tempfile.mkstemp(dir=probe_dir, prefix=".td-access-")
            os.close(fd)
            os.remove(tmp)
        except OSError as e:
            res["writable"] = False
            res["probeError"] = type(e).__name__
    return res


def safe_write(root: Path, target: Path, data: bytes, *, expect_sha: Optional[str] = None,
               allow_overwrite: bool = False, backup: bool = True) -> dict:
    """Temp write -> optional backup -> atomic replace -> read-back hash check."""
    t = confine(root, target)
    if contains_secret(data.decode("utf-8", "ignore")):
        raise SafeOpError("SECRET_DETECTED",
                          "The content looks like it contains a secret or token; use env: references. Nothing was written.",
                          EXIT_FINDINGS)
    backup_path = None
    if t.exists():
        if not t.is_file():
            raise SafeOpError("NOT_A_FILE", f"{t} is not a file", EXIT_IO)
        current = sha256_file(t)
        if expect_sha is not None:
            if current != expect_sha:
                raise SafeOpError("CONFLICT",
                                  f"{t.name} changed since it was last read (expected {expect_sha[:12]}, found {current[:12]}). "
                                  "Re-read it and ask the user how to reconcile.", EXIT_CONFLICT)
        elif not allow_overwrite:
            raise SafeOpError("EXISTS", f"{t.name} already exists; pass the expected hash or explicit overwrite permission",
                              EXIT_CONFLICT)
        if backup:
            stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            bdir = output_dir(root) / "state" / "backups"
            bdir.mkdir(parents=True, exist_ok=True)
            backup_path = bdir / f"{t.name}.{stamp}.bak"
            shutil.copy2(t, backup_path)
    elif expect_sha is not None:
        raise SafeOpError("MISSING", f"{t.name} is missing although a previous hash was expected; "
                          "the output may have been deleted. Ask the user how to proceed.", EXIT_MISSING)
    t.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=t.parent, prefix=".tmp-", suffix=".part")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, t)
    except OSError as e:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise SafeOpError("IO_ERROR", f"Could not write {t.name}: {type(e).__name__} ({e.strerror}). "
                          "Is the file open in another program?", EXIT_IO)
    if sha256_file(t) != sha256_bytes(data):
        if backup_path:
            shutil.copy2(backup_path, t)
        raise SafeOpError("READBACK_FAILED", f"Read-back check failed for {t.name}; the previous version was restored.", EXIT_IO)
    return {"path": str(t), "sha256": sha256_bytes(data), "bytes": len(data),
            "backup": str(backup_path) if backup_path else None}


def merge_patch(target: Any, patch: Any) -> Any:
    """RFC 7386 JSON merge patch (null deletes a key, arrays replace)."""
    if not isinstance(patch, dict):
        return patch
    if not isinstance(target, dict):
        target = {}
    result = dict(target)
    for k, v in patch.items():
        if v is None:
            result.pop(k, None)
        else:
            result[k] = merge_patch(result.get(k), v)
    return result
