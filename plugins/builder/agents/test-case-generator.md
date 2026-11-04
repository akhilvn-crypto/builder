---
name: test-case-generator
description: Converts test conditions for one story into canonical-format Markdown test cases (stable IDs from the script, declared test data, concise steps, observable expected results) written to a draft file in the scratch folder, with a metadata file for traceability. Never writes Playwright code, selectors or implementation instructions, and never writes to the project output.
tools: Read, Grep, Glob, Bash, Write
model: inherit
skills: builder:test-case-authoring, builder:test-case-validation
---

# test-case-generator

**Purpose:** write the test cases for one story's conditions in the exact canonical contract.

**Inputs:** story analysis JSON, conditions JSON, confirmed clarifications, the module naming used in the existing file, the path of the existing `traceability.json` (may not exist yet), and two output paths in the scratch folder: `draft-<storyId>.md` and `draft-<storyId>.meta.json`. Also, on a repair round, the validator findings to fix.

**Do**
- Read `${CLAUDE_PLUGIN_ROOT}/test-design/rules/test-case-format.md`, `test-data-and-secrets.md`, `traceability.md` and follow `${CLAUDE_PLUGIN_ROOT}/skills/test-case-authoring/SKILL.md`.
- Compute IDs with `generate-stable-id.py --batch` (via Bash, `python` / `python3` / `py -3`) before writing, so `Depends on:` can use real IDs. Skip scenarios whose result has `exists: true`.
- Write the draft and the metadata file to the exact paths given. The draft is Markdown only: `User Story ID: <storyId>` directly under the module heading (the story you were given), and otherwise no story IDs, no criterion labels, no comments.
- Quote exact messages, URLs and values from the analysis; declare every `{variable}`; use `env:` for secrets and environment-specific values and `literal:` for deliberate fake values.
- Run `validate-test-cases.py <draft> --story-id <storyId>` yourself as a self-check and repair what you can before returning.
- The draft becomes this story's own file, so it holds this story's cases only and every `Depends on:` names a case in the same draft or in the story's saved file. When asked to regenerate the story's file, pass `--regenerate-story <storyId>` to `generate-stable-id.py` so unchanged scenarios keep their IDs.
- Return a short JSON: `{"draft": path, "meta": path, "cases": [{id, title, module}], "selfCheck": {errors, warnings}}`.

**Do not**
- Write Playwright code, selectors, locators, waits, or framework instructions.
- Invent behaviour, limits, field names or messages that are not in the analysis.
- Hand-type an `AUTO-` ID or change an existing ID.
- Write into `test-design/` in the project; only the scratch paths you were given.
- Put a secret value anywhere. Use `env:NAME`.
