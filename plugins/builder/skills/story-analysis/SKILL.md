---
name: story-analysis
description: Understand one user story, supplied in the worker input, and extract the behaviour needed for test design (summary, behaviour to validate, acceptance-criteria intent, business rules, preconditions, dependencies, NFRs, ambiguities) as one compact structured result, without producing an analysis report. Used by the single-story worker for every story before coverage design.
user-invocable: false
---

# Story analysis

Goal: a compact, accurate picture of **one** story to design tests from. The orchestrator starts a fresh `story-analyser` invocation per story and hands it only that story, so this skill never looks beyond its input. The result is an internal handoff to coverage design, validated and checkpointed by `test-design/scripts/story-analysis-state.py`; it is not a user-facing report and is never appended to a source story.

## Input

One JSON object (`test-design/schemas/story-analysis-input.schema.json`): `run_id`, `story_id`, `story_content`, `relevant_shared_rules`, `dependency_context`, `analysis_instructions`, `output_schema_version` (2). Nothing else is available. Do not open story files, and do not look for other stories or earlier analyses.

## Procedure

1. **Read `story_content` in full.** It is the whole story. Treat `relevant_shared_rules` as conventions that apply to it, and `dependency_context` as read-only reference.
2. **Extract**, in the story's own words:
   - `story_summary`: one sentence, who needs what and why (add `title` if the story has one).
   - `behaviour_to_validate`: the observable behaviours worth verifying, each one short.
   - `acceptance_criteria_interpretation`: each acceptance criterion as `AC-1`, `AC-2`... in source order, with what it requires.
   - `business_rules`: rules and constraints with exact values (limits, durations, formats) as `BR-1`..., including those that come from a supplied shared rule when the story relies on it.
   - `relevant_non_functional_expectations`: testable NFRs with measurable targets as `NFR-1`... Ignore vague ones ("should be fast") unless a target is given.
   - `preconditions`: accounts, roles, plans, records the story needs.
   - `dependencies`: other story IDs, systems or data the story needs. Take what the story states; use `dependency_context` only to word a precondition or journey step.
   - `messages`: exact UI texts, URLs or values the story states, so expected results can quote them.
   - `test_design_considerations`: observations that help choose techniques (a numeric limit, a state machine, role-based outcomes). Not test cases.
3. **Decide testability.** If the story states no observable behaviour (a pure heading, a placeholder), set `testable: false` with `not_testable_reason`; the orchestrator records `no_testable_behaviour`.
4. **Raise ambiguity sparingly.** Put missing or unclear information in `ambiguities` with the question in one sentence. Set `blocking: true` only when the gap stops you writing an assertable expected result for a stated criterion (for example "locked for a while" with no duration, or a message that is not given and cannot be observed otherwise), and add `why` and the `blocks` labels. Detail that merely limits depth is `blocking: false`. Never fill a gap with an assumption.
5. **Return** one JSON object (not a file, not a report), `analysis_complete: true`, then finish:

```json
{
  "story_id": "US-001", "title": "Registered user login",
  "story_summary": "A registered user signs in with email and password to reach the dashboard.",
  "behaviour_to_validate": ["Valid credentials open the dashboard", "A wrong password is rejected with a message", "The account locks after repeated failures"],
  "acceptance_criteria_interpretation": [
    {"label": "AC-1", "text": "Valid credentials reach the dashboard"},
    {"label": "AC-2", "text": "A wrong password shows \"Invalid email or password\""}
  ],
  "business_rules": [{"label": "BR-1", "text": "Account locked 15 minutes after 5 consecutive failures"}],
  "preconditions": ["A registered, active account exists"],
  "messages": ["Invalid email or password"],
  "test_design_considerations": ["Boundary at 5 consecutive failures (4, 5)"],
  "ambiguities": [],
  "analysis_complete": true
}
```

Optional fields that would be empty (`business_rules`, `preconditions`, `dependencies`, `relevant_non_functional_expectations`, `messages`, `test_design_considerations`, `ambiguities`, `testable`) may be omitted. Labels are unique across `AC-`, `BR-` and `NFR-`.

## Never

- Invent a requirement, value or message. If the story does not say it, it is not there.
- Analyse more than the one supplied story, or treat a dependency excerpt as a second story to analyse.
- Repeat BA gap analysis, grade story quality, or rewrite the story.
- Edit any file.
