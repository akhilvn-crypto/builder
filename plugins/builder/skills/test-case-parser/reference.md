# Test-case input reference (read on demand)

## Header aliases (matched case- and punctuation-insensitively)

- ID: `TC ID`, `Test Case No`, `Ref`
- title: `Scenario`, `Test Case Name`, `Summary`, a bare `Description`
- module: `Module`, `Feature`, `Functionality`, `Area`, `Component`
- steps: `Test Steps`, `Procedure`, `Action`
- expected: a short header starting `Expected …`
- also `Preconditions`/`Prerequisites`, `Test Data`, `Priority`, `Tags`
- depends: `Depends On`, `Dependency`/`Dependencies`, `Prerequisite Test(s)`, `Blocked By` (test IDs; several separated by comma, semicolon, "and" or new lines)

The header row is the first of the first 25 rows that has both a steps and an expected-result column, so a title block above
the table is fine. A lone ID-shaped cell (`TC-9`) in an otherwise empty row is an (incomplete) case and is flagged, not a heading.

When two headers fit one field equally well (`Steps` and `Test Steps`) and both hold data, the table is an
`ambiguous_column_mapping` and its cases wait for `input map … --column steps="Test Steps"`; a header that fits better wins
outright (`Test Case Title` over `Test Description` for the title). When no header names steps / expected / ID at all, the
columns are read by content and applied at 90% confidence or better (an `inferred_columns` warning); otherwise the table is an
error listing proposals. Columns no field claims are kept under their own name in each case's `metadata`.

## Canonical test cases (what `specs parse` writes first)

`canonical-test-cases.json` holds every case once, whatever the format: `testCaseId`, `title`, `module`, `preconditions`, `steps`
(each with optional `testData` and `expectedResult`), case-level `expectedResults` and `testData`, `priority`, `tags`, `source`
(file, sheet, first and last row or line, original ID), `metadata`, and `validation` with `status` (`valid` / `warning` /
`needs_clarification` / `invalid`) plus `blocking` and `warnings` issues. `test-specs.json` is projected from it. Fields are
described in `dependencies/docs/test-spec-schema.md`.

## Markdown

```md
# Login                           (optional; the module. Several `#` headings in one file = several modules)
## TC-001: Title                  (ID optional; without one a stable AUTO-xxxxxxxx ID is derived from path + title)
Priority: High
Tags: smoke, auth
Depends on: TC-000                 (optional; test IDs that must run first; also read from a "Depends on" column)
### Preconditions
- ...
### Test Data
- email: env:TEST_USER_EMAIL       (env var NAME; the value lives in .env)
- password: literal:wrong-pass-1   (explicitly non-secret literal)
- plan: Premium                    (plain literal)
- username: qa-admin               (credential-looking literal: `specs parse` moves it to .env as TEST_USERNAME)
### Steps
1. Enter {email} in the Email field          ({name} must be defined in Test Data)
2. Click "Sign in" -> Expected: ...          (inline step expectation; also "| Expected:")
   - Expected: ...                           (or a nested bullet)
### Expected Results
- ...
```

Label lines (`Steps:`, `Expected Result: X`) work in place of `###` headings.

## CSV / Excel sheet

```csv
Module,TC ID,Test Case,Steps,Expected Result
Login,LOG-1,Valid sign in,"1. Open the login page
2. Click ""Sign in""","The login page is shown
The dashboard is shown"
Create Project,PRJ-1,Create a project,"Click ""New project""",The project form opens
```

The `Module` column is optional (the sheet or file name is used without it). Column names are the user's own. CSV delimiters:
`,` `;` or tab; quoted multi-line cells are supported.
