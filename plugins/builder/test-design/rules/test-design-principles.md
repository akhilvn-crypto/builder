# Test design principles

1. **Design from the story.** Tests come from the supplied story text and any rule or decision the user confirmed during this run. The story is the source of truth.
2. **Never invent.** Do not add requirements, limits, messages, field names or expected results the story does not state. If a missing detail stops you writing an assertable expected result, ask one focused question; if it only limits depth, say so in the run summary.
3. **No repeat of BA work.** Do not run gap analysis, rewrite stories, or produce a story-analysis report. Ambiguity is raised only when it blocks meaningful test design.
4. **Technique follows risk.** Choose techniques per story (positive/negative, boundary value analysis, equivalence partitioning, decision tables, state transitions, end-to-end/integration, applicable non-functional). Do not force every technique onto every story; a read-only label needs fewer cases than a payment rule.
5. **Every criterion is covered.** Each acceptance criterion, business rule and testable NFR of the story is verified by at least one case, or is explicitly listed as not testable with the reason.
6. **Minimum sufficient set.** One case per distinct behaviour. Two cases that differ only in wording are one case. Cases that differ in data that exercises a different partition or boundary are two.
7. **Concise but complete.** No hard length limit: completeness, clarity and testability come before brevity. Do not repeat the story text in a case.
8. **What, not how.** Describe user or system actions and observable outcomes. Playwright code, selectors, locators and waits belong to the downstream Builder.
9. **Intermediate reasoning stays out.** Coverage notes are transient. Only the canonical test cases, the traceability metadata and the compact structured story-analysis result (an internal checkpoint under `state/analysis/`, never a report and never written into a source story) are saved. Worker transcripts are not stored.
