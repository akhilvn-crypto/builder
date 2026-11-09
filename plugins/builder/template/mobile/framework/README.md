# Mobile automation (Maestro)

Maestro YAML flows for the Flutter app, generated from test cases and run on real devices. Created by `/builder:mobile-init`
(or `/builder:build-mobile-automation`); the files outside `tools/` are yours to edit. Conventions: [docs/flow-conventions.md](docs/flow-conventions.md).

## Commands (from the project root)

```
node mobile-automation/tools/maestro-cli.mjs preflight --platform android      # what is installed, what is missing and why
node mobile-automation/tools/maestro-cli.mjs devices --platform android        # connected phones, physical or emulator
node mobile-automation/tools/maestro-cli.mjs device verify --platform android  # authorised, Maestro can read it, app installed
node mobile-automation/tools/maestro-cli.mjs validate                          # YAML, references, selectors, assertions, secrets
node mobile-automation/tools/maestro-cli.mjs run --platform android --suite smoke      # a suite
node mobile-automation/tools/maestro-cli.mjs run --platform android --flow flows/<feature>/<flow>.yaml
node mobile-automation/tools/maestro-cli.mjs run --platform android --feature authentication
node mobile-automation/tools/maestro-cli.mjs run --platform android --all --strict     # --strict: exit 1 if anything failed (CI)
node mobile-automation/tools/maestro-cli.mjs report build                      # rebuild the latest run's reports
node mobile-automation/tools/maestro-cli.mjs validation status                 # validated on a physical device yet?
```

Anything needing Claude (generating flows from test cases, repairing selectors, asking you things) is `/builder:mobile-*`.

## CI readiness

The same CLI runs anywhere Node 18+, Java 17+, Maestro and a connected device exist. Nothing is installed for you.

| Stage | Command | Why |
|---|---|---|
| Pull request / build | `run --platform android --suite smoke --env staging --strict` | focused, fast |
| Post-deployment | `run --platform android --suite critical --env staging --strict` | business-critical and high-risk journeys |
| Nightly | `run --platform android --suite regression --env staging --strict` | broad coverage |

Required on the runner: the app build installed on the device (`app install … --approved`, or your pipeline's own step), secrets exported
as environment variables named `MAESTRO_<NAME>` (or a `.env` created from `.env.example`), and `config/environments/<env>.json`.
`reports/<runId>/junit.xml` is the file CI test-result viewers read. Plain Maestro also works, flow by flow:
`maestro --device <id> test -e APP_ID=<id> -e PLATFORM=android -e ENVIRONMENT=staging flows/<feature>/<flow>.yaml`.
For several devices run one command per device with `--device <id>`; suites and platform configuration stay separate from parallelism.

## Reading a run

`reports/<runId>/report.html` (or `summary.md`): per-flow result, failure category (**application**, **automation**, **device**,
**environment**; low-confidence ones say "confirm"), device and app facts, the screenshot of a failure and links to the evidence in
`artifacts/<runId>/<flow>/`. A run on an emulator says so on its first line and never counts as physical-device validation.
