# Running in Claude Code (CLI) and Claude Cowork

Every pipeline command (`init`, `do-automation`, `design-test-n-automation`, `playwright-pipeline`, `generate-tests`, `run-tests`, `heal-tests`, `reports`) and the test-design command (`generate-test-cases`) follows this page. The design scripts need Python 3.9+ on the machine (Cowork's sandbox normally has it); if it is missing, say so and ask before installing anything.
The pipeline is the same in both; what differs is how you reach the user and where files live.

## Asking the user

A choice goes to the user as a **dialog** (the `AskUserQuestion` tool) when that works, and as a **numbered question in chat**
when it does not. Either way you stop and wait for the answer. Never pick for the user, never treat a "(Recommended)" option as
chosen, never carry on past a material choice (language, test-case path, reports, evidence, browsers, auth, cleanup, installs).

1. **Make the tool callable.** If `AskUserQuestion` is not among the tools you can call, it may be deferred: load it first
   (`ToolSearch` with query `select:AskUserQuestion`), then call it. A tool that is only named but has no schema cannot be called.
2. **Call it correctly**, or the whole call is rejected and the user sees nothing:
   - 1–4 questions per call; each has a `header` (max 12 characters), a `question` ending in `?`, `multiSelect` (true/false) and
     **2–4 options**, each with a short `label` (1–5 words) and a `description`.
   - Put the recommended option first and end its label with `(Recommended)`. Do **not** add `Other`, `None` or `Skip`
     options: the dialog already offers free-text input.
   - One candidate value only (e.g. a base URL found in a test case)? Ask a confirm question: *Yes, use as-is (Recommended)* /
     *No, I'll give a different value*. A free-text field with no candidate is asked in plain chat.
3. **Fall back to chat** when the tool is missing, rejected (`InputValidationError`: fix the question once, don't resend it
   unchanged), errors, or comes back with no usable answer. Write the question once, as a numbered list, then end your turn:

   ```
   Which language should the Playwright framework and generated tests use? (fixed for the project)
     1. TypeScript (recommended): typed fixtures and page objects, compile-time checks of generated tests
     2. JavaScript: plain ES modules, no compiler
   Reply with 1 or 2, or tell me something else.
   ```

   Several questions in one message are fine if numbered (`Q1`, `Q2`…). Read the reply, confirm in one line what you understood
   if it was free text, and go on. Do not re-ask what the user already answered, in either form.
4. **Only the main session asks.** Subagents cannot show dialogs: they return their questions to you and you ask them.

## Where things are

- **Project root** = the folder the user's project lives in (Claude Code: the launch folder; Cowork: the folder the user attached
  or selected for the task). `automation/` and `dependencies/` are created there. Run every `node dependencies/engine/cli/pipeline.ts …`
  from it.
  **In Cowork the shell's starting directory is usually NOT that folder.** It is a per-session scratch folder, and the attached
  folder is mounted beside it, typically `mnt/<folder name>` (other entries in `mnt/` such as `outputs`, `uploads` or dot-folders are
  not the project). Files written anywhere else are not saved to the user's folder. So, before the first command of any pipeline
  command, once per session:
  1. Find the root: the attached folder named in the session (or the one `mnt/` entry that is the user's folder; `ls mnt`). If several
     candidates remain and none is clearly the user's project, ask which one (numbered chat question).
  2. Remember it as `<root>` and never write outside it. Pass it to the scaffolder as `--root "<root>"`, and start every engine command
     with `cd "<root>" &&` (shell state may not persist between calls).
  3. After scaffolding, check `<root>/dependencies/engine/cli/pipeline.ts` exists and tell the user the root path you used. If the
     scaffolder answers `needsInput: "root"`, it refused to write into the session scratch folder: use one of its `candidateRoots`.
  4. If no folder is attached, or it is read-only (a write fails), stop and ask the user to attach a writable folder. Do not scaffold
     into the scratch folder, `outputs/` or the plugin folder, and do not report success.
- **Plugin files** (`scripts/init.mjs`, `skills/…`) are at `${CLAUDE_PLUGIN_ROOT}`. If that variable arrives unexpanded or empty,
  or the file is not there (Cowork mounts plugins read-only under paths such as `mnt/.local-plugins` or `mnt/.plugins`), find it:
  `find mnt/.local-plugins mnt/.plugins -path '*builder*' -name init.mjs 2>/dev/null`, and if those folders do not exist
  `find / -path '*builder*/scripts/init.mjs' -not -path '*/node_modules/*' 2>/dev/null`. Use the match whose
  `../.claude-plugin/plugin.json` has `"name": "builder"` (newest `version` if there are several), and use its folder
  wherever these docs say `${CLAUDE_PLUGIN_ROOT}`. Never copy plugin files by hand into the project.
- **Commands are POSIX shell** in both. Quote paths; on Windows CLI the Bash tool is Git Bash, in Cowork it is a Linux shell.

## Cowork specifics

- **No Node version is enforced** (the engine runs TypeScript directly, so the Node must support that natively). If the CLI cannot
  start at all because of the `.ts` extension, stop and say so; do not install Node or work around it.
- Installs are still **one approval per dependency**, into `automation/`, exactly as in the CLI. "Automatic" never means
  "installed without asking". Browsers are downloaded inside the sandbox; tests run headless. Do not use `test:headed`.
- The app under test must be reachable **from the sandbox**. A `localhost` URL on the user's own machine is not: if
  `application_exploration` cannot reach the base URL, mark the stage `blocked`, say it may be a sandbox network limit, and ask for
  a URL the sandbox can reach. Never invent one.
- **Check the sandbox can do the job before the user invests in setup.** The sandbox has an egress allowlist, and a private QA/staging
  host or the Playwright browser download is often outside it. Run these two checks as soon as the base URL is confirmed (or, with no
  base URL yet, at the start of `configuration`), and **before** asking about reports, auth, cleanup or any install:
  1. App: `curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "<baseUrl>"`. Any HTTP answer from the app (200, 3xx, even 401/404)
     means reachable. A `403` that comes from the sandbox proxy rather than the app, a timeout, a DNS failure or a connection error
     means **not reachable**. If unsure which one answered, `curl -sI` and look at the `server`/`via` headers.
  2. Browser: `node dependencies/engine/cli/pipeline.ts preflight` reports whether the browser the config needs is in the cache.
     If it is missing, a download check such as `curl -sSI --max-time 15 https://cdn.playwright.dev` that fails means it cannot be
     installed here. A different Playwright build already preinstalled in the sandbox does not count: the browser revision must
     match the installed `@playwright/test`. Do not change the pinned version to chase a preinstalled browser unless the user asks.

  If either check fails, **stop before the next question**. Do not mark stages completed or approve installs. Tell the user in plain
  words what the sandbox cannot reach, that exploration and execution need both, and that this project should be run from Claude Code
  on a machine that can reach the app (the project folder, config and imported test cases carry over). Offer to continue only with
  the stages that need neither (input validation, test analysis) if they want that. A run that stops this way is `blocked` with the
  reason recorded, not `failed`.
- **`.env` files.** Cowork's file-writing tools may refuse `.env` paths. Write credentials only through the engine (the
  credential-extraction commands in test-data-management), never with a file tool, and never paste a value into chat. If the write is
  still refused, say so, list the variable **names** the user must put in `automation/.env` on their own machine, and treat the
  credentials as missing; do not store them anywhere else.
- **Agents.** Delegate with the Agent tool as the stages say. If a `builder:<agent>` type is not available, do that
  agent's job yourself in the main session: read `agents/<name>.md` from the plugin root and follow it, with the same bounded
  brief, the same CLI validators and the same limits (a stage is completed only when the CLI accepts its artifacts).
- Files you tell the user about (`summary.md`, reports, the evidence PDF) are in the project folder; give the paths relative to it.
