# Responsibility audit: what the 2026-11-26 run left open

Date: 2026-11-26
Status: proposed
Origin: the scheduled audit for confused or overlapping responsibilities,
on `main` at `7538e2e`. It started from the open items of
[`2026-11-25-responsibility-audit-left-open.md`](2026-11-25-responsibility-audit-left-open.md)
and two read-only comparisons: the desktop and the trace viewer against the
shared UI and harness helpers, and the app's subtrees against the harness
and each other. Two open PRs (#15229, #15230) still rewrite about 430 files,
so a finding whose fix edits one of them was left for after they merge.

The PR that adds this note lands nine findings, one commit each: the
terminal's list of editor tools (item 2 of the 2026-11-25 note), the
terminal's "no model can run" and "unknown model" sentences (its item 4),
the model of a chat opened on a stored run (item 1 of the 2026-11-21 note),
the path a `file:` URL names, the site host in the desktop's link policy,
the UTC-to-the-second time format, the folder an arXiv paper lands in, the
usage log's retry backoff, and the LaTeX extensions in the extension's
guard message. Item 6 of the 2026-11-25 note (the OpenAI ambient-header
rejection) had already landed as `refuseAmbientOpenAiHeaders`.

## Open

1. **Which shell is "the user's shell" has three answers.** The desktop
   terminal (`defaultShell`, `packages/desktop/src/main/desktopPtyHost.ts`)
   takes `$SHELL`, then on Windows `COMSPEC` or `powershell.exe`, then
   `/bin/bash`. The system prompt (`detectShell`,
   `packages/harness/src/agent/prompt/workspaceInfo.ts`) reads `ComSpec` on
   Windows and ignores `SHELL` there. The login-shell environment read
   (`packages/texra/src/platform/defaults/loginShellEnvironment.ts`) takes
   the account's shell from `userInfo()`, then `/bin/sh`. A desktop app
   started by launchd has no `$SHELL`, so its terminal opens bash for a
   person whose account shell is zsh, while the environment it runs with
   was read from zsh. On Windows with Git Bash the terminal opens bash and
   the model is told `cmd` or `PowerShell`. Proposed: one `userShell`
   effect beside `envVar`
   (`packages/harness/src/utils/system/envFlags.ts`): `$SHELL`, then the
   account's shell, then the platform's fallback; `detectShell` keeps only
   its name-to-label table. Decision: what the prompt names on Windows,
   which depends on the shell the `bash` tool starts there, and that needs
   a Windows machine to check. The setup probe
   (`packages/texra/src/tools/setup/ProbeEnvironmentTool.ts`) is a fourth
   reader in a file #15229 edits.
2. **Which image types a model takes** (item 3 of the 2026-11-25 note) is
   wider than one set. The harness treats any `image/*` as an image part
   and never converts one (`resizeImageIfNeeded`,
   `packages/harness/src/agent/runtime/run/img.ts`, keeps the format). The
   Responses and Anthropic codecs take PNG, JPEG, WEBP and GIF
   (`ImageMimeTypeSchema`, `packages/llm/src/api/parts.ts`); the Google
   codec passes any type on. `read_file` says it attaches an SVG "so
   vision-capable models can inspect its rendered appearance"
   (`packages/harness/src/tools/ReadTool.ts`), which no codec does: the
   turn fails as `invalid-request`. Decision: the harness offers as an
   image only what every protocol takes (an SVG then reads as text), or
   llm answers per bound protocol, or the harness converts with the image
   tool it already finds for resizing.
3. **The desktop log file's line has a writer type and a reader schema.**
   The main process writes `JSON.stringify` of the harness `LogEntry`
   (`packages/desktop/src/main/desktopAppLog.ts`); the renderer declares
   the same seven fields again (`DesktopLogLineSchema`,
   `packages/desktop/src/renderer/logsPane.ts`) and its own list of the
   levels. The level table is also written in each direction: `ENTRY_LEVEL`
   (`packages/harness/src/logger/logSink.ts`) from severity to entry level,
   `ENTRY_LOG_LEVEL` (`packages/cli/src/runtime/platform/logSinks.ts`) back.
   Proposed: a `LogEntrySchema` beside `LogEntry`, whose type `LogEntry`
   becomes, and an `entrySeverity` reader. `LogEntry` is derived today from
   Effect's structured formatter, so the schema would restate that shape:
   compare the two before choosing.
4. **`texra init` spells two setting keys and writes the file itself.**
   `buildInitConfig` (`packages/cli/src/runtime/platform/initConfig.ts`)
   writes `texra.model` and `texra.outputFormat` as literals beside
   `CLI_MODEL_SETTING` and `CLI_OUTPUT_FORMAT_SETTING`, and
   `writeInitConfig` replaces the whole file, while `packages/cli/src/commands/init.ts`
   says the command writes through the stores it opened. Writing through
   `Settings.set` would merge into an existing file instead of replacing
   it, and the written object is part of the command's JSON result.
   Decision: whether `--force` replaces or merges.
5. **The exported trace page's inline document is named on both ends.**
   `packages/texra/src/agent/export/standaloneTraceHtml.ts` writes
   `window.__TEXRA_TRACE__` and `packages/trace-viewer/src/traceHostBridge.ts`
   declares and reads it; a rename on one side breaks every exported page
   with no compile error. A `declare global` cannot take a constant's
   name, so the fix is the writer emitting a typed element the viewer
   reads (`<script type="application/json" id=…>`) with the id shared.
   That changes the exported page.
6. **The reported model source after a fallback** (item 2 of the
   2026-11-21 note) is still the first candidate's reason:
   `selectCliRunnableModel` returns the model and a notice, not the reason
   the decision landed on.
7. **Two helpers the app restates because the harness does not export
   them.** The workspace walk's tolerant symlink read
   (`packages/texra/src/common/files/workspaceFileListing.ts`) restates
   `listedEntryGone`; the VS Code terminal runner
   (`packages/extension/src/frontend/setupTerminalRunner.ts`) caps its
   output with `slice(-N)`, which can cut a surrogate pair and cuts before
   the control sequences are stripped, where the harness has `appendTail`.
   Both exports go in entry files #15229 edits.
8. Items 1 and 5 of the 2026-11-25 note (a sign-in prompt that cannot be
   shown; which finished run each GUI host announces) are unchanged.

## Checked and declined

- **`defaultShell` against the login-shell read as one function now.**
  The POSIX half could land alone, but the two would still disagree on
  Windows; one change with the decision in item 1.
- **The desktop's console-level table** (`ENTRY_LEVEL`,
  `desktopAppLog.ts`) maps console methods to entry levels, a different
  fact from the severity table.
- **llm's own error-message helpers.** llm cannot import the harness.
