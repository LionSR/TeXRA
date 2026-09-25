# Configuration

TeXRA uses its own settings system across the VS Code extension, desktop app,
and command-line interface. Configure TeXRA in its Dashboard or CLI settings
view; TeXRA does not contribute product settings to VS Code's Settings editor.

## Open TeXRA settings

- **VS Code extension:** run **TeXRA: Open Settings** from the
  Command Palette.
- **Desktop app:** open **Settings**.
- **CLI:** run `texra config`, or enter `/config` during a chat.

The Dashboard has six pages along its top row. A page with more than one
section shows a second row of sub-tabs, and each sub-tab shows one section.
The page remembers the sub-tab you last opened while the Dashboard stays open.

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
- **General**: **Account** (TeXRA sign-in and telemetry) and **Git** (the
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
~/.texra/global-storage/config.json
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
  "texra.toolUse.requireEditApproval": true,
  "texra.model.retry.maxAttempts": 2
}
```

Prefer the settings views for ordinary changes: they validate values and place
them at the intended project or user scope.

## Model access and credentials

The **Models** page is the single home for model access: provider API keys,
provider behavior, subscription sign-in (ChatGPT, Grok, and Copilot), and model
visibility. Kimi Code and the GLM Coding Plan use API keys, so they sit on
their provider rows with their usage meters. TeXRA account sign-in is on the
**General** page. It unlocks the hosted research-agent catalog and does not
supply model access.

Saved provider keys currently use each host's secure credential mechanism. They
are not copied through the shared JSON configuration. Environment-variable keys
are available to any TeXRA host launched with that environment.

## Skills, tools, and privacy

The **Tools** page contains tool availability and approval controls; the skills
switch is on the **Agents** page. The CLI exposes the same skills switch from `/config` during a chat.
Tools that are disabled globally are removed from an agent's available
tool list even when its definition names them.

The **General** page contains the telemetry switch. The environment
variables `TEXRA_NO_TELEMETRY=1` and `DO_NOT_TRACK=1` also disable telemetry.

### Usage logging

When telemetry is enabled and you are signed in, TeXRA records model and
provider names, agent category, token counts, cost, response time, route,
stream identifier, version, and host. It does not send prompt text, document
content, or file names. Turning telemetry off stops reporting for runs billed
through your own provider key.

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
Persistent agent visibility and team selection belong in the Dashboard instead.

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
4. Check `~/.texra/global-storage/config.json` for a user-wide value.
5. Remove a saved key to return that setting to its current default.

For feature-specific guidance, read [Models](./models.md),
[LaTeX tools](./latex-tools.md), [Agent integrations](./agent-integrations.md),
and [Memory](./memory.md).
