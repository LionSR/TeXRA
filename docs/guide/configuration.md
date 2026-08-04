# Configuration

TeXRA uses its own settings system across the VS Code extension, desktop app,
and command-line interface. Configure TeXRA in its Dashboard or CLI settings
view; TeXRA does not contribute product settings to VS Code's Settings editor.

## Open TeXRA settings

- **VS Code extension:** run **TeXRA: Show Settings Dashboard** from the
  Command Palette.
- **Desktop app:** open **Settings**.
- **CLI:** choose **Settings** in the launcher, run `texra config`, or enter
  `/config` during a chat.

The Dashboard groups the current controls by subject:

- **Account** — sign-in status, included usage, telemetry, and subscription
  access (ChatGPT, Kimi Code, and Copilot).
- **Models** — access mode, provider keys, and model visibility.
- **Agents** — available agents, active teams, orchestration, and session
  reliability.
- **Capabilities** — tool availability, permissions, skills, connected coding
  agents, and LaTeX processing.
- **Workspace** — Git behavior and shortcuts.
- **Data & Activity** — history, memory, and autonomous goals.

Settings that benefit from an ordinary control appear directly in these views.
File-handling rules and other internal implementation constants are not exposed
as configuration.

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
override. If a host cannot write the project directory, it uses an internal
workspace store so that its settings view remains usable; that fallback is not
shared with the other hosts.

New releases begin with the current defaults. TeXRA does not import old values
from `.vscode/settings.json`.

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

The **Providers & Models** view is the single home for model access, provider
API keys, provider behavior, model visibility, and retry settings. Account
connections that stand in for a provider key live in the **Account** group:
Researcher Access sign-in under **Account & Usage**, and the ChatGPT, Kimi
Code, and Copilot subscriptions under **Subscriptions**. Included-usage data
remains visible whenever the signed-in account has usage data, regardless of
the currently selected access mode.

Saved provider keys currently use each host's secure credential mechanism. They
are not copied through the shared JSON configuration. Environment-variable keys
are available to any TeXRA host launched with that environment.

## Skills, tools, and privacy

The **Tools** view contains the skills switch, tool availability, and approval
controls. The CLI exposes the same skills switch from its launcher and settings
view. Tools that are disabled globally are removed from an agent's available
tool list even when its definition names them.

The **Account & usage** view contains the telemetry switch. The environment
variables `TEXRA_NO_TELEMETRY=1` and `DO_NOT_TRACK=1` also disable telemetry.

### Usage logging

When telemetry is enabled and the user is signed in, TeXRA records model and
provider names, agent category, token counts, cost, response time, route,
stream identifier, version, and host. It does not send prompt text, document
content, or file names. Turning telemetry off stops reporting for runs billed
through the user's own provider key. Included-access usage is still metered by
the hosted service.

## File discovery

TeXRA uses built-in file extensions and exclusions when discovering inputs,
context, edited files, and media. The former `texra.files.included.*` and
`texra.files.ignored.*` settings have been removed; saved values for those keys
no longer affect discovery.

## LaTeX configuration

The **LaTeX** view contains the settings that remain useful to change:

- inline criticism display;
- compile and diff behavior;
- formatter selection; and
- direct, regular-expression, and custom replacement rules.

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

See [Models](./models.md), [LaTeX tools](./latex-tools.md),
[Agent integrations](./agent-integrations.md), and [Memory](./memory.md) for
feature-specific guidance.
