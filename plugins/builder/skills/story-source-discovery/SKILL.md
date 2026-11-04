---
name: story-source-discovery
description: Resolve a user-provided story location (file path, directory, or bare file name) to Markdown story files, handle ambiguity, confirm the project root and output location, and verify read/write access. Use at the start of every run and when the user changes the source.
user-invocable: false
---

# Story source discovery

`PY` below is the first of `python`, `python3`, `py -3` that runs. `SCRIPTS` is `${CLAUDE_PLUGIN_ROOT}/test-design/scripts` (if the variable is not expanded, find the folder containing `.claude-plugin/plugin.json` named `test-design`). Always quote paths.

## Procedure

1. **Locate** (unless the command already gave it). If the project has a `stories/` folder with Markdown files (where the BA stories are saved: `stories/detailed_stories.md`), offer it as the recommended answer and let the user type another location instead. Only when there is none ask: "Where are your user stories located?" Accept a Markdown file path, a directory path, or a file name. Strip surrounding quotes. Never search the disk for stories.
2. **Resolve:** `PY SCRIPTS/discover-story-files.py "<input>" --cwd "<current working directory>"`. Add `--search-root "<dir>"` for other folders the session can see (for example a mounted workspace). Read the JSON; do not re-derive it.
3. **Act on `status`:**
   - `not_found`: say what was tried (`notes`), and ask again. A `.txt`/`.docx`/`.xlsx` file is not supported yet: only `.md`.
   - `ambiguous`: show `matches` as a short numbered list and ask which one.
   - `found`: continue.
4. **Select files and stories.** One candidate: use it. Several: show a concise numbered list (`relPath`, story IDs found), and ask which to process (numbers, ranges, or "all"). Then the stories: if the chosen files hold more than one story and the command did not name any (`--story`), offer *All N stories (Recommended)* or a choice of story IDs; the answer is the set `STORIES` the orchestrator works on. Stories that turn out to have nothing testable are skipped later by the analysis, not here. Mention exclusions only if they explain something (for example "1 non-Markdown file skipped").
5. **Story IDs.**
   - `duplicateStoryIds` not empty: show the clash and ask which file is authoritative; never merge two stories silently.
   - `inferredStoryIds` not empty: the file has no `US-001`-style headings. Offer to treat the whole file as one story named after the file, or let the user supply an ID. Never invent a numeric ID.
6. **Project root and output.** Use `projectRootSuggestion` (the story directory for a directory input, its parent for a file input). Ask for confirmation in the same question as the file list: state the root and `<root>/test-design/` as the output location, and let the user change the root.
   - If `existingOutput.exists` is true, do not create a competing structure. If it holds `state/workflow.json`, offer to resume (see `workflow-resume`). If `test-design/` holds something else, ask where to put the output.
   - If the root is not the user's project (for example a read-only share or the plugin folder), ask for a different writable root.
7. **Verify access:** `PY SCRIPTS/safe-file-operations.py check-access --root "<root>" --source "<file>" ...` (one `--source` per selected file). It probes writability without creating the output folder. If `ok` is false, explain which side failed and ask for an accessible location. On a surface that cannot run scripts or touch the filesystem, say so plainly and ask for a supported handoff; do not change the workflow silently.

## Do not

- Read story contents beyond what the discovery output already gives you. Reading stories is `story-analysis`'s job, one at a time.
- Write anything during discovery.
- Include `test-design/` output from a previous run as a story source (the script already skips it).
