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
  "derive",
  "polish",
  "draw",
  "ocr",
  "paper2cover",
  "paper2slide",
  "paper2poster",
  "paper2note",
  "polish_cover",
  "solve_qi",
  "transcribe_audio"
  // Additional custom agents can be added here
]
```

### Model Configuration

Define which AI models appear in the model selection dropdown. The current
default list is maintained in the [Models Guide](./models.md). Override it by
specifying your own model identifiers:

```json
"texra.models": ["sonnet37T", "gpt4o"]
```

### API Provider Settings

Configure how TeXRA connects to AI model providers:

```json
"texra.model.useOpenRouter": false,
"texra.model.useStreaming": false,
"texra.model.useStreamingAnthropicReasoning": false,
"texra.model.useStreamingOpenAIReasoning": false
```

- `useOpenRouter`: Access models through OpenRouter instead of direct APIs
- `useStreaming`: Enable streaming responses for better handling of long outputs
- `useStreamingAnthropicReasoning`: Enable streaming specifically for Anthropic reasoning models
- `useStreamingOpenAIReasoning`: Enable streaming specifically for OpenAI reasoning models

## File Management Configuration

### File Extensions

Control which file types TeXRA includes:

```json
"texra.files.included.inputExtensions": [
  ".txt",
  ".tex",
  ".md"
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

### LaTeX Indentation

Configure LaTeX indentation behavior:

```json
"texra.latex.latexindentConfig": "/path/to/latexindent.yaml"
```

This setting points to a configuration file for `latexindent`, which controls how LaTeX files are formatted.

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

## Execution Configuration

Control agent execution behavior:

```json
"texra.agent.pauseForConfirmation": false
```

When set to `true`, TeXRA will pause for confirmation after each agent, even when reflection is enabled.

## Git Integration

Configure Git integration features:

```json
"texra.git.numberOfCommitsToShow": 20
```

This setting controls how many recent commits are shown in the commit selection dropdown for LaTeX diff operations.

## Explorer Configuration

Configure the folder explorer view:

```json
"texra.explorer.agentsDirectory": "/path/to/custom/agents"
```

This setting specifies a custom root path for the TeXRA file explorer view, which can be absolute or relative to the workspace root.

## Logger Configuration

Control logging behavior:

```json
"texra.logger.verboseOutput": false,
"texra.debug.saveMessageObjects": false
```

- `verboseOutput`: Show detailed debug messages in the logger view
- `saveMessageObjects`: Save message JSON objects to files before API calls (for debugging)

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
"texra.logger.verboseOutput": false
```

### Optimizing for Quality

For highest quality results:

```json
"texra.model.useStreamingAnthropicReasoning": true,
"texra.model.useStreamingOpenAIReasoning": true
```

### Optimizing for Collaboration

For team collaboration:

```json
"texra.git.numberOfCommitsToShow": 30,
"texra.latex.latexindentConfig": "${workspaceFolder}/.latexindent.yaml"
```

Use workspace settings to ensure consistent configuration across the team.

## Advanced Configuration

### Manual Settings File Editing

For advanced configurations, you can directly edit the VS Code settings JSON:

1. Open Command Palette (Ctrl+Shift+P or Cmd+Shift+P on macOS)
2. Run "Preferences: Open User Settings (JSON)"
3. Add or modify TeXRA settings

### Command-Specific Configuration

Some TeXRA commands can be configured through their own settings:

```json
"texra.setApiKey": {
  "defaultProvider": "anthropic"
},
"texra.cleanOutput": {
  "confirmBeforeDeleting": true
}
```

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

Now that you understand how to configure TeXRA, you might want to explore:

- [Custom Agents](/guide/custom-agents) - Learn how to create your own specialized agents
- [Best Practices](/reference/best-practices) - Discover recommended settings for different workflows
- [Troubleshooting](/reference/troubleshooting) - Resolve common configuration issues

## Agent Execution Settings (Webview Interface)

These settings, accessible directly in the main TeXRA webview, control how agents run:

**Tool Configuration Dropdown** (<i class="codicon codicon-tools"></i> ○<i class="codicon codicon-chevron-down"></i> next to Instruction label):

- **Reflect** (<i class="codicon codicon-refresh"></i>): Enables CoT agents to critique/improve their output (adds round 1). Increases cost/time, potentially quality.
- **Attach TeX Count** (<i class="codicon codicon-symbol-numeric"></i>): Includes `texcount` output (word/header/math stats) in the agent's context. Requires `texcount` installed.
- **Use Prefill from Input** (<i class="codicon codicon-edit"></i>): Uses the input file content to prefill the instruction box (if agent supports it).
- **Print Input Prompt** (<i class="codicon codicon-file-code"></i>): Adds the full final prompt sent to the LLM to the ProgressBoard log (useful for debugging, increases log size).

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
