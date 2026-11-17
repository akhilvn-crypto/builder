---
name: test-coverage-design
description: Derive a thorough, traceable, non-duplicative set of test conditions for one analysed story - every acceptance criterion, business rule and testable NFR, plus every variation of the stated behaviour that a tester would normally check (partitions, boundaries, roles, states, messages, data effects, robustness) - so manual QA is needed only for what automation cannot observe. Use after story analysis and before authoring test cases.
user-invocable: false
---

# Test coverage design

Input: the validated story analysis (`acceptance_criteria_interpretation` `AC-n`, `business_rules` `BR-n`, `relevant_non_functional_expectations` `NFR-n`, plus `messages`, `preconditions`, `inputs`, `roles`, `states_and_transitions`, `data_effects`, `test_design_considerations`; schema `test-design/schemas/story-analysis.schema.json`) and the titles already saved for the same story (its own file). Output: a list of test conditions. Not saved; the authoring step turns each into a case.

**Goal: coverage as complete as the story supports.** The aim is that a QA engineer would find little left to check by hand. One case per criterion is not coverage; a criterion is covered when its success path, each stated failure, each partition and boundary of its data, each role and state it touches, and what the user sees afterwards are all checked. Completeness never excuses invention: every case must still be traceable to a label and assertable from what the story (or a confirmed decision) says.

## Three tiers of condition (the `basis`)

| basis | what it is | expected result comes from | Tags in the case |
|---|---|---|---|
| `stated` | behaviour the story says outright (an AC, a rule, a message) | the story's own words | none extra |
| `derived` | a variation of stated behaviour obtained by a recognised technique: each partition, boundary, role, state, filter, calculation example, "what persists afterwards" | deduced directly from the stated rule (a mandatory field rejects an empty value; a limit of 8 rejects 7) | `derived` |
| `robustness` | a standard defect-prone condition around a feature the story does state (double submit, refresh, back button, session expiry, special characters, very long text, leading/trailing spaces, handled server error) | only a **universal invariant** (below), never story-specific text | `robustness` |

Universal invariants a `robustness` case may assert: no unhandled error, blank or stack-trace page and the application stays usable; rejected or failed input is not saved or shown as saved; a repeated action creates no duplicate record; entered text is shown back as text and is not executed or interpreted; another user's data is never shown. A `robustness` case never asserts a message text, redirect target, limit or timing the story does not state. If the exact behaviour matters and is not stated, assert the invariant only and let the worker mention it as a non-blocking question.

`derived` and `robustness` cases always carry `Priority` (`derived` normally High/Medium, `robustness` Medium/Low) so QA can filter them. Never use them to smuggle in new requirements.

## Technique by what the story contains (apply every row that has a basis in the story)

| Story contains | Use |
|---|---|
| Any stated behaviour | **Positive** (main success), every stated **alternate flow**, every stated **negative/failure** |
| A limit, threshold, count, length, date range | **Boundary value analysis**: min-1, min, min+1, max-1, max, max+1 for each *stated* limit; the consequence of crossing it |
| Input classes (formats, user types, plans, categories) | **Equivalence partitioning**: one case per partition (valid class, and each distinct kind of invalid), not per value |
| Several conditions combining into an outcome | **Decision table**: one case per rule row, including the all-false and mixed rows; merge only rows with identical outcome *and* identical reason |
| Statuses and transitions | **State transition**: every stated valid transition, every stated forbidden one, the behaviour in each state, the state after refresh/re-login |
| Roles / permissions | For each distinct role: allowed action works, denied action is refused (or hidden, as the story says); unauthenticated access when the story involves a signed-in area |
| Lists, search, filters, sorting, paging | empty result, one result, many, page-size boundary, each filter alone and combined, sort both ways, clearing the filter |
| A calculation or derived value | a worked example per formula branch, zero/minimum/maximum, rounding when stated |
| Messages, notifications, emails | exact text, where and when shown, shown once, gone after correction, absent on success |
| Named UI elements | enabled/disabled/visible per state, label text, required indicator, default value, Enter/Tab behaviour when the story names the control |
| Data effects (create, update, delete, save) | the result is visible where the story says, values are shown unchanged after reload or re-login, cancel/failed validation leaves data unchanged, optional fields left empty |
| A journey or hand-off | **End-to-end**: the whole journey once, with each hand-off asserted; not a copy of the unit cases |
| Measurable NFR | **Non-functional** case with the measurable target as the expected result |

Do not apply a row the story gives no basis for. A boundary needs a stated limit; never guess one. A format check needs a stated format.

## Procedure

1. **Inventory.** List every `AC`, `BR`, `NFR` label and every input, role, state, message, list and data effect from the analysis. This is the checklist for step 4.
2. **Derive conditions per label**, applying every technique row that fits. Each condition: `{condition, technique, basis, covers: ["US-001#AC-1"], priority?, dependsOn?}`.
   - `covers` always names at least one real label from the analysis, the criterion the condition probes (a field-validation case covers the AC or BR that governs the field). Robustness conditions cover the label of the action they stress. A condition may cover several labels; a label normally needs several conditions.
   - `priority`: Critical (security, data loss, money), High (core journey, stated negatives), Medium, Low.
   - `dependsOn` only when a case genuinely cannot run without another **case of the same story** having run first. Prefer independent cases with their own Preconditions. A prerequisite owned by another story is a precondition, never a dependency.
3. **Robustness pass.** For every action that submits, saves, deletes or changes data, and every text input, consider the robustness conditions above and keep those that are meaningful for this story. Skip those that do not apply (no text input, no session, nothing is saved).
4. **Completeness sweep.** Walk the inventory once more: for each AC/BR, is there a success, each stated failure, each partition/boundary, each role and state it touches, and the "what the user sees afterwards" check? For each input, role, state, list and message, is there a condition? Add what is missing. Record any dimension you skipped, with the reason, as `sweep_skipped` entries (for example `{"area": "pagination", "reason": "the story has no list"}`). An unexplained skip is a gap.
5. **Remove only true duplicates.** Drop a condition only if another has the **same preconditions, the same data partition and the same outcome**. Different data on a different side of a limit, a different kind of invalid input, a different role or a different state is a different scenario: keep it. Merge only conditions that differ in wording alone.
6. **Check coverage.** Every `AC`, `BR` and measurable `NFR` label appears in at least one `covers`; each AC and BR normally appears in two or more. A label you cannot cover (not observable, information missing) goes in `uncovered` with a reason; never pad with a vague case and never write an expected result you cannot derive.
7. Return JSON: `{"storyId": "...", "conditions": [...], "uncovered": [{"label": "...", "reason": "..."}], "sweep_skipped": [...]}`.

## Sizing: a floor, not a ceiling

There is no maximum. As a guide, a criterion with a data rule typically yields 3-6 conditions (success, each invalid partition, each boundary side, the consequence), a state or role rule one per transition or role, and a story with four or more criteria typically yields well over ten cases. A story whose set is short (for example 11 cases for several multi-rule criteria) should be treated as under-covered: re-run the sweep before finishing. Read-only stories with no input, role or state really are small; say why in `sweep_skipped` rather than stopping early.

Check the numbers with `story-worker.py coverage` before saving.
