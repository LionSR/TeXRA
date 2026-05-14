# Configuration

TeXRA provides extensive configuration options that allow you to customize its behavior to match your workflow (don't worry, the defaults are sensible!). This guide explains the available settings and how to adjust them for optimal performance.

## The TeXRA Dashboard

The **Dashboard** is your one-stop shop for managing everything in TeXRA. Open it from the Command Palette (`Ctrl+Shift+P`) with **TeXRA: Show Dashboard**.

- **Memory** - See what your tool-use agents have remembered across sessions, and delete entries you no longer need.
- **History** - Search and browse past runs. Handy for finding that polish job you ran last week.
- **Models** - Pick which models show up in your dropdown. Models are grouped by provider (Anthropic, OpenAI, Google, etc.) and you can set or remove API keys for each provider right there - no need to hunt through settings.
- **Agents** - Turn agents on or off for the current workspace. Agents that support multiple output files are marked with a badge.
- **Multi-Agent** - Configure multi-agent orchestration and presets.
- **Tools** - Manage tool-use agent capabilities and approval settings.
- **Git** - Set a GitHub personal access token (required for the `github_subscription` tool) and optionally attribute TeXRA commits to a custom author.
- **LaTeX** - Configure LaTeX formatting, diff, and TikZ settings.

::: tip
Many connection and model settings are configured through VS Code's standard settings. The Dashboard tabs provide convenient access to agent, model, and tool configuration.
:::

## Accessing Configuration

You can also configure TeXRA through VS Code's standard settings:

1. Open VS Code Settings (File > Preferences > Settings or `Ctrl+,`)
2. Search for "TeXRA" to see all available settings
3. Adjust settings in the UI or edit the JSON directly

![VS Code Settings](/images/vscode-settings.png)

## Core Configuration Options

### Agent Configuration

Agent visibility is managed through the **Agents** tab in the TeXRA Dashboard
(`TeXRA: Show Agents` from the Command Palette). The split-panel browser lets
you toggle individual agents on or off for the current workspace. Agents with a
matching `_multiple.yaml` file are flagged with a multi-output badge.

### Model Configuration

Which models appear in the selection dropdown is managed through the **Models**
tab in the TeXRA Dashboard. Toggle individual models on or off per provider.
See the [Models Guide](./models.md) for the full list of supported models.

### API Provider Settings

Configure how TeXRA connects to AI model providers:

```json
"texra.model.useImprovedConnection": false,
"texra.model.improvedConnectionDomain": "",
"texra.model.useOpenAIResponsesAPI": true,
"texra.model.gpt5ReasoningSummary": false
```

- **OpenRouter**: To route all API calls through OpenRouter, expand the OpenRouter row in the Dashboard → Models tab → API Configuration and enable **"Use OpenRouter for All Models"**
- `useImprovedConnection`: Route all API requests through a proxy server
- `improvedConnectionDomain`: Custom proxy domain when `useImprovedConnection` is enabled. Defaults to the built-in proxy when unset.
  - ⚠️ **Security Warning:** When using a proxy, ensure you trust the proxy server as it will receive your API keys. Only use proxies from trusted sources.
- `useOpenAIResponsesAPI`: Use OpenAI's Responses API instead of Chat Completions when available
- `gpt5ReasoningSummary`: Request reasoning summaries from the GPT-5 family, including GPT-5.4 and GPT-5.4 Pro (requires verified account and user tier)

| Provider         | Proxy path                  | Supported |
| ---------------- | --------------------------- | --------- |
| OpenAI           | `openai/v1`                 | ✅ Yes    |
| Anthropic        | `anthropic/v1`              | ✅ Yes    |
| Gemini (Google)  | `generativelanguage/v1beta` | ✅ Yes    |
| xAI              | `xai`                       | ✅ Yes    |
| OpenRouter       | `openrouter`                | ✅ Yes    |
| Groq             | `groq/openai/v1`            | ✅ Yes    |
| Perplexity       | `pplx`                      | ✅ Yes    |
| Mistral          | `mistral`                   | ✅ Yes    |
| Moonshot (Kimi)  | N/A                         | ❌ No     |
| DashScope (Qwen) | N/A                         | ❌ No     |

**Note:** Only the providers marked with ✅ are supported by the proxy. Other providers will use their direct API endpoints even when proxy is enabled.

### Anthropic 1M Context Window

Claude Opus 4.7, Opus 4.6, and Sonnet 4.6 include the full 1M context window at standard pricing. No opt-in setting or beta header is required — 1M context is enabled automatically. Up to 600 PDF pages per request are supported (100 for models with a 200K context window). Other Claude models use a 200K context window.

Opus 4.7 uses adaptive thinking only — manual thinking budgets are not supported. TeXRA selects the appropriate thinking mode automatically based on the reasoning-effort level you pick in the Models tab (Low / Medium / High / Extra High). Extra High maps to Anthropic's `max` effort on Opus-tier models.

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
"texra.files.included.referenceExtensions": [
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

Configure LaTeX formatting behavior:

```json
"texra.latex.formatter": "none",
"texra.latex.showLatexindentWarning": false,
"texra.latex.latexindentConfig": "/path/to/latexindent.yaml",
"texra.latex.texfmtConfig": "/path/to/tex-fmt.toml"
```

- `formatter`: Choose between `latexindent`, `tex-fmt`, or `none` to disable formatting.
- `showLatexindentWarning`: Disabled by default. Set to `true` to show a popup when `latexindent` is missing.
- `latexindentConfig`: Path to a `latexindent` configuration file.
- `texfmtConfig`: Path to a `tex-fmt` configuration file.

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

The **Git tab** in the TeXRA Dashboard (`TeXRA: Show Dashboard` → **Git**) covers two independent features: a GitHub token used by the PR-subscription tool, and optional TeXRA-branded commit authorship for agent-made commits.

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

The token is stored in VS Code's encrypted **Secret Storage** — never written to `settings.json`. Alternatively, export `GITHUB_TOKEN` in the shell VS Code is launched from and the tool will pick it up automatically (the Git tab will show **Env** as the status).

Once a token is configured, an agent can run `github_subscription command=subscribe path=owner/repo/pulls/N` (or `path=owner/repo` for the whole repo, `path=owner/repo/issues/N` for a single issue) and every new event arrives wrapped in a `<github-webhook-activity>` tag in the follow-up queue. Use `command=unsubscribe` with the same path to stop, `command=list` to see active subscriptions, and `command=find_current` to resolve the current branch's PR. Subscriptions auto-terminate when the PR closes or merges, and up to 25 PRs can be watched concurrently.

### TeXRA commit author

Enable **Mark commits with TeXRA author info** to attribute commits created by TeXRA agents to a distinct identity (useful when sharing a repo with collaborators so you can tell which commits were machine-made). When enabled, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, and `GIT_COMMITTER_EMAIL` are set for every git command an agent runs.

### LaTeX diff commit history

The unrelated setting controlling how many recent commits appear in the LaTeX-diff commit picker is:

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

1. **User Settings**: Apply to all workspaces (set in VS Code's user settings)
2. **Workspace Settings**: Apply only to the current workspace (set in `.vscode/settings.json`)

For project-specific configurations, use workspace settings:

```json
// .vscode/settings.json
{
  "texra.files.included.inputExtensions": [".tex", ".md"],
  "texra.latex.tikzInputDirectory": "${workspaceFolder}/styles"
}
```

For personal preferences that apply to all projects, use user settings.

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

While TeXRA doesn't have built-in profile support, you can create multiple configuration sets using VS Code's settings profiles:

1. Create different VS Code profiles for different types of projects
2. Configure TeXRA differently in each profile
3. Switch between profiles based on your current task

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
"texra.latex.latexindentConfig": "${workspaceFolder}/.latexindent.yaml"
"texra.latex.texfmtConfig": "${workspaceFolder}/tex-fmt.toml"
```

Use workspace settings to ensure consistent configuration across the team.

## Advanced Configuration

### Manual Settings File Editing

For advanced configurations, you can directly edit the VS Code settings JSON:

1. Open Command Palette (Ctrl+Shift+P or Cmd+Shift+P on macOS)
2. Run "Preferences: Open User Settings (JSON)"
3. Add or modify TeXRA settings

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

**Tool Configuration Dropdown** (<wa-icon library="texra" name="tools"></wa-icon> ○<wa-icon library="texra" name="chevron-down"></wa-icon> next to Instruction label):

- **Attach TeX Count** (<wa-icon library="texra" name="symbol-numeric"></wa-icon>): Includes `texcount` output (word/header/math stats) in the agent's context. Requires `texcount` installed.
- **Attach Diagnostics** (<wa-icon library="texra" name="tools"></wa-icon>): Appends LaTeX compilation logs and other diagnostics to the agent prompt.

Reflection rounds are now controlled entirely by the agent definition. Choose agents whose `userRequest` prompt list includes follow-up entries (or create custom ones) when you need an automatic follow-up critique.

To capture the full prompt sent to the model, enable the `Save Input Prompt` debug setting in VS Code Settings (`texra.debug.saveInputPrompt`).

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
