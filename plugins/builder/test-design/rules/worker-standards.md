# Story worker standards (compact)

A digest of `test-case-format.md`, `test-design-principles.md`, `test-data-and-secrets.md` and `traceability.md` for the one-story worker. The full files win if they disagree; read one only when this digest does not answer your question.

## Design

- Design only from the supplied story, the supplied shared rules and the user's confirmed decisions. Never invent a requirement, limit, message, field or expected result.
- Cover every acceptance criterion (`AC-n`), business rule (`BR-n`) and testable non-functional expectation (`NFR-n`) with at least one case, or list it as uncovered with a reason.
- Pick techniques by risk (positive/negative, boundaries, equivalence classes, decision table, state transition, end-to-end, non-functional). One case per distinct behaviour; no two cases that differ only in wording.
- Describe what to validate, not how to automate it: no selectors, locators, waits or code.
- Ask nothing. A blocking question is returned for the orchestrator to ask; it is blocking only when it stops an assertable expected result.

## File shape (unchanged contract)

```
# Module
User Story ID: <the story>

## <ID>: <Title>
Priority: High|Critical|Medium|Low        (optional)
Tags: a, b                                 (optional)
Depends on: <ID in this same file>         (optional)

### Preconditions                          (only if needed)
- ...
### Test Data                              (every {variable} used)
- name: value | env:UPPER_SNAKE | literal:fixed
### Steps
1. one action each, optional inline "-> Expected: ..."
### Expected Results
- specific, observable, assertable
```

- Headings only `#`, `##` and the four `###` above, in that order. No prose between them, no story IDs or criterion labels inside a case.
- IDs come from `generate-stable-id.py` (never hand-typed) unless the story supplies its own. An existing ID is never changed.
- The file is self-contained: `Depends on:` names only cases in the same file; setup from another story is a precondition.
- Prefer 3-8 steps. Quote exact messages and values from the story.

## Data and secrets

- Secrets and environment-specific values: `env:NAME` (UPPER_SNAKE_CASE). Deliberately fake values: `literal:value`. Ordinary values: plain.
- Never copy a secret value into a case, a result, a message or a file. Reuse one variable name per secret.

## Ownership

- You write only your own `<story>-testcase.md` (through `story-worker.py complete`) and your own result file. You never write `workflow.json`, `traceability.json`, `audit.jsonl`, `state/analysis/`, another story's file, or anything in the story sources.
- You never replace, regenerate or adopt an existing file: the script stops and returns `needs_decision` or `staged`, and the orchestrator asks the user.
- Metadata per case: `id`, `title`, `module`, `storyIds` (`["<story>"]`), `covers` (`"<story>#AC-1"`), `techniques`, `scenarioKey` (from the ID script). It lives in the metadata file, never in the Markdown.
