# Configuration

TeXRA uses its own settings system across the VS Code extension, desktop app,
and command-line interface. Configure TeXRA in its own Settings view or the
CLI's settings; TeXRA does not contribute product settings to VS Code's Settings editor.

## Open TeXRA settings

- **VS Code extension:** select the gear (**Settings**) in the TeXRA panel
  header, or run **TeXRA: Open Settings** from the Command Palette.
- **Desktop app:** open **Settings**.
- **CLI:** run `texra config`, or enter `/config` during a chat.

Settings has six pages, along its top row in VS Code and in a sidebar in the
desktop app. A page with more than one
section shows a second row of sub-tabs, and each sub-tab shows one section.
The page remembers the sub-tab you last opened while Settings stays open.

- **Models**: **API keys** (including Kimi Code and the GLM Coding Plan),
  **Subscriptions** (ChatGPT and Grok sign-in), and
  **Models** (which models appear, and the helper model).
- **Agents**: **Skills**, and **Advanced** (compaction, retries, and
  multi-agent coordination).
- **Memory**: the notes TeXRA keeps across tasks.
- **Plugins**: everything that adds tools or programs: TeXRA's plugins (such
  as Codex, Claude Code, Zotero, and GitHub), installed Claude Code and Codex
  plugins, and your MCP servers. Each plugin can be switched on or off.
- **LaTeX**: **Dependencies**, **Compile & diff**, **Formatting**, and, in VS
  Code, the recommended **VS Code settings**.
- **General**: **Appearance** (desktop app only), **Approval** (the approval
  policy, working-directory protection, and the goal spend cap), **Privacy**
  (telemetry), and **Git** (the GitHub token and Git commit attribution).

Commands such as **TeXRA: Agent Settings** or **TeXRA: Git Settings**
open their page on the matching sub-tab.

Settings that benefit from an ordinary control appear directly in these views.
A few settings with no control, such as the maximum image size and the debug
switches, keep their defaults unless you set them in `config.json`. File-handling rules and other internal
implementation constants are not exposed as configuration.

## Where settings live

For an open project, all three hosts read:

```text
<project>/.texra/config.json
```

User-wide values are stored in:

```text
~/.texra/v1/global-storage/config.json
```

Project values override user-wide values. Explicit command-line flags and
environment variables override saved values when a command documents such an
override. If the project directory is read-only, saving a project setting
fails with an error; if `.texra/config.json` cannot be read (for example,
malformed JSON), the host warns and ignores the file until it is fixed.

Configuration files are ordinary JSON and store only workspace and user settings.
Persistent application state—session history, execution records, and run events—is
stored separately in a local SQLite database (`texra.project-v1.db`) in workspace storage.
TeXRA 1.0 initializes fresh application state and does not import or migrate
legacy JSON session stores, histories, execution checkpoints, or old values from
`.vscode/settings.json`.

The JSON files use flat `texra.*` keys. For example:

```json
{
  "texra.skills.enabled": true,
  "texra.telemetry.enabled": false,
  "texra.model.retry.maxAttempts": 2
}
```

Prefer the settings views for ordinary changes: they validate values and place
them at the intended project or user scope.

The approval policy is the main exception to the project scope: a project
file can be supplied by a repository you clone, so TeXRA never reads it from
there. It is kept per workspace in your own storage, and a value in your user
file applies to every workspace. The goal spend cap and the user-wide provider
switches (such as OpenAI fast mode) are likewise read only from your user
file. A project file that sets any of these is ignored with a warning naming
the key.
Usage logging (`texra.telemetry.enabled`) follows the same rule with one
exception: a project file may switch it off but never on, so a `false` there
is honored and a `true` is ignored with the same warning.

## Model access and credentials

The **Models** page is the single home for model access: provider API keys,
provider behavior, subscription sign-in (ChatGPT and Grok), and model
visibility. Kimi Code and the GLM Coding Plan use API keys, so they sit on
their provider rows with their usage meters. There is no TeXRA account; everything ships
bundled.

Saved provider keys and subscription tokens live in `~/.texra/secrets/` (an
owner-only folder shared across the extension, desktop app, and CLI), never in
the JSON configuration files. Environment-variable keys are available to any
TeXRA host launched with that environment.

## Project instructions (AGENTS.md)

Put standing instructions for a project, such as spelling conventions,
notation, or how to build the paper, in an `AGENTS.md` file at the workspace
root. The assistant adds it to its instructions in every conversation. When the workspace has no
`AGENTS.md`, TeXRA uses `~/.texra/AGENTS.md` instead. It is the same file
Codex and other coding agents read, so one file serves all of them. TeXRA
reads no other instructions file name; an old `.texrarules` file is ignored,
so rename it to `AGENTS.md`.

The whole file goes into every prompt, so keep it short.

## Skills, tools, and privacy

The **Plugins** page controls which plugins, and so which tools, the
assistant can use; approval controls are under **General → Approval**; the skills switch is
on the **Agents** page. The CLI exposes the same skills switch from `/config` during a chat.
A plugin switched off adds no tools, programs or instructions to any
conversation.

The **General** page contains the telemetry switch. The environment
variables `TEXRA_NO_TELEMETRY=1` and `DO_NOT_TRACK=1` also disable telemetry.

### Usage logging

When telemetry is enabled, TeXRA records the model name, the provider API it
was called through, the billing route (API key or subscription), token
counts, the cost at list prices, response time, the time of the call, the
task identifier, version, and host. A call made by a program TeXRA ships also
carries that program's name, and a draft polish in the composer carries
`polish`. A chat sends no name, and neither does a program from an installed
plugin or one the assistant wrote, so a name you or a plugin wrote is never
sent. No account is
involved: each install sends a random anonymous install ID (a UUID made the
first time logging is on) in the `X-TeXRA-Install-Id` request header. It does
not send prompt text, document content, file paths, or error text. The first
TeXRA host you run with telemetry on tells you this once; the others share
that record and stay quiet. Turning telemetry off stops all usage
reporting and the ID is not created.

The CLI, the extension, and the desktop app share one install ID. It lives in
the global settings database, `~/.texra/v1/global-storage/texra.db`. To reset
it, quit every TeXRA host and run:

```bash
sqlite3 ~/.texra/v1/global-storage/texra.db \
  "DELETE FROM current_value WHERE family = 'app-state' AND key = 'texra.telemetry.installId'"
```

A new ID is made on the next send.

## Goal mode

A goal is a script that runs the assistant in rounds until an objective is met.

**How each round works:**

- By default, each round forks from the conversation as it stood when the goal started, receives the objective and the previous round's report, works with the assistant's tools, and submits a verdict: `done`, `keep going`, or `needs you`.
- A round's `done` is treated as a claim, not proof. TeXRA launches a fresh judge (with no prior conversation) that independently checks every requirement of the objective using tools.
- The judge marks each requirement `verified`, `failed`, or `unverified`, along with a reproducible check and its result.
- If no requirement fails, the goal completes. Otherwise, the next round receives the judge's findings and continues.
- A goal stops when it completes, when a round needs you, when a round or judge fails or returns no verdict, or when the spend cap is reached. Its final summary reports the stop reason, the last round's report, and the judge's claims—review any `unverified` or `failed` claims yourself. Each judge counts toward the goal's spend.

**Starting and steering a goal:**

Approve a plan with **Run as goal** (press `r` in the terminal) to run it as a background script of the conversation. It auto-approves shell commands inside the goal (or all agent work, if you choose that), while leaving the conversation's own approval settings unchanged. When the goal finishes, it delivers its outcome (`completed`, or `paused` with the reason, round count, spend, and judge claims) back into the conversation. The built-in script module is `builtIn:goal` (which also exports `judge`), so custom scripts can call it directly or implement their own loop with [`self()`](./multi-agent-workflows.md).

**Spend cap and duration limits:**

Because a goal on your own API key has no natural stopping point, it carries a user-wide spend cap (`texra.goal.maxCostUsd`, under **General → Approval** and in `/config`; default `$5`, never read from a project `.texra/config.json`, `0` disables the cap). It counts every round—including failed rounds, judge runs, and child agents—and is checked after each round, so one long round can overshoot it. When hit, the goal pauses and says why; raise the cap and run it again to continue. There is no round limit, and each run has a 24-hour wall-clock limit (resuming starts a fresh 24 hours).

## File discovery

TeXRA uses built-in file extensions and exclusions when discovering inputs,
context, edited files, and media. Discovery has no settings of its own.

## LaTeX configuration

The **LaTeX** view contains the settings that remain useful to change:

- compile and diff behavior (auto-compile, opening the PDF, repairing failed
  compiles, only changed pages in diff PDFs, math markup in diffs, and diffs
  between consecutive revisions);
- formatter selection; and
- inline criticism display (VS Code only).

The replacement engine's rule groups and custom maps are not shown there. Set
them in `.texra/config.json` under `texra.latex.enabledReplacements`,
`texra.latex.enabledReplacementsRegex`, `texra.latex.customReplacements` and
`texra.latex.customReplacementsRegex`. The auto-compile and latexdiff timeouts
are edited from the CLI's `/config`.

The latexdiff picture-environment pattern is a fixed product rule rather than a
user setting.

Some rows recommend settings owned by VS Code or another extension, such as an
Explorer exclusion. Those rows are explicitly labeled and are separate from
TeXRA's native configuration.

## Per-task settings (webview interface)

Per-run controls in the task composer affect only the task being launched: the
model, the approval policy and attached media. Persistent choices belong in
Settings instead.

## Debugging

Save model requests and responses only while diagnosing a run. The option has
no row in Settings; set its key in a `config.json`:

```json
{
  "texra.debug.saveModelIO": true
}
```

It saves request messages, raw responses, and the final input prompt alongside
the execution's debug artifacts. These files can contain sensitive material;
turn the option off after the investigation.

## Troubleshooting

1. Open the relevant native settings view and confirm the displayed value.
2. Run `texra config show` in a project to inspect the CLI's resolved configuration.
3. Check `<project>/.texra/config.json` for a project override.
4. Check `~/.texra/v1/global-storage/config.json` for a user-wide value.
5. Remove a saved key to return that setting to its current default.

For feature-specific guidance, read [Models](./models.md),
[LaTeX tools](./latex-tools.md), [Agent integrations](./agent-integrations.md),
and [Memory](./memory.md).
