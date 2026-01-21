# Configuration

TeXRA provides extensive configuration options that allow you to customize its behavior to match your workflow (don't worry, the defaults are sensible!). This guide explains the available settings and how to adjust them for optimal performance.

## Accessing Configuration

You can configure TeXRA through VS Code's settings:

1. Open VS Code Settings (File > Preferences > Settings or `Ctrl+,`)
2. Search for "TeXRA" to see all available settings
3. Adjust settings in the UI or edit the JSON directly

![VS Code Settings](/images/vscode-settings.png)

## Core Configuration Options

### Agent Configuration

Control which agents are available in the dropdown menu. Below is the default list:

```json
"texra.agents": [
  "correct",
  "polish",
  "draw",
  "ocr",
  "paper2slide",
  "paper2poster",
  "transcribe_audio"
]
```

If an agent listed here lacks a corresponding `.yaml` file, it appears disabled
in the main view. A banner provides quick actions to edit the list, set or open
the custom agents directory, or read the documentation. Agents with a matching
`_multiple.yaml` file show a codicon next to their name to indicate multi-output
support.

### Tool-Use Agents Configuration

Separate from regular agents, tool-use agents appear in their own dropdown and support interactive tool calling:

```json
"texra.toolUseAgents": [
  "ask",
  "chat",
  "lean",
  "research",
  "search"
]
```

### Model Configuration

Define which AI models appear in the model selection dropdown. The current
default list is maintained in the [Models Guide](./models.md). Override it by
specifying your own model identifiers:

```json
"texra.models": [
  "gemini3p",
  "gemini3f",
  "sonnet45T",
  "opus45T",
  "gpt52",
  "gpt52pro",
  "gpt41",
  "deepseekT",
  "kimi2T",
  "kimi2",
  "qwen3max",
  "grok4"
]
```

### Agent Output Storage

Control where agent-generated files are saved:

```json
"texra.agentOutputs.storageMode": "workspace"
```

- `workspace`: Write output files beside the source files (default)
- `taskRunStorage`: Isolate artifacts inside the extension storage directory

## User Interface Settings

Control UI elements and reminders:

```json
"texra.ui.showApiKeyReminders": true,
"texra.ui.showDependencyReminders": true,
"texra.ui.showLoginBanner": true,
"texra.auth.enableVSCodeGitHub": false
```

- `showApiKeyReminders`: Show API key reminders in the status bar and main view when no API keys are configured
- `showDependencyReminders`: Show dependency check reminders in the main view when core dependencies are missing
- `showLoginBanner`: Show login banner prompting users to sign in for access to remote agents
- `enableVSCodeGitHub`: Enable VS Code native GitHub authentication (experimental)

## API Provider Settings

Configure how TeXRA connects to AI model providers:

```json
"texra.model.useOpenRouter": false,
"texra.model.useImprovedConnection": false,
"texra.model.improvedConnectionDomain": "proxy.texra.ai",
"texra.model.baseUrlDeepSeek": "",
"texra.model.useOpenAIResponsesAPI": true,
"texra.model.useBackgroundResponses": false,
"texra.model.useCopilot": false
```

- `useOpenRouter`: Access models through OpenRouter instead of direct APIs
- `useImprovedConnection`: Route all API requests through a proxy server
- `improvedConnectionDomain`: Custom proxy domain when `useImprovedConnection` is enabled. Defaults to `proxy.texra.ai`.
  - **Security Warning:** When using a proxy, ensure you trust the proxy server as it will receive your API keys. Only use proxies from trusted sources.
- `baseUrlDeepSeek`: Custom base URL for DeepSeek models; overrides the default `https://api.deepseek.com` endpoint
- `useOpenAIResponsesAPI`: Use OpenAI's Responses API instead of Chat Completions when available
- `useBackgroundResponses`: Enable background mode for OpenAI Responses API to handle long-running generations (>10mins) more reliably by preventing request timeouts. Adds polling overhead.
- `useCopilot`: Use the Copilot language model via VS Code's Language Model API for polishing instructions and best connection detection

| Provider         | Proxy path                  | Supported |
| ---------------- | --------------------------- | --------- |
| OpenAI           | `openai/v1`                 | Yes       |
| Anthropic        | `anthropic/v1`              | Yes       |
| Gemini (Google)  | `generativelanguage/v1beta` | Yes       |
| xAI              | `xai`                       | Yes       |
| OpenRouter       | `openrouter`                | Yes       |
| Groq             | `groq/openai/v1`            | Yes       |
| Perplexity       | `pplx`                      | Yes       |
| Mistral          | `mistral`                   | Yes       |
| DeepSeek         | N/A                         | No        |
| Moonshot (Kimi)  | N/A                         | No        |
| DashScope (Qwen) | N/A                         | No        |

**Note:** Only the providers marked with "Yes" are supported by the proxy. Other providers will use their direct API endpoints even when proxy is enabled.

### Streaming Settings

Enable or disable streaming responses globally and per-provider:

```json
"texra.model.useStreaming": true,
"texra.model.useStreamingAnthropic": true,
"texra.model.useStreamingOpenai": true,
"texra.model.useStreamingGoogle": true,
"texra.model.useStreamingXai": true,
"texra.model.useStreamingDeepseek": true,
"texra.model.useStreamingMoonshot": true,
"texra.model.useStreamingDashscope": true,
"texra.model.useStreamingOpenrouter": false
```

- `useStreaming`: Global default for streaming API responses when supported by the model
- Provider-specific settings override the global setting:
  - `useStreamingAnthropic`: Enable streaming for Anthropic models
  - `useStreamingOpenai`: Enable streaming for OpenAI models
  - `useStreamingGoogle`: Enable streaming for Google models (works with both OpenAI-compatible API and native GenAI SDK)
  - `useStreamingXai`: Enable streaming for xAI models via OpenAI-compatible API
  - `useStreamingDeepseek`: Enable streaming for DeepSeek models via OpenAI-compatible API
  - `useStreamingMoonshot`: Enable streaming for Moonshot Kimi models via OpenAI-compatible API
  - `useStreamingDashscope`: Enable streaming for DashScope Qwen models via OpenAI-compatible API
  - `useStreamingOpenrouter`: Enable streaming for models accessed via OpenRouter (disabled by default)

### Context Management Settings

Configure automatic context management for long conversations:

```json
"texra.model.compactionThresholdPercent": 75,
"texra.model.enableThinkingClearing": false
```

- `compactionThresholdPercent`: Percentage of context window to trigger automatic context management. For OpenAI, triggers conversation compaction via /responses/compact. For Anthropic, triggers server-side clearing of tool uses and thinking blocks. Set to 0 to disable.
- `enableThinkingClearing`: Enable Anthropic's thinking block clearing strategy. When enabled, old thinking blocks are cleared alongside tool uses. Disabled by default because thinking clearing runs before tool use clearing and may prevent tool use clearing from triggering.

### Model-Specific Settings

```json
"texra.model.gpt5ReasoningSummary": false,
"texra.model.useAnthropic1MBeta": false,
"texra.model.instructionPolishModel": "sonnet45"
```

- `gpt5ReasoningSummary`: Request reasoning summaries from GPT-5 models (requires verified account and appropriate user tier)
- `useAnthropic1MBeta`: Attach the `context-1m-2025-08-07` beta header for Claude Sonnet 4 requests to enable the 1M-token context window (usage capped at 200K by extension)
- `instructionPolishModel`: Short name of the model used to polish instruction text when Copilot is disabled. Values match the identifiers listed in [Models](./models.md).

### Model Retry Settings

Configure automatic retry behavior for failed model calls:

```json
"texra.model.retry.maxAttempts": 0,
"texra.model.retry.backoffMs": 1000
```

- `maxAttempts`: Number of automatic retry attempts before surfacing a manual retry option. Set to 0 for no automatic retries (manual retry button only).
- `backoffMs`: Base backoff delay in milliseconds between retry attempts

## Audio Settings

Specify a custom path to the [SoX](http://sox.sourceforge.net/) binary when automatic detection fails:

```json
"texra.audio.soxPath": "C:\\Users\\thinking\\scoop\\apps\\sox\\current\\sox.exe"
```

If unset, TeXRA searches common install locations and your `PATH`.

## File Management Configuration

### File Extensions

Control which file types TeXRA includes for different purposes:

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
  ".bib",
  ".bbl"
],
"texra.files.included.auxiliaryExtensions": [
  ".txt",
  ".tex",
  ".cls",
  ".md",
  ".sty"
],
"texra.files.included.editedExtensions": [
  ".txt",
  ".tex"
],
"texra.files.included.mediaExtensions": [
  ".png",
  ".pdf",
  ".jpeg",
  ".jpg",
  ".gif",
  ".heic",
  ".heif",
  ".webp",
  ".wav",
  ".m4a",
  ".mp3",
  ".aiff",
  ".aac",
  ".ogg",
  ".flac"
]
```

- `inputExtensions`: File extensions for input files
- `referenceExtensions`: File extensions for reference files (includes `.bib` for bibliography)
- `auxiliaryExtensions`: File extensions for auxiliary files like style files and class files
- `editedExtensions`: File extensions for files that can be edited by agents
- `mediaExtensions`: File extensions for figures and audio files

### Ignored Directories and Files

Control which directories and files TeXRA ignores:

```json
"texra.files.ignored.directories": [
  "build",
  "node_modules",
  "__pycache__",
  "figures",
  "media",
  "figs",
  "versions",
  "history",
  "stuff",
  "draft",
  "miscellaneous",
  "diffs",
  "venv"
],
"texra.files.ignored.mediaDirectories": [
  "build",
  "node_modules",
  "__pycache__",
  "versions",
  "history",
  "venv",
  "Diffs"
],
"texra.files.ignored.inputDirectories": [],
"texra.files.ignored.fileExtensions": [
  ".pdf",
  ".bst",
  ".json",
  ".py",
  ".ipynb",
  ".png",
  ".vsix",
  ".ts",
  ".js",
  ".yaml"
],
"texra.files.ignored.inputFiles": [
  "command.tex",
  "commands.tex",
  "preamble.tex",
  "yaml"
],
"texra.files.ignored.auxiliaryKeywords": [
  "o1",
  "o3",
  "o4",
  "gpt",
  "sonnet",
  "haiku",
  "opus",
  "gemini",
  "grok",
  "deepseek",
  "qwen",
  "kimi",
  "llama",
  "egg-info",
  "yaml"
],
"texra.files.ignored.keywords": [
  "Makefile",
  "template",
  "_thinking",
  "_diff",
  "draw",
  "versions",
  "history",
  ".egg-info",
  "venv",
  "yaml"
]
```

- `directories`: Directories to ignore when listing files
- `mediaDirectories`: Directories to ignore specifically in figure/media paths
- `inputDirectories`: Additional directories to ignore when listing input and edited files
- `fileExtensions`: File extensions to ignore when listing text files
- `inputFiles`: Files to ignore when listing input, sample, and edited files (but not auxiliary files)
- `auxiliaryKeywords`: Keywords to ignore when listing auxiliary files, including model names
- `keywords`: Keywords to ignore when selecting files

### Image Processing

```json
"texra.maxImageDimension": 2000
```

- `maxImageDimension`: Maximum dimension (width or height) in pixels for images before resizing. Images larger than this will be resized to fit within this dimension while maintaining aspect ratio. Range: 100-10000.

## LaTeX Configuration

### LaTeX Formatting

Configure LaTeX formatting behavior:

```json
"texra.latex.formatter": "latexindent",
"texra.latex.showLatexindentWarning": true,
"texra.latex.latexindentConfig": "/path/to/latexindent.yaml",
"texra.latex.texfmtConfig": "/path/to/tex-fmt.toml"
```

- `formatter`: Choose between `latexindent` (default), `tex-fmt`, or `none` to disable formatting
- `showLatexindentWarning`: Set to `false` to suppress missing `latexindent` warnings
- `latexindentConfig`: Path to a `latexindent` configuration file
- `texfmtConfig`: Path to a `tex-fmt` configuration file

### TikZ Figure Processing

Configure how TikZ figures are extracted and compiled:

```json
"texra.latex.tikzInputDirectory": "/path/to/tikz/inputs",
"texra.latex.includeWorkspaceInTexinputs": true,
"texra.latex.tikzTemplate": "\\documentclass[tikz,border=10pt]{standalone}\n\\usepackage{tikz}\n\\usepackage{pgfplots}\n\\usetikzlibrary{positioning}\n\\usetikzlibrary{patterns}\n\\usetikzlibrary{arrows.meta, shapes.geometric, matrix, calc, decorations.pathreplacing}\n\\usetikzlibrary{shapes, arrows}\n\n\\begin{document}\n{{ tikzpicture }}\n\\end{document}"
```

- `tikzInputDirectory`: Additional directories to include in the TEXINPUTS path when compiling TikZ figures (absolute path required)
- `includeWorkspaceInTexinputs`: Whether to include the workspace root in TEXINPUTS
- `tikzTemplate`: The template used for generating standalone TikZ documents

### LaTeX Replacements

Configure automatic text replacements applied to LaTeX output:

```json
"texra.latex.wrapCritiqueInAlign": true,
"texra.latex.enabledReplacements": [
  "latex_spacing",
  "equations",
  "sections",
  "latex_forbidden_commands",
  "characters",
  "latex_xml",
  "latex_document",
  "unicode",
  "html_entities",
  "scratchpad_xml",
  "latexdiff",
  "gptness"
],
"texra.latex.enabledReplacementsRegex": [
  "inline_math",
  "parentheses",
  "latexdiff_markup",
  "equation_style"
],
"texra.latex.customReplacements": {},
"texra.latex.customReplacementsRegex": {}
```

- `wrapCritiqueInAlign`: When enabled, bare `\critique` and `\comment` commands inside align blocks are wrapped with `\intertext`
- `enabledReplacements`: List of enabled non-regex LaTeX replacement categories. Available: `latex_spacing`, `equations`, `sections`, `latex_forbidden_commands`, `characters`, `latex_xml`, `latex_document`, `unicode`, `html_entities`, `scratchpad_xml`, `latexdiff`, `gptness`, `personal_style`, `max_style`
- `enabledReplacementsRegex`: List of enabled regex LaTeX replacement categories. Available: `inline_math`, `parentheses`, `latexdiff_markup`, `equation_style`, `equation_macros`, `max_style_regex`
- `customReplacements`: Custom LaTeX replacements in the format `{ "from": "to" }`
- `customReplacementsRegex`: Custom regex replacements in the format `{ "pattern": "replacement" }`. Use capture groups with `$1`, `$2`, etc.

### LaTeXdiff Settings

Configure LaTeX diff operations:

```json
"texra.latexdiff.timeoutMs": 10000,
"texra.latexdiff.mathMarkup": "coarse",
"texra.latexdiff.pictureEnvironments": "(?:picture|tikzpicture|scope|DIFnomarkup)[\\w\\d*@]*",
"texra.latexdiff.generateBetweenRoundDiffs": false,
"texra.latexdiff.tempFileLocation": "sameDirectory"
```

- `timeoutMs`: Timeout in milliseconds for latexdiff operations (1000-80000)
- `mathMarkup`: Granularity of markup in displayed math environments:
  - `off`: Suppress markup for math environments. Deleted equations will not appear in diff file.
  - `whole`: Differencing on the level of whole equations. Even trivial changes cause the whole equation to be marked changed.
  - `coarse`: Detect changes within equations with coarse granularity; changes in equation type appear as a change to the complete equation (default).
  - `fine`: Detect small changes in equations and mark up at fine granularity.
- `pictureEnvironments`: Regular expression pattern for environments to be treated as pictures. These environments will be processed as a unit without internal differencing.
- `generateBetweenRoundDiffs`: Generate diffs between consecutive agent rounds in addition to comparing each round to the original input
- `tempFileLocation`: Where to create temporary files for LaTeX preview and diff operations:
  - `sameDirectory`: Create temp files in the same directory as the original file. Best for resolving `\input{}` and relative paths (default).
  - `workspaceTemp`: Create temp files in `.texra-temp` directory at workspace root. Keeps source directories clean but may break relative paths.

## Authentication and Remote Agents

Configure authentication and remote agent access:

```json
"texra.auth.enabled": true,
"texra.remoteAgents.enabled": true,
"texra.remoteAgents.autoShow": true
```

- `auth.enabled`: Enable TeXRA authentication for remote agents and cloud features
- `remoteAgents.enabled`: Allow loading remote agents from TeXRA cloud
- `remoteAgents.autoShow`: Automatically show remote agents in dropdown without needing to add them to `texra.agents` list

## Execution Configuration

Control agent execution behavior:

```json
"texra.agent.pauseForConfirmation": false
```

When set to `true`, TeXRA will pause for confirmation after each agent, even when reflection is enabled.

## Tool-Use Agent Settings

Configure tool-use agent behavior:

```json
"texra.toolUse.requireEditApproval": true,
"texra.toolUse.persistence.enabled": true,
"texra.toolUse.persistence.ttlHours": 72
```

- `requireEditApproval`: Require user approval in a diff view before tool-driven edits modify workspace files
- `persistence.enabled`: Persist tool-use conversations across VS Code restarts
- `persistence.ttlHours`: Maximum age (in hours) to keep saved tool-use sessions before automatic cleanup

## Git Integration

Configure Git integration features:

```json
"texra.git.numberOfCommitsToShow": 20
```

This setting controls how many recent commits are shown in the commit selection dropdown for LaTeX diff operations (1-100).

## Merge Operations

Configure merge operations:

```json
"texra.merge.defaultModel": "gemini3f"
```

Default model to use for merge operations. Fast models like Gemini 3 Flash, GPT-4.1, or Haiku are recommended. Available options include: `gemini3f`, `gemini3p`, `gpt41`, `gpt52`, `gpt52pro`, `kimi2`, `kimi2T`, `deepseek`, `deepseekT`, `qwen3max`, `qwenplus`, `grok4`, `sonnet45T`, `sonnet4T`, `haiku45T`.

## Explorer Configuration

Configure the folder explorer view:

```json
"texra.explorer.agentsDirectory": "/path/to/custom/agents"
```

This setting specifies a custom root path for the TeXRA file explorer view and must be an absolute path.

## Progress Board Configuration

Configure the Progress Board view:

```json
"texra.progressBoard.streamSortOrder": "time"
```

Default sort order for streams in the Progress Board:
- `none`: No sorting (maintain order of creation)
- `time`: Sort by last active time, newest first (default)
- `inputFile`: Sort alphabetically by input file name
- `agent`: Sort alphabetically by agent type

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
"texra.model.useStreaming": true,
"texra.files.ignored.directories": ["build", "node_modules", "versions", "history"],
"texra.logger.debugMode": false
```

### Optimizing for Quality

For highest quality results:

```json
"texra.model.compactionThresholdPercent": 75,
"texra.toolUse.requireEditApproval": true
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
- [Best Practices](/reference/best-practices) - Discover recommended settings for different workflows
- [Troubleshooting](/reference/troubleshooting) - Resolve common configuration issues

## Agent Execution Settings (Webview Interface)

These settings, accessible directly in the main TeXRA webview, control how agents run:

**Tool Configuration Dropdown** (<i class="codicon codicon-tools"></i> next to Instruction label):

- **Attach TeX Count** (<i class="codicon codicon-symbol-numeric"></i>): Includes `texcount` output (word/header/math stats) in the agent's context. Requires `texcount` installed.
- **Attach Diagnostics** (<i class="codicon codicon-tools"></i>): Appends LaTeX compilation logs and other diagnostics to the agent prompt.

Reflection rounds are now controlled entirely by the agent definition. Choose agents whose `userRequest` prompt list includes follow-up entries (or create custom ones) when you need an automatic follow-up critique.

To capture the full prompt sent to the model, enable the `Save Input Prompt` debug setting in VS Code Settings (`texra.debug.saveInputPrompt`).

**Model/Agent Selection:**

- **Agent** (<i class="codicon codicon-sparkle"></i>): Select the agent (see [Built-in](./built-in-agents.md) / [Custom](./custom-agents.md)).
- **Model** (<i class="codicon codicon-robot"></i>): Select the language model (see [Models](./models.md)).

**Instruction Header Actions:**

- **Settings** (<i class="codicon codicon-gear"></i>): Open TeXRA extension settings.
- **History** (<i class="codicon codicon-history"></i>): Open Agent Execution History panel.
- **Pack** (<i class="codicon codicon-archive"></i>): Archive current Agent/Model/Input outputs to `History` folder.
- **Clean** (<i class="codicon codicon-trash"></i>): Delete current Agent/Model/Input outputs.
- **Magic Polish** (<i class="codicon codicon-sparkle"></i>): Use selected model to polish the instruction text.
- **Erase Instruction** (<i class="codicon codicon-clear-all"></i>): Clear the instruction box.
