# Test cases: the canonical schema and the test-spec view

Test cases come in as Markdown (`.md`), CSV (`.csv`) or Excel (`.xlsx`), in any layout, and are **normalized once** by
`node dependencies/engine/cli/pipeline.ts specs parse <runId>` into the canonical document below. Nothing downstream (exploration,
generation, review, execution) reads the original files: they read `test-specs.json`, which is a projection of the canonical
document and is accepted only while it matches it. Any other file type is rejected with the way to convert it.

```
.md / .csv / .xlsx  ->  readers (one per format)  ->  draft cases  ->  normalization  ->  canonical-test-cases.json
                                                                                              |  projectSpecs (pure)
                                                                                              v
                                                                                       test-specs.json  ->  explore / generate / review ...
```

Source: `engine/pipeline/canonical.ts` (types, validator, projection), `test-case-parser.ts` (readers + normalization),
`input-table.ts` + `column-inference.ts` (column mapping), `markdown-table.ts`, `engine/utils/xlsx.ts`, all under
`dependencies/`. Input formats are described in the plugin's `test-case-parser` skill; examples are in `dependencies/docs/examples/`.
Source paths in the documents are relative to `dependencies/`.

## Canonical test cases (`canonical-test-cases.json`, schemaVersion `1.0.0`)

```jsonc
{
  "schemaVersion": "1.0.0",
  "generatedAt": "2026-10-21T04:00:00.000Z",
  "sources": [{ "path": "input/test-cases/cases.xlsx", "sha256": "…", "format": "xlsx" }],
  "validation": {                         // the whole input
    "status": "warning",                  // valid | warning | needs_clarification | invalid  (the worst of the cases and findings)
    "counts": { "valid": 5, "warning": 1, "needs_clarification": 1, "invalid": 0 },
    "errors": [],                         // unreadable / unsupported files: { path, message }
    "findings": []                        // tables that needed a person or a second look (see "Reading a layout")
  },
  "testCases": [{
    "schemaVersion": "1.0.0",
    "testCaseId": "CRT-1",                // source ID, or AUTO-<8 hex>; sheet-prefixed when a workbook restarts its numbering
    "title": "Add item",
    "module": "Cart", "moduleSlug": "cart", "suite": null,
    "preconditions": ["The shop has stock"],
    "steps": [
      { "stepNumber": 1, "action": "Open the shop", "testData": [{ "name": "item", "value": "apple", "envVar": null, "declaredLiteral": false }], "expectedResult": "Shop is shown" },
      { "stepNumber": 2, "action": "Add {item} to cart" }
    ],                                    // testData and expectedResult are omitted when the step has none
    "expectedResults": ["The cart has the item"],     // case-level, original wording
    "testData": [{ "name": "item", "value": "apple", "envVar": null, "declaredLiteral": false }],
    "priority": "High", "tags": ["smoke"],
    "source": {
      "file": "input/test-cases/cases.xlsx", "fileName": "cases.xlsx", "format": "xlsx", "sheet": "Cart",
      "row": 2, "endRow": 4,              // spreadsheet row / CSV record line, first and last row of the case (null for Markdown)
      "line": null, "endLine": null,      // Markdown line and last line (null for CSV / Excel)
      "heading": null, "originalId": "CRT-1"
    },
    "metadata": { "Status": "Pass" },     // every source column / label no field claims, under its own name; credentials redacted
    "validation": { "status": "valid", "blocking": [], "warnings": [] }   // issues: { code, severity, message, stepNumber|null }
  }]
}
```

Statuses of a case:

| Status | Meaning | Automated? |
|---|---|---|
| `valid` | nothing to report | yes |
| `warning` | usable; a non-blocking remark (`vague_expected_result`) | yes |
| `needs_clarification` | a person must answer something: `missing_expected_result`, `missing_steps`, `empty_step`, `duplicate_id`, `undefined_data_reference`, `ambiguous_column_mapping`, `possible_secret_literal` | no |
| `invalid` | the case cannot be identified or used as written: `untitled_case` (no ID and no title) | no |

Nothing is invented: a missing step, expected result, credential or data value stays missing and is reported.
`validation.status` must agree with the issues, so a case can't be marked valid by hand.

Reading a layout (`validation.findings`, and the `tables` block of `specs parse` / `input inspect`):

- Headers are matched to fields by name (ID, title, module, steps, expected, preconditions, data, priority, tags), case- and
  punctuation-insensitively. A header that fits a field less well loses to one that fits better (`Test Case Title` beats `Test
  Description`); of equally good columns an empty one is not a rival.
- **Two equally good columns that both hold data** (`Steps` and `Test Steps`) are an `ambiguous_column_mapping`: the first is read,
  but every case of that table is held back (`needs_clarification`) until `input map … --column steps="Test Steps"` names one.
- **Unknown headers**: when no header names the steps / expected result / ID, the columns' content is read (numbered or
  multi-line lists and instruction verbs → steps; "should be shown"-style wording → expected result; unique ID-shaped values →
  ID). Only a reading at 90% confidence or better that completes the table is applied, and it is reported as an
  `inferred_columns` warning. A title is never inferred, only proposed. Anything less is an error that lists the proposals as
  questions; the answer is saved with `input map` and reused.
- Columns no field claims are kept in `metadata`, never dropped.

## Test specs (`test-specs.json`, schemaVersion 2): the view downstream stages read

Projected from the canonical document (`projectSpecs`); it carries `canonical: { schemaVersion, sha256 }`, the hash of the
canonical document it came from. `needs_clarification` and `invalid` cases both appear as `needs_clarification` here.
Step-level data and metadata exist only in the canonical document.

```jsonc
{
  "schemaVersion": 2,
  "generatedAt": "2026-10-20T04:00:00.000Z",
  "sources": [{ "path": "input/test-cases/login.md", "sha256": "…", "format": "markdown" }],   // format: markdown | csv | xlsx
  "specs": [{
    "id": "TC-001",                       // source ID, or AUTO-<8 hex> derived from path + title
    "title": "Valid user can sign in",
    "source": { "path": "input/test-cases/login.md", "line": 3, "originalId": "TC-001", "sheet": null },   // sheet: worksheet name for .xlsx
    "suite": "Login",                     // Markdown "# heading", else null (informational)
    "module": "Login",                    // the feature area; one test file is generated per module
    "moduleSlug": "login",                // file-name form of module (always slugify(module))
    "priority": "High",                   // or null
    "tags": ["smoke", "auth"],
    "preconditions": ["An active test account exists"],
    "dependsOn": ["TC-000"],              // only when the case needs other cases to run first (test IDs, all present in this document)
    "layout": { "module": "Chain TC-000", "moduleSlug": "chain-tc-000" },   // only for a dependency chain across modules: its generated file
    "steps": [
      { "index": 1, "action": "Open the login page", "expected": null },
      { "index": 4, "action": "Click the \"Sign in\" button", "expected": "The dashboard is displayed" }
    ],
    "expectedResults": ["The heading \"Dashboard\" is visible"],
    "testData": [
      { "name": "email", "value": null, "envVar": "TEST_USER_EMAIL", "declaredLiteral": false },
      { "name": "password", "value": "wrong-pass", "envVar": null, "declaredLiteral": true }
    ],
    "ambiguities": [],                    // { kind, message, stepIndex|null }
    "status": "ready"                     // or "needs_clarification"
  }]
}
```

## Rules enforced by the validators

- `module` is required and `moduleSlug` must equal its slug. A module is, in order: the saved `input map --module`, the row's
  module column (an empty cell inherits the one above), the title prefix (`input map --module-from title-prefix`), the heading
  row above the case (a row with only its ID cell filled), the Markdown `# heading`, the sheet name (generic names such as
  `Sheet1` don't count), then the file name. Cases whose modules slug to the same value are one module.
- Generated tests are organised by module: `generate validate` fails if a test file mixes two modules or one module's tests
  are split over several files (`engine/pipeline/generation.ts`, `moduleLayoutIssues`).

- `dependsOn` lists test IDs that exist in the document. A chain of dependent cases is generated in one file in dependency order inside a
  serial group; across modules the chain's file is `chain-<first id>` (`layout`). A reference that is not a test, a loop, or a case that needs a
  blocked case is a blocking ambiguity (`unresolved_dependency`, `dependency_cycle`, `dependency_not_ready`); a precondition naming another case is read
  as a dependency with a `dependency_inferred` warning. `generate validate` and the static review check order, file and serial group.
- IDs match `PREFIX-REST` and are unique. Duplicate source IDs are flagged on every occurrence and suffixed `-dup2`, …
- Steps are numbered 1..n. Wording is copied verbatim from the source.
- Each `testData` entry has exactly one of `value` / `envVar`; `envVar` is a variable **name**.
- Credential-looking literals (password/token/secret/API-key fields, username/email fields, any email address) are
  never stored: the parser writes `envVar: "TEST_<NAME>"` and `specs parse` puts the value in `automation/.env`.
  Email addresses typed inside steps become `{email}` placeholders with a Test Data entry. `literal:<value>` keeps a value as is.
- `status` must agree with the ambiguities, so a case can't be marked ready by hand. Blocking kinds (`missing_expected_result`,
  `missing_steps`, `empty_step`, `duplicate_id`, `undefined_data_reference`, `ambiguous_column_mapping`, `untitled_case`, and
  `possible_secret_literal` for a value that cannot be stored in a `.env` file, and the dependency kinds `unresolved_dependency`, `dependency_cycle`,
  `dependency_not_ready`) make the spec `needs_clarification`;
  `vague_expected_result` is a warning.
- The `test_analysis` stage completes only if **both** `canonicalCases` and `testSpecs` are registered, the canonical document is
  valid and has no input errors, at least one case is `valid` or `warning`, every source file still has the hash recorded in it,
  and `test-specs.json` is exactly the projection of the canonical document (hash and content). `generate plan`, `generate
  assemble`, `generate validate`, `explore plan/assemble` and `review plan/seal` repeat that last check, so a hand-edited
  `test-specs.json` stops the pipeline. `specs check <runId>` runs it on demand and lists the cases that are not automatable.
  Cases that are not `valid` or `warning` are never generated; they are reported as `blocked` tests with the reason.

## Other run artifacts

These live in `dependencies/runs/<run-id>/`. Playwright's own output (reporter files, screenshots, video, traces) is
written to the framework: `automation/reports/<run-id>/<label>/` and `automation/test-results/<run-id>/<label>/`.

| File | Schema source |
|---|---|
| `manifest.json` | `engine/pipeline/run-manager.ts` |
| `canonical-test-cases.json` | `engine/pipeline/canonical.ts` |
| `input-validation.json` | `engine/pipeline/input-validation.ts` |
| `exploration/exploration.json` | `engine/pipeline/exploration.ts` |
| `generation-manifest.json` | `engine/pipeline/generation.ts` |
| `review-report.json` | `engine/pipeline/static-review.ts` |
| `execution-results.json`, `regression-results.json`, `reruns/*.json` | `engine/pipeline/execution.ts` |
| `failure-analysis.json` | `engine/pipeline/failure-classifier.ts` |
| `healing-log.json` | `engine/pipeline/healing.ts` |
| `summary.json`, `summary.md` | `engine/pipeline/reporting.ts` |

Also in the run directory: `normalized-input/<module-slug>.md`, written by `specs parse`: the same cases in the pipeline's
Markdown format, one file per module (credentials appear as `env:VAR`, never as values).

The saved column mappings for non-standard CSV/Excel layouts are in `dependencies/state/input-mapping.json`
(`engine/pipeline/input-table.ts`; written only by `input map`).

Stage → required artifacts: `engine/pipeline/stage-contracts.ts`.
