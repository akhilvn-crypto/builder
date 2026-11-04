---
name: test-coverage-design
description: Choose suitable test-design techniques for one analysed story and derive a minimal, non-duplicative set of test conditions that covers every acceptance criterion, business rule and testable NFR. Use after story analysis and before authoring test cases.
user-invocable: false
---

# Test coverage design

Input: the validated story analysis (`acceptance_criteria_interpretation` `AC-n`, `business_rules` `BR-n`, `relevant_non_functional_expectations` `NFR-n`, `messages`, `preconditions`, `test_design_considerations`; schema `test-design/schemas/story-analysis.schema.json`) plus the list of scenarios already saved for the same story (titles only, from its own file). Output: a list of test conditions. Not saved; the authoring step turns each into a case.

## Choose techniques by what the story contains

| Story contains | Use |
|---|---|
| Any stated behaviour | **Positive** (the main success path) and the **negative** alternatives the story states |
| Numeric/length/date limits, thresholds, counts | **Boundary value analysis**: just inside, on, just outside each stated limit (min-1, min, max, max+1) |
| Input classes (types of user, formats, plans) with different outcomes | **Equivalence partitioning**: one case per partition, not per value |
| Several conditions combining into outcomes (roles x state x flags) | **Decision table**: one case per distinct rule row; merge rows with the same outcome |
| Statuses and transitions (locked/unlocked, draft/published) | **State transitions**: each valid transition, plus an invalid one when the story forbids it |
| A journey across stories or systems | **End-to-end / integration**: one journey case covering the hand-offs, not a copy of the unit cases |
| Measurable NFR (time, size, retries, accessibility rule with a check) | **Non-functional** case with the measurable target as the expected result |
| Roles/permissions | One allowed and one denied case per distinct permission rule |

Do not apply a technique the story gives no basis for. Boundaries need a stated limit; do not guess one.

## Procedure

1. List each criterion/rule/NFR label. For each, pick the cheapest technique that proves it.
2. Derive conditions. Each: `{condition, technique, covers: ["US-001#AC-1"], priority?, dependsOn?}`.
   - `covers` uses the story ID and label from the analysis. A condition can cover several labels; a label can need several conditions (boundaries).
   - `priority` only when meaningful: Critical (security, data loss, money), High (core journey), Medium, Low.
   - `dependsOn` only when a case genuinely cannot run without another **case of the same story** having run first (for example "edit profile" needs the profile created by an earlier case). Prefer independent cases with their own Preconditions; shared setup is not a dependency, and a prerequisite owned by another story is a precondition, never a dependency, because each story's file must be usable alone.
3. **Remove duplication.** Drop a condition if a saved or already-listed scenario has the same preconditions, data and outcome. Merge conditions that differ only in wording. Keep boundary conditions even when they look similar: different data on a different side of a limit is a different scenario.
4. **Check coverage.** Every `AC`, `BR`, and measurable `NFR` label must appear in at least one `covers`. A label you cannot cover (not observable, needs missing information) goes in `uncovered` with a reason; never pad with a vague case.
5. Return JSON: `{"storyId": "...", "conditions": [...], "uncovered": [{"label": "...", "reason": "..."}]}`.

## Sizing

Aim for the minimum set that gives meaningful coverage, not a fixed count. A simple read-only story may need 1-2 cases; a rule with a limit typically needs 3-4 (inside, boundary, outside, and the consequence).
