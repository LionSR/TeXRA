# Configuration

TeXRA uses its own settings system across the VS Code extension, desktop app,
and command-line interface. Configure TeXRA in its own Settings view or the
CLI's settings; TeXRA does not contribute product settings to VS Code's Settings editor.

## Open TeXRA settings

- **VS Code extension:** select the gear (**Settings**) in the TeXRA panel
  header, or run **TeXRA: Open Settings** from the Command Palette.
- **Desktop app:** open **Settings**.
- **CLI:** run `texra config`, or enter `/config` during a chat.

Settings has six pages along its top row. A page with more than one
section shows a second row of sub-tabs, and each sub-tab shows one section.
The page remembers the sub-tab you last opened while Settings stays open.

- **Models**: **API keys** (including Kimi Code and the GLM Coding Plan),
  **Subscriptions** (ChatGPT and Grok sign-in, Copilot in VS Code), and
  **Models** (which models appear, and the helper model).
- **Agents**: the agent **Library**, **Teams**, **Skills**, and **Advanced**
  (compaction, retries, and team coordination).
- **Tools**: **Approval** policy, **Tools** and their availability, and
  **Integrations** such as Codex, Claude Code, Zotero, and GitHub activity.
- **LaTeX**: **Dependencies**, **Compile & diff**, **Formatting**, and, in VS
  Code, the recommended **VS Code settings**.
- **Memory**: the notes TeXRA keeps across tasks.
- **General**: **Privacy** (telemetry) and **Git** (the
  GitHub token and Git commit attribution).

The desktop app adds a **Shortcuts** page. Commands such as **TeXRA: Agent
Team Settings** or **TeXRA: Git Settings** open their page on the matching
sub-tab.

Settings that benefit from an ordinary control appear directly in these views.
Provider transport knobs (OpenAI background responses, parallel tool calls, the
GPT-5 reasoning summary, and Google background responses) keep their defaults
unless you set them in `config.json`. File-handling rules and other internal
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

Configuration files are ordinary JSON. Persistent application state—including
session history, execution records, and run events—is stored separately in an
authoritative local SQLite database (`texra.db`) in workspace storage.
TeXRA 1.0 initializes fresh application state and does not import legacy JSON
session stores or execution checkpoints.

New releases begin with the current defaults. TeXRA does not import old values
from `.vscode/settings.json`.

SQLite is the authoritative store for persistent runtime application state
(`texra.db` under workspace storage: sessions, executions, and run events). The
JSON files described here are used strictly for workspace and user settings.
TeXRA 1.0 does not import or migrate legacy JSON session stores, histories, or
execution checkpoints.

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

Approval settings (the approval policy and the two approval switches) are the
exception to the project scope: a project file can be supplied by a repository
you clone, so TeXRA never reads them from it. They are kept per workspace in
your own storage, and a value in your user file applies to every workspace. A
project file that sets one is ignored with a warning naming the key.
Usage logging (`texra.telemetry.enabled`) follows the same rule with one
exception: a project file may switch it off but never on, so a `false` there
is honoured and a `true` is ignored with the same warning.

## Model access and credentials

The **Models** page is the single home for model access: provider API keys,
provider behavior, subscription sign-in (ChatGPT, Grok, and Copilot), and model
visibility. Kimi Code and the GLM Coding Plan use API keys, so they sit on
their provider rows with their usage meters. There is no TeXRA account; every
agent ships bundled.

Saved provider keys currently use each host's secure credential mechanism. They
are not copied through the shared JSON configuration. Environment-variable keys
are available to any TeXRA host launched with that environment.

## Project instructions (AGENTS.md)

Put standing instructions for a project, such as spelling conventions,
notation, or how to build the paper, in an `AGENTS.md` file at the workspace
root. Every agent adds it to its system prompt. When the workspace has no
`AGENTS.md`, TeXRA uses `~/.texra/AGENTS.md` instead. It is the same file
Codex and other coding agents read, so one file serves all of them. TeXRA
reads no other instructions file name; an old `.texrarules` file is ignored,
so rename it to `AGENTS.md`.

The whole file goes into every prompt, so keep it short.

## Skills, tools, and privacy

The **Tools** page contains tool availability and approval controls; the skills
switch is on the **Agents** page. The CLI exposes the same skills switch from `/config` during a chat.
Tools that are disabled globally are removed from an agent's available
tool list even when its definition names them.

The **General** page contains the telemetry switch. The environment
variables `TEXRA_NO_TELEMETRY=1` and `DO_NOT_TRACK=1` also disable telemetry.

### Usage logging

When telemetry is enabled, TeXRA records model and provider names, the agent
name and category, token counts, response time, route, stream identifier,
version, and host. Only a bundled agent's id is sent; a custom or plugin
agent is reported as `custom`. No account is
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

Approving a plan with **Run as goal** (press `r` in the terminal) lets the
agent keep working turn after turn, and auto-approves shell commands (or all
agent work, if you chose that) until it verifies the objective or needs you.
On your own API key that has no natural end, so goal mode carries a spend
cap: `texra.goal.maxCostUsd`, on the **Tools** page and in `/config`,
defaults to $5 and is always a user-wide setting, never read from a project
`.texra/config.json`. It counts everything the run and its subagents have spent,
including turns before the goal started. When the total reaches the cap at
the end of a turn, the goal pauses, auto-approval is withdrawn, and the
transcript says why. Raise the cap and re-arm the goal to continue; `0`
removes the cap. The cap is checked between turns, so a single long turn can
overshoot it. Goal mode has no time or turn limit.

## File discovery

TeXRA uses built-in file extensions and exclusions when discovering inputs,
context, edited files, and media. Discovery has no settings of its own.

## LaTeX configuration

The **LaTeX** view contains the settings that remain useful to change:

- compile and diff behavior (auto-compile, opening the PDF, repairing failed
  compiles, only changed pages in diff PDFs, math markup in diffs, and diffs
  between rounds);
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

## Agent execution settings (webview interface)

Per-run controls in the task composer affect only the task being launched. They
include attached files and optional context helpers such as TeX count.
Persistent agent visibility and team selection belong in Settings instead.

## Debugging

Enable **Save model I/O** only while diagnosing a run. Its current key is:

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
2. Run `texra doctor` in a project to inspect the CLI's resolved configuration.
3. Check `<project>/.texra/config.json` for a project override.
4. Check `~/.texra/v1/global-storage/config.json` for a user-wide value.
5. Remove a saved key to return that setting to its current default.

For feature-specific guidance, read [Models](./models.md),
[LaTeX tools](./latex-tools.md), [Agent integrations](./agent-integrations.md),
and [Memory](./memory.md).
