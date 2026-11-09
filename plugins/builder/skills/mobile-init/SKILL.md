---
name: mobile-init
description: Scaffold the Maestro mobile framework into mobile-automation/ (tools, config, flows/common, suites, docs, state) next to the Playwright folders without touching them, or refresh its plugin-managed tools. Installs nothing and touches no device.
argument-hint: "[--update] [--dir mobile-automation] [--dry-run]"
disable-model-invocation: true
---

# /builder:mobile-init

Creates the mobile framework folder and nothing else: no installs, no device access, no configuration of the app. For the full guided
flow (prerequisites, configuration, flows, device validation) use `/builder:build-mobile-automation`, which runs this as its step 2.

Arguments: `$ARGUMENTS`. Read [../playwright-pipeline/environment.md](../playwright-pipeline/environment.md) first (project root, locating the plugin, Cowork).

1. Resolve `<root>` (the project folder; in Cowork the attached folder, passed as `--root`).
2. Dry run, then summarise `created`, `overwritten`, `skipped`, `merged`, `removed` and `warnings`:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/mobile-init.mjs" --dry-run --root "<root>" $ARGUMENTS
   ```

   If `${CLAUDE_PLUGIN_ROOT}` is not expanded or the script is missing, locate the plugin as environment.md describes (search for `scripts/mobile-init.mjs`).
   Exit 2 with `needsInput: "root"` → rerun with one of `candidateRoots`.
3. `overwritten` / `removed` are non-empty only with `--update` (the plugin-managed `tools/` folder) or `--force`. If anything would be overwritten or removed, show it and
   ask first. `--update` never touches flows, config, tests, docs or state. Without it a rerun skips every existing file and warns when `tools/` is older than this plugin.
4. Run it for real (same arguments, no `--dry-run`). Confirm `projectRoot` and `frameworkFolder` in the reply. `--dir` cannot be `automation` or `dependencies`
   (the Playwright framework's folders); `automation/` and `dependencies/` are never read or changed.
5. Report what was created and the next step: `/builder:build-mobile-automation` (checks Maestro/Java/Android/iOS tooling and devices, configures, generates flows).
   The project's root `CLAUDE.md` gets the mobile rules between `<!-- builder-mobile:start/end -->`.

What it creates (all user-owned except `tools/`): `tools/` (CLI), `config/environments/`, `flows/common/launch-app.yaml`, `tests/{smoke,critical,regression}.yaml`,
`test-data/`, `docs/flow-conventions.md` (+ example), `state/scaffold.json`, `.gitignore`, `.env.example`, `README.md` (commands and CI stages).
