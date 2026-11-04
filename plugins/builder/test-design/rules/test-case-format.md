# Test-case format (canonical contract)

This is the interface to the Builder. Do not replace it, add fields, or rename headings.

## One file per user story

Test cases are stored directly under `test-design/test-cases/`, one file per story, named `<USER_STORY_ID>-testcase.md` (for example `US-001-testcase.md`). The file format below is unchanged; the layout rules are:

- A file holds **only** its own story's cases: every `# Module` heading in it carries `User Story ID: <that story>`, and the file name matches. No sub-folders, no consolidated file.
- A file is **self-contained**, so the Builder can be given any one file. `Depends on:` may name only cases in the same file, and every `{variable}` is declared in the case that uses it. Setup that another story provides is a `Preconditions` bullet.
- Test IDs are unique across all files (the Builder keys tests by ID). The mapping to criteria stays in `state/traceability.json`, never in the file.
- A file written by an older version as `test-cases.md` (all stories together) stays readable; `validate` flags it and `split-legacy` migrates it.

```markdown
# Module                                  <- optional grouping; may repeat in one file
User Story ID: US-001                     <- the story every case in this section belongs to

## TC-001: Valid user can sign in         <- ID: Title
Priority: High                            <- optional
Tags: smoke, auth                         <- optional, comma-separated
Depends on: TC-000                        <- optional, only if it must run first

### Preconditions                         <- only conditions required before execution
- An active test account exists

### Test Data                             <- every {variable} used in Steps
- email: env:TEST_USER_EMAIL
- plan: Premium
- wrong_password: literal:wrong-pass-1

### Steps                                 <- numbered; optional inline "-> Expected:"
1. Open the login page
2. Enter {email} in the Email field
3. Click the "Sign in" button -> Expected: The dashboard is displayed

### Expected Results                      <- final observable outcomes
- The heading "Dashboard" is visible
```

The `<-` notes are explanations for you; never write them into a test-case file.

## Rules

- Headings: `#` module, `##` case, `###` only `Preconditions`, `Test Data`, `Steps`, `Expected Results`, in that order. No other headings, no prose between them, no front matter.
- **`User Story ID:`** goes on the line directly below the `#` module heading (a blank line between is tolerated) and applies to every case until the next `#` heading. One ID per heading: `US-001`, `PROJ-123` (letters, digits, `.`, `_`, `-`). Never repeat it inside a test case; a case does not carry its own story ID.
- **Several stories in one module:** repeat the module heading once per story, each with its own `User Story ID:`; put each case under the heading of its story. Do not list several IDs on one line.
- **Optional for old files.** A file (or a module) without the line stays valid and is read as before. The plugin always writes it for new cases (`--story-id` on the validator and `merge-cases`). `merge-cases` appends to the section with the same module name *and* story ID, and starts a new section otherwise; a legacy section without the line is never relabelled.
- Fields directly under the `##` line, in any order, only `Priority:`, `Tags:`, `Depends on:`. Omit a field instead of leaving it empty. Priority is one of Critical, High, Medium, Low.
- **This plugin always writes the ID**: `## <ID>: <Title>`. A supplied ID is used verbatim. Otherwise derive `AUTO-xxxxxxxx` with `test-design/scripts/generate-stable-id.py` (never invent or hand-type one). An existing ID is never changed on regeneration or edit.
- Steps: one action each, numbered 1..n, imperative, in domain language. Inline `-> Expected:` only for an immediate assertion; do not repeat it under Expected Results.
- Expected results: specific, observable, assertable ("The message "Invalid email or password" is displayed", not "login fails properly"). At least one per case, inline or in the section.
- `Depends on:` lists IDs that exist, never itself, never forming a cycle. Use it only when the case genuinely cannot run without the other having run first.
- Test Data: plain literal for ordinary values; `env:NAME` for secrets and environment-specific values; `literal:value` for a deliberately fake or explicitly fixed value. Details in `test-data-and-secrets.md`.
- The module-level `User Story ID:` is the only story reference in this file. Criterion labels (`AC-1`), covers and technique metadata are **not** part of it; the full mapping lives in `state/traceability.json`.

`test-design/scripts/validate-test-cases.py` enforces this. Findings and what they mean: `skills/test-case-validation/SKILL.md`.
