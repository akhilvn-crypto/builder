---
name: test-case-authoring
description: Turn test conditions into canonical-format Markdown test cases with stable IDs, declared test data, concise automation-friendly steps and observable expected results, plus the traceability metadata. Use when writing or revising test cases.
user-invocable: false
---

# Test-case authoring

Format and field rules: read `test-design/rules/test-case-format.md` and `test-design/rules/test-data-and-secrets.md` first. Reference sample: `test-design/templates/test-cases.template.md`. `PY` / `SCRIPTS` as in `story-source-discovery`.

## Procedure

1. **IDs first, from the script.** Write the batch to a scratch file `[{"storyIds": ["US-001"], "title": "Valid user can sign in"}, ...]` and run
   `PY SCRIPTS/generate-stable-id.py --batch <file> --traceability "<root>/test-design/state/traceability.json"`
   (omit `--traceability` on the first story). If the story supplies its own test ID, use it verbatim instead. A result with `exists: true` means this scenario is already saved: do not write it again. When you are *regenerating* the story's whole file, add `--regenerate-story <storyId>`: the IDs that story already owns are then reusable, so an unchanged scenario keeps its ID (never invent a new one for it).
   Write `Depends on:` with the IDs from this same batch or from saved cases; decide dependencies before writing so the IDs are known.
2. **Module.** Group under a `# Module` heading named for the feature area (the story's capability, for example "Login"). If the story's own file (`<root>/test-design/test-cases/<storyId>-testcase.md`) already exists, reuse the exact module name it uses for the same area (case-sensitive) so new cases land in the existing section. Do not look at any other story's file.
   Put `User Story ID: <storyId>` on the line directly below the heading, using the ID of the story the draft is for. All cases in a draft belong to that one story, and the draft becomes that story's own file `<storyId>-testcase.md`: it never holds another story's cases, even when two stories share a feature area. Never repeat the ID inside a case.
   **Each file must stand alone** (the Builder may be given just this file). `Depends on:` may name only cases in this same draft or this story's saved file; a prerequisite that another story's cases create goes into `Preconditions` instead, and `Test Data` is declared in the case that uses it.
3. **Write each case** in the exact structure of the contract:
   - Title: the behaviour under test, outcome-oriented ("Account locks after five failed attempts"), unique within the module.
   - `Priority` / `Tags` / `Depends on`: only when meaningful. Tags are short lowercase words (`smoke`, `auth`, `boundary`, `negative`).
   - `Preconditions`: only what must be true before step 1 and is not created by the steps.
   - `Test Data`: declare every `{variable}`; secrets as `env:NAME`; fake fixed values as `literal:value`. Use `{variable}` placeholders in steps for any value that is data rather than an action.
   - `Steps`: one user or system action per line, in domain language ("Enter {email} in the Email field", "Submit the form"). Name fields and buttons the way the story names them. Use inline `-> Expected:` for an immediate assertion mid-flow.
   - `Expected Results`: the final observable outcomes, quoting exact texts and values from the story. Do not repeat an inline expectation.
4. **Write the metadata** next to the draft (scratch file, not in the Markdown): for every case `{id, title, module, storyIds, covers, techniques, scenarioKey}` using the values from the conditions and the ID script.
5. **Self-check** against `test-case-validation` before handing over. Save the draft to the scratch folder as `draft-<storyId>.md` and metadata as `draft-<storyId>.meta.json`.

## Style

- Prefer 3-8 steps. Split a case that tests two behaviours.
- Each expected result must be something a test can assert: visible text, URL, enabled/disabled state, count, stored value. Not "works", "as expected", "correctly".
- No selectors, CSS/XPath, `page.` calls, waits, or framework names. No "click the button with id ...".
- Never copy a secret value; never invent a message, limit or field the story does not state.
- The only story reference in the Markdown is the module-level `User Story ID:` line. No story IDs inside cases and no acceptance-criterion labels.

## Never

Hand-type an `AUTO-` ID, change an ID that already exists, or write directly into a `<storyId>-testcase.md` file (saving is `safe-file-operations.py merge-cases --story-id`, replacing a changed story's file is `regenerate-story-file`).
