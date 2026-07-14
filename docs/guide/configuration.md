# Configuration

<script setup>
import DashboardTabsCard from '../.vitepress/components/DashboardTabsCard.vue';
import InstructionHeaderCard from '../.vitepress/components/InstructionHeaderCard.vue';
import AgentOutputToolbarCard from '../.vitepress/components/AgentOutputToolbarCard.vue';
import GitTabCard from '../.vitepress/components/GitTabCard.vue';
import CliInitHero from '../.vitepress/components/CliInitHero.vue';
</script>

TeXRA provides extensive configuration options that allow you to customize its behavior to match your workflow (don't worry, the defaults are sensible!). This guide explains the available settings and how to adjust them for optimal performance.

::: tip CLI
This page describes the VS Code extension's Dashboard and settings. The same
setting names apply in the CLI, but they live in different places: the **CLI**
reads a per-project `.texra/config.json` (run `texra init` to scaffold one).
Run `texra config` for the unified interactive settings view; it is also
available from the launcher's **Settings** row and as `/config` in a chat.
Inspection and execution remain under `texra models`, `texra tools`,
`texra agents`, and `texra multi-agent`.
:::

## The TeXRA Dashboard

The **Dashboard** is your one-stop shop for managing everything in TeXRA. Open it from the Command Palette (`Ctrl+Shift+P`) with **TeXRA: Show Settings Dashboard**. Its ten tabs all live in one navigation rail:

<DashboardTabsCard />

<p class="hero-caption">The Dashboard navigation rail: ten tabs from Memory through Goal, each opening a focused configuration surface.</p>

- **[Memory](./memory.md)** - See what your tool-use agents have remembered across sessions, pin core insights, and delete entries you no longer need.
- **History** - Search and browse past runs. Handy for finding that polish job you ran last week.
- **Models** - Pick which models show up in your dropdown. Models are grouped by provider (Anthropic, OpenAI, Google, etc.) and you can set or remove API keys for each provider right there - no need to hunt through settings.
- **Agents** - Turn agents on or off for the current workspace. Agents that support multiple output files are marked with a badge.
- **Multi-Agent** - Configure multi-agent orchestration and presets.
- **Tools** - Manage tool-use agent capabilities and approval settings.
- **Integrations** - Set up third-party coding agents (OpenAI Codex, Claude Code) that TeXRA can hand off to. See [Agent Integrations](./agent-integrations.md).
- **Git** - Set a GitHub personal access token (required for the `github_subscription` tool) and optionally attribute TeXRA commits to a custom author.
- **LaTeX** - Configure LaTeX formatting, diff, and TikZ settings.
- **Goal** - Watch autonomous runs, where an agent keeps working toward a goal across turns until it reports the goal complete. On by default; this tab lists active and past Goals for observation and navigation.

::: tip
The Dashboard tabs are the recommended way to manage agents, models, tools, and connections. VS Code's raw settings (`texra.*` keys) still work for power users.
:::

## Where Settings Live

Most configuration happens in the **Dashboard** (above) — open it with `TeXRA: Show Settings Dashboard`. The CLI exposes the corresponding configuration view through `texra config`, the launcher, and `/config`; project command defaults remain in `.texra/config.json` (`texra init` scaffolds one).

Many `texra.*` keys share the same **name** across the VS Code extension and the CLI's `.texra/config.json` (most of the file-, LaTeX-, and model-connection settings below), so the same documentation applies to both. They don't share storage, though — the extension persists settings in VS Code's config/global state, while the CLI reads `.texra/config.json`. Some keys are extension-only (for example the LaTeX formatter and extension model visibility settings); the CLI warns on any key it doesn't recognize.

<CliInitHero />

<p class="hero-caption"><code>texra init</code> scaffolds the workspace file with sensible defaults, and <code>texra doctor</code> confirms exactly which config file a run will load — no guessing about what applies.</p>

VS Code's built-in Settings UI remains available for power users — open it with `Ctrl+,` (`Cmd+,` on macOS), search for "TeXRA", and edit in the UI or the JSON. It's no longer the primary path, so reach for the Dashboard or CLI config first.

## Core Configuration Options

### Agent Configuration

Agent visibility is managed through the **Agents** tab in the TeXRA Dashboard
(`TeXRA: Show Agents` from the Command Palette). The split-panel browser lets
you toggle individual agents on or off for the current workspace. Agents that
declare `defaultOutputFiles` (and so can produce more than one output file in a
single run) are flagged with a multi-output badge.

In the CLI, open `texra config` and choose **Agents**, or use
`texra config agents` non-interactively. The roster can inherit a user default,
show the complete catalog, use a named team, or contain an exact custom list.
These choices are host-local: changing the CLI roster does not silently rewrite
the VS Code extension's workspace state, and conversely.

### Model Configuration

Which models appear in the selection dropdown is managed through the **Models**
tab in the TeXRA Dashboard. Toggle individual models on or off per provider.
See the [Models Guide](./models.md) for the full list of supported models.

### API Provider Settings

Configure how TeXRA connects to AI model providers:

```json
"texra.model.useOpenAIResponsesAPI": true,
"texra.model.useGoogleInteractionsAPI": true,
"texra.model.gpt5ReasoningSummary": false
```

- **OpenRouter**: To route all API calls through OpenRouter, expand the OpenRouter row in the Dashboard → Models tab → API Configuration and enable **"Use OpenRouter for All Models"**
- `useOpenAIResponsesAPI`: Use OpenAI's Responses API instead of Chat Completions when available
- `useGoogleInteractionsAPI`: Use Google's Interactions API instead of Generate Content when available; enabled by default for direct Google models
- `gpt5ReasoningSummary`: Request reasoning summaries from the GPT-5 family, including GPT-5.5 and GPT-5.5 Pro (requires verified account and user tier)

### Anthropic 1M Context Window

Claude Fable 5, Opus 4.8, and Sonnet 4.6 include the full 1M context window at standard pricing. No opt-in setting or beta header is required — 1M context is enabled automatically. Up to 600 PDF pages per request are supported (100 for models with a 200K context window). Other Claude models use a 200K context window.

Fable 5 and Opus 4.8 use adaptive thinking only — manual thinking budgets are not supported (on Fable 5, thinking is always on). TeXRA selects the appropriate thinking mode automatically based on the reasoning-effort level you pick in the Models tab (Low / Medium / High / Extra High / Max). On Opus 4.8, **Extra High** maps to Anthropic's `xhigh` ("extra") effort tier and **Max** maps to the top `max` tier — both are recommended for difficult tasks and long-running work, with Max reserved for the hardest, longest-horizon runs. The earlier Opus 4.6/4.7 models predate the `xhigh`/`max` split and accept only `max`, so both Extra High and Max collapse onto `max` there.

### Bibliography Settings

Configure the default bibliography file path for Zotero exports and bibliography tools:

```json
"texra.bib.defaultPath": "${workspaceFolder}/references.bib"
```

When set, bibliography tools will use this path when no explicit file is provided. Works with Zotero auto-exported `.bib` files.

### Agent Output Storage

Workflow outputs always land inside task-run storage — each run gets its
own folder under `executions/{id}/`, with the primary revised file at
`r{round}/output.{ext}` and the merge output at `_full.{ext}`. Per-run
isolation keeps parallel runs from colliding, and the whole folder is
reachable from the progress-view toolbar:

- **Accept** — copy the revised file into your workspace (via the
  normal approval flow).
- **Pack** — snapshot the whole run (including mirrored `.bib`, `.cls`,
  `.sty`, and figure dependencies) into `workspace/History/`.
- **Clean** — discard the run's folder entirely.
- **Open in task storage** — reveal the folder so you can browse
  artifacts manually.

<AgentOutputToolbarCard />

<p class="hero-caption">The progress-view toolbar for one finished run: Accept, Pack, and Open in task storage, plus the destructive Clean, all acting on <code>executions/{id}/</code>.</p>

When a workflow completes, the final revised file auto-opens in a new
editor tab as a read-only preview so you don't feel the output
"vanished." Disable the preview with:

```json
"texra.agentOutputs.autoOpenFinal": false
```

The legacy `texra.agentOutputs.storageMode` setting is deprecated and
ignored — every workflow output now goes to task-run storage.

### Audio Settings

Specify a custom path to the [SoX](http://sox.sourceforge.net/) binary when automatic detection fails:

```json
"texra.audio.soxPath": "C:\\Users\\thinking\\scoop\\apps\\sox\\current\\sox.exe"
```

If unset, TeXRA searches common install locations and your `PATH`.

## File Management Configuration

### File Extensions

Control which file types TeXRA includes:

```json
"texra.files.included.inputExtensions": [
  ".txt",
  ".tex",
  ".md"
],
"texra.files.included.contextExtensions": [
  ".txt",
  ".tex",
  ".md",
  ".bbl"
],
"texra.files.included.mediaExtensions": [
  ".png",
  ".pdf",
  ".jpeg",
  ".jpg",
  ".svg",
],
```

### Ignored Directories

Control which directories TeXRA ignores:

```json
"texra.files.ignored.directories": [
  "build",
  "node_modules",
  "__pycache__",
  "figures",
  "figs",
  "versions",
  "history",
  "venv"
],
"texra.files.ignored.fileExtensions": [
  ".pdf",
  ".bst",
  ".bib",
  ".json",
  ".py",
  ".ipynb",
  ".png",
  ".vsix",
  ".ts",
  ".js"
],
"texra.files.ignored.inputFiles": [
  "command.tex",
  "preamble.tex"
],
"texra.files.ignored.keywords": [
  "Makefile",
  "template",
  "_log",
  "_thinking",
  "_diff",
  "diff",
  "draw",
  "versions",
  "history"
]
```

## LaTeX Configuration

### LaTeX Formatting

Pick the formatter (`latexindent`, `tex-fmt`, or `none` to disable) from the **Dashboard → LaTeX** tab. The related options are standard settings:

```json
"texra.latex.showLatexindentWarning": false,
"texra.latex.latexindentConfig": "/path/to/latexindent.yaml",
"texra.latex.texfmtConfig": "/path/to/tex-fmt.toml"
```

- `showLatexindentWarning`: Disabled by default. Set to `true` to show a popup when `latexindent` is missing.
- `latexindentConfig`: Path to a `latexindent` configuration file.
- `texfmtConfig`: Path to a `tex-fmt` configuration file.

### Workflow Compile Check

The **Dashboard → LaTeX** tab also controls what happens after a workflow agent writes `.tex` outputs:

- **Auto-compile after each round** (on by default): attempt to compile each root document (`latexmk`, falling back to `pdflatex`) in run storage, with a configurable timeout.
- **Open compiled PDF or log** (on by default): after auto-compile finishes, open the latest PDF on success or the truncated LaTeX log on failure.
- **Reject rounds when compile fails** (on by default): when the compile check fails, the workflow uses its next planned round to repair the output from the compile log instead of treating the round as done. Turn this off to keep failing rounds as-is.

### TikZ Figure Processing

Configure how TikZ figures are extracted and compiled:

```json
"texra.latex.tikzInputDirectory": "/path/to/tikz/inputs",
"texra.latex.includeWorkspaceInTexinputs": true,
"texra.latex.tikzTemplate": "\\documentclass[tikz,border=10pt]{standalone}\n\\usepackage{tikz}\n\\usepackage{pgfplots}\n\\usetikzlibrary{positioning}\n\\usetikzlibrary{patterns}\n\\usetikzlibrary{arrows.meta, shapes.geometric, matrix, calc, decorations.pathreplacing}\n\\usetikzlibrary{shapes, arrows}\n\n\\begin{document}\n{{ tikzpicture }}\n\\end{document}"
```

- `tikzInputDirectory`: Additional directories to include in the TEXINPUTS path when compiling TikZ figures
- `includeWorkspaceInTexinputs`: Whether to include the workspace root in TEXINPUTS
- `tikzTemplate`: The template used for generating standalone TikZ documents

## Git Integration

The **Git tab** in the TeXRA Dashboard (`TeXRA: Show Settings Dashboard` → **Git**) covers two independent features: a GitHub token used by the PR-subscription tool, and optional TeXRA-branded commit authorship for agent-made commits.

<GitTabCard />

<p class="hero-caption">The Git tab: the GitHub token row (here picked up from <code>GITHUB_TOKEN</code> or <code>GH_TOKEN</code>, shown as <strong>Env</strong>) with Create on GitHub and Set token, and the commit-author toggle.</p>

### GitHub personal access token

Several tool-use agents can call `github_subscription` to watch a repo, pull request, or issue and inject new comments, reviews, line comments, failed CI runs, and merge-conflict events into the current agent stream as follow-up messages — the same mechanism that handles user-typed follow-ups. The tool polls GitHub's REST API every 30 seconds and needs an authenticated token.

Setup:

1. In the Git tab, click **Create on GitHub…**. This opens the GitHub token-creation page with the TeXRA description and `repo` scope pre-filled.
2. Choose scopes:
   - `repo` if you want to watch private repositories.
   - `public_repo` if you only need public repositories.
   - No write scopes are required — the poller is read-only.
3. Pick an expiration (90 days is a common choice) and generate the token. GitHub shows it only once.
4. Back in TeXRA's Git tab, click **Set token** and paste it in.

The token is stored in VS Code's encrypted **Secret Storage** — never written to `settings.json`. Alternatively, export `GITHUB_TOKEN` or `GH_TOKEN` in the host environment and the tool will pick it up automatically (the Git tab will show **Env** as the status).

Once a token is configured, an agent can run `github_subscription command=subscribe path=owner/repo/pulls/N` (or `path=owner/repo` for the whole repo, `path=owner/repo/issues/N` for a single issue) and every new event arrives wrapped in a `<github-webhook-activity>` tag in the follow-up queue. Use `command=unsubscribe` with the same path to stop, `command=list` to see active subscriptions, and `command=find_current` to resolve the current branch's PR. Subscriptions auto-terminate when the PR closes or merges, and up to 25 PRs can be watched concurrently.

### TeXRA commit author

Enable **Mark commits with TeXRA author info** to attribute commits created by TeXRA agents to a distinct identity (useful when sharing a repo with collaborators so you can tell which commits were machine-made). When enabled, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, and `GIT_COMMITTER_EMAIL` are set for every git command an agent runs.

### LaTeX diff commit history

A separate setting controls how many recent commits appear in the LaTeX-diff commit picker:

```json
"texra.git.numberOfCommitsToShow": 20
```

## Custom Agents Directory

The custom agents directory can be changed from the **Agents** tab in the TeXRA
Dashboard. Click **Change** in the directory info bar to select a new folder, or
**Reset** to return to the default location inside global storage.

## Logger Configuration

Control logging behavior:

```json
"texra.logger.debugMode": false,
"texra.debug.saveDebugObjects": false,
"texra.debug.saveInputPrompt": false
```

- `debugMode`: Show detailed debug messages in the logger view
- `saveDebugObjects`: Save message and response objects to JSON files for debugging purposes (includes both API messages and raw responses)
- `saveInputPrompt`: Persist the final model input prompt as an XML file (stored alongside other debug artifacts when an execution ID is available)

## Environment-Specific Configuration

### Workspace vs. User Settings

You can configure TeXRA at different levels:

1. **User Settings**: Apply to all workspaces (the VS Code extension's user settings)
2. **Workspace Settings**: Apply only to the current workspace (`.vscode/settings.json`)
3. **CLI / project config**: A per-project `.texra/config.json` (run `texra init`) — the CLI's native project-level equivalent of workspace settings

For project-specific configurations in the VS Code extension, use workspace settings:

```json
// .vscode/settings.json
{
  "texra.files.included.inputExtensions": [".tex", ".md"],
  "texra.latex.tikzInputDirectory": "${workspaceFolder}/styles"
}
```

For personal preferences that apply to all projects, use user settings.

When several levels set the same option, the CLI resolves them in a fixed
order — an explicit flag always wins, then environment variables, then the
project file, then built-in defaults. See the
[precedence figure on the CLI page](./texra-cli.md#workspace-defaults).

### OS-Specific Configuration

Some settings may need adjustment based on your operating system:

#### Windows

For Windows, use backslashes or escaped forward slashes in paths:

```json
"texra.latex.tikzInputDirectory": "C:\\Users\\Username\\Documents\\LaTeX\\tikz"
```

#### macOS and Linux

For macOS and Linux, use forward slashes:

```json
"texra.latex.tikzInputDirectory": "/Users/username/Documents/LaTeX/tikz"
```

## Creating Custom Profiles

To keep different configuration sets:

- **CLI:** each project carries its own `.texra/config.json`, so per-project defaults come for free.
- **VS Code extension:** TeXRA has no built-in profile support, but you can use VS Code's settings profiles — create a profile per project type, configure TeXRA differently in each, and switch as you change tasks.

## Configuration Best Practices

### Optimizing for Performance

For better performance:

```json
"texra.files.ignored.directories": ["build", "node_modules", "versions", "history"],
"texra.logger.debugMode": false
```

### Optimizing for Collaboration

For team collaboration:

```json
"texra.git.numberOfCommitsToShow": 30,
"texra.latex.latexindentConfig": "${workspaceFolder}/.latexindent.yaml",
"texra.latex.texfmtConfig": "${workspaceFolder}/tex-fmt.toml"
```

Use workspace settings to ensure consistent configuration across the team.

## Advanced Configuration

### Manual Settings File Editing

Power users can edit the underlying settings file directly:

- **CLI / project-level:** edit `.texra/config.json` in your project (run `texra init` to scaffold one). Only recognized `texra.*` keys take effect — the CLI warns on unknown keys.
- **VS Code extension:** open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`), run "Preferences: Open User Settings (JSON)", and add or modify `texra.*` keys.

### Cross-Extension Compatibility

Configure TeXRA to work well with other extensions:

```json
// Git extensions compatibility
"git.enableSmartCommit": true,
"texra.git.numberOfCommitsToShow": 20
```

## Troubleshooting Configuration

If you encounter configuration issues:

1. **Reset to Defaults**: Clear custom settings to return to defaults
2. **Check Syntax**: Ensure your JSON settings are correctly formatted
3. **Reload Window**: Use "Developer: Reload Window" from the Command Palette
4. **Check Logs**: Look for configuration-related errors in the ProgressBoard

Common configuration issues include:

- Incorrect file paths (especially across operating systems)
- JSON syntax errors in settings files
- Conflicting settings between user and workspace levels
- Missing required dependencies for configured features

## Next Steps

Now that you understand how to configure TeXRA, you may want to learn about:

- [Custom Agents](/guide/custom-agents) - Learn how to create your own specialized agents
- [Best Practices](/guide/best-practices) - Discover recommended settings for different workflows
- [Troubleshooting](/guide/troubleshooting) - Resolve common configuration issues

## Agent Execution Settings (Webview Interface)

These settings, accessible directly in the main TeXRA webview, control how agents run:

<InstructionHeaderCard />

<p class="hero-caption">The instruction-panel header: header actions (Settings, History, Pack, Clean, Magic Polish, Erase), the open Tool-configuration dropdown, and the agent and model selectors.</p>

**Tool Configuration Dropdown** (<wa-icon library="texra" name="tools"></wa-icon> ○<wa-icon library="texra" name="chevron-down"></wa-icon> next to Instruction label):

- **Attach TeX Count** (<wa-icon library="texra" name="symbol-numeric"></wa-icon>): Includes `texcount` output (word/header/math stats) in the agent's context. Requires `texcount` installed.
- **Attach Diagnostics** (<wa-icon library="texra" name="tools"></wa-icon>): Appends LaTeX compilation logs and other diagnostics to the agent prompt.

Reflection rounds are now controlled entirely by the agent definition. Choose agents whose `userRequest` prompt list includes follow-up entries (or create custom ones) when you need an automatic follow-up critique.

To capture the full prompt sent to the model, enable the `texra.debug.saveInputPrompt` setting (in `.texra/config.json` or VS Code settings).

**Model/Agent Selection:**

- **Agent** (<wa-icon library="texra" name="sparkle"></wa-icon>): Select the agent (see [Built-in](./built-in-agents.md) / [Custom](./custom-agents.md)).
- **Model** (<wa-icon library="texra" name="robot"></wa-icon>): Select the language model (see [Models](./models.md)).

**Instruction Header Actions:**

- **Settings** (<wa-icon library="texra" name="gear"></wa-icon>): Open TeXRA extension settings.
- **History** (<wa-icon library="texra" name="history"></wa-icon>): Open Agent Execution History panel.
- **Pack** (<wa-icon library="texra" name="archive"></wa-icon>): Archive the current run's task storage folder to `History`.
- **Clean** (<wa-icon library="texra" name="trash"></wa-icon>): Delete the current run's task storage folder.
- **Magic Polish** (<wa-icon library="texra" name="sparkle"></wa-icon>): Use selected model to polish the instruction text.
- **Erase Instruction** (<wa-icon library="texra" name="clear-all"></wa-icon>): Clear the instruction box.
