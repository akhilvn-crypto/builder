---
name: maestro-setup
description: Preflight for Maestro mobile automation — detecting Maestro, Java, Flutter, Android SDK/adb and Xcode, reading what the installed Maestro CLI supports, asking before installing anything, finding and verifying real physical devices, installing the app build on a device, and the rules for claiming physical-device validation. Use when checking prerequisites or devices for the mobile framework.
user-invocable: false
---

# Maestro setup, devices and physical-device validation

CLI: `MCLI` = `node mobile-automation/tools/maestro-cli.mjs …` (project copy) or `PCLI` = `node "${CLAUDE_PLUGIN_ROOT}/template/mobile/tools/maestro-cli.mjs" … --root "<root>"`
before the project is scaffolded. JSON on stdout; exit 0 ok, 2 something is missing (`needsInput` / `missing` / `issues`), 1 error.
Asking the user: [../playwright-pipeline/environment.md](../playwright-pipeline/environment.md).

## 1. Preflight (read-only)

`preflight --platform android|ios` reports, for each tool: status (`ok`, `missing`, `warning`, `unsupported`), version, location,
whether it is required for the chosen platforms, what it is for, and an install hint. It installs nothing.

| Tool | Needed for | Required when |
|---|---|---|
| Node 18+ | this tooling | always |
| Maestro CLI | running the YAML flows | always |
| Java 17+ | Maestro is a Java application | always |
| Android platform-tools (`adb`) | detecting Android devices, installing and inspecting the app | Android in scope |
| Xcode (+ command-line tools) | iOS devices/simulators — **macOS only** | iOS in scope |
| Flutter SDK | building the app (`flutter build …`); not needed to run flows against an installed build | optional |

`capabilities` is read from the installed Maestro's own `--help`, never inferred from its version: the device selector (`--device` /
`--udid`, root or `test` level), `--debug-output`, `--test-output-dir`, `--format`, `--include-tags`/`--exclude-tags`, `-e`, and the
sub-commands `hierarchy`, `check-syntax`, `studio`. Execution uses only what is listed. Do not assume Playwright-style tag filtering:
suites are selected by this tooling from the flow headers (`tests/*.yaml`), and Maestro's own `--include-tags` is an extra when present.

## 2. Missing prerequisites: explain, ask, then act exactly as approved

For each `missing` (or `warning`) item, **one at a time**:

1. Say what it is, why this project needs it, and what installing it changes on the machine (files, PATH).
2. Offer the choices as a dialog / numbered question: *Install it for me (Recommended)* / *I'll install it myself* / *Skip it*.
   Changing the user's PATH or other global configuration is a separate yes; when in doubt let the user do that step and tell them the line.
3. On a yes, run only the approved commands (for Maestro on macOS/Linux: `curl -fsSL "https://get.maestro.mobile.dev" | bash` or the
   Homebrew formula; on Windows download `maestro.zip` from the official GitHub releases, extract it, and the user adds its `bin` to PATH).
   Read a downloaded script/archive's source before running it. If a command needs an elevated prompt, give it to the user to run
   (`! <command>` in the Claude Code prompt) rather than attempting it.
4. `preflight` again to prove it. Record: `setup record --tool <id> --action installed|declined|present --command "<what ran>" --version <v>`.
5. A declined required tool stops the flow as `blocked`. Say what still works (writing and validating flows needs no device or Maestro).

Never install Android Studio, SDK images, emulators, certificates, provisioning profiles or signing configuration on your own.

## 3. Physical device

The framework is validated only on a **real phone** for each platform in scope. An emulator/simulator can help you work, but a run
on one is labelled so, and never satisfies validation.

### Android
`devices --platform android` lists every device with `state`, `kind` (`physical` / `emulator`), `transport` (`usb`, `wifi`), model, manufacturer, Android version.

- `device` + `physical` → candidate. Several → ask which; never pick.
- `unauthorized` / `offline` / `no permissions` → the device carries its own `fix` steps; relay them as they are. Typical: unlock the phone,
  accept "Allow USB debugging?" (tick "Always allow"), or revoke authorisations and reconnect, then `adb kill-server && adb start-server`.
- Nothing connected → the reply carries `connectSteps` (Developer options, USB debugging, a data cable, the prompt, Windows USB driver).
  Show them verbatim, stop the physical-device stage, and do not touch the phone's settings yourself.

### iOS (only when in scope)
Possible only on a Mac with Xcode: device trust ("Trust This Computer"), **Developer Mode** on the phone, and a build signed with a
profile that includes the device. `devices --platform ios` lists physical devices from `xcrun xctrace`; `developerMode` appears when
`devicectl` can report it. On Windows/Linux the reply says `supported: false` with the blocker: tell the user it cannot be validated
on this host and leave it **not validated**. Do not change signing, provisioning or certificates without approval, and never claim iOS
physical-device validation unless a smoke flow actually passed on the iPhone. Whether the installed Maestro can drive a physical
iPhone is answered by `device verify` (it must read the screen), not assumed.

### Verify, then install
`device verify --platform p [--device id]` proves: detected, authorised, **Maestro can read the screen** (`maestro hierarchy`), and the
**application is installed** (Android `pm list packages`; iOS via `devicectl`). Being listed is not enough. For an app that is not installed:
show the artifact (config `platforms.<p>.artifact` or the builds from `discover`), the device and the app ID, ask, and only on a yes:
`app install --platform p --device id --artifact <path> --approved`. An AAB cannot be installed directly; ask for an APK. Building the
artifact (`flutter build apk --debug [--flavor x]`) is also something to offer, not to run unasked.

## 4. Claiming validation

`validation status` is the only source. `physicalDeviceValidated: true` needs a run on a physical device in which at least one flow tagged
`smoke` passed (recorded in `state/device-validation.json` with the device, OS, app build, Maestro version and run id). Say "validated" only
then. Otherwise say what is missing: no device, no smoke flow, emulator only, iOS host unsupported.

## 5. Record what was verified

`setup record --verified` stores tool versions and Maestro capabilities in `state/setup.json` (git-ignored, per machine); decisions made
with `setup record --tool …` are listed there too. Commands the user ran or you ran on their behalf belong in the summary.
