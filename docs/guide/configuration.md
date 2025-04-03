# Configuration

TexRA provides extensive configuration options that allow you to customize its behavior to match your workflow. This guide explains the available settings and how to adjust them for optimal performance.

## Accessing Configuration

You can configure TexRA through VS Code's settings:

1. Open VS Code Settings (File > Preferences > Settings or `Ctrl+,`)
2. Search for "TexRA" to see all available settings
3. Adjust settings in the UI or edit the JSON directly

<!-- ![VS Code Settings](/images/vscode-settings.png) -->

## Core Configuration Options

### Agent Configuration

Control which agents are available in the dropdown menu:

```json
"coauthor.agents": [
  "correct",
  "polish",
  "draw",
  "paper2note",
  "paper2slide",
  "paper2poster",
  "txt2tex",
  "merge",
  // Additional custom agents
]
```

### Model Configuration

Define which AI models appear in the model selection dropdown:

```json
"coauthor.models": [
  "sonnet37T",
  "sonnet37",
  "sonnet35",
  "opus",
  "o3-",
  "o1",
  "o1-",
  "gpt45",
  "gpt4o",
  "gpt4ol",
  "gemini25p",
  "gemini2p",
  "gemini2f",
  "gemini2fT",
  "DSV3",
  "DSR1"
]
```

### API Provider Settings

Configure how TexRA connects to AI model providers:

```json
"coauthor.model.useOpenRouter": false,
"coauthor.model.useStreaming": false,
"coauthor.model.useStreamingAnthropicReasoning": false,
"coauthor.model.useStreamingOpenAIReasoning": false
```

- `useOpenRouter`: Access models through OpenRouter instead of direct APIs
- `useStreaming`: Enable streaming responses for better handling of long outputs
- `useStreamingAnthropicReasoning`: Enable streaming specifically for Anthropic reasoning models
- `useStreamingOpenAIReasoning`: Enable streaming specifically for OpenAI reasoning models

## File Management Configuration

### File Extensions

Control which file types TexRA includes:

```json
"coauthor.files.included.inputExtensions": [
  ".txt",
  ".tex",
  ".md"
],
"coauthor.files.included.mediaExtensions": [
  ".png",
  ".pdf",
  ".jpeg",
  ".jpg",
  ".svg",
],
```

### Ignored Directories

Control which directories TexRA ignores:

```json
"coauthor.files.ignored.directories": [
  "build",
  "node_modules",
  "__pycache__",
  "figures",
  "figs",
  "versions",
  "history",
  "venv"
],
"coauthor.files.ignored.fileExtensions": [
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
"coauthor.files.ignored.inputFiles": [
  "command.tex",
  "preamble.tex"
],
"coauthor.files.ignored.keywords": [
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
"coauthor.latex.latexindentConfig": "/path/to/latexindent.yaml"
```

This setting points to a configuration file for `latexindent`, which controls how LaTeX files are formatted.

### TikZ Figure Processing

Configure how TikZ figures are extracted and compiled:

```json
"coauthor.latex.tikzInputDirectory": "/path/to/tikz/inputs",
"coauthor.latex.includeWorkspaceInTexinputs": true,
"coauthor.latex.tikzTemplate": "\\documentclass[tikz,border=10pt]{standalone}\n\\usepackage{tikz}\n\\usepackage{pgfplots}\n\\usetikzlibrary{positioning}\n\\usetikzlibrary{patterns}\n\\usetikzlibrary{arrows.meta, shapes.geometric, matrix, calc, decorations.pathreplacing}\n\\usetikzlibrary{shapes, arrows}\n\n\\begin{document}\n{{ tikzpicture }}\n\\end{document}"
```

- `tikzInputDirectory`: Additional directories to include in the TEXINPUTS path when compiling TikZ figures
- `includeWorkspaceInTexinputs`: Whether to include the workspace root in TEXINPUTS
- `tikzTemplate`: The template used for generating standalone TikZ documents

## Execution Configuration

Control agent execution behavior:

```json
"coauthor.agent.pauseForConfirmation": false
```

When set to `true`, TexRA will pause for confirmation after each agent, even when reflection is enabled.

## Git Integration

Configure Git integration features:

```json
"coauthor.git.numberOfCommitsToShow": 20
```

This setting controls how many recent commits are shown in the commit selection dropdown for LaTeX diff operations.

## Explorer Configuration

Configure the folder explorer view:

```json
"coauthor.explorer.agentsDirectory": "/path/to/custom/agents"
```

This setting specifies a custom root path for the TexRA file explorer view, which can be absolute or relative to the workspace root.

## Logger Configuration

Control logging behavior:

```json
"coauthor.logger.verboseOutput": false,
"coauthor.debug.saveMessageObjects": false
```

- `verboseOutput`: Show detailed debug messages in the logger view
- `saveMessageObjects`: Save message JSON objects to files before API calls (for debugging)

## Environment-Specific Configuration

### Workspace vs. User Settings

You can configure TexRA at different levels:

1. **User Settings**: Apply to all workspaces (set in VS Code's user settings)
2. **Workspace Settings**: Apply only to the current workspace (set in `.vscode/settings.json`)

For project-specific configurations, use workspace settings:

```json
// .vscode/settings.json
{
  "coauthor.files.included.inputExtensions": [".tex", ".md", ".txt"],
  "coauthor.latex.tikzInputDirectory": "${workspaceFolder}/styles"
}
```

For personal preferences that apply to all projects, use user settings.

### OS-Specific Configuration

Some settings may need adjustment based on your operating system:

#### Windows

For Windows, use backslashes or escaped forward slashes in paths:

```json
"coauthor.latex.tikzInputDirectory": "C:\\Users\\Username\\Documents\\LaTeX\\tikz"
```

#### macOS and Linux

For macOS and Linux, use forward slashes:

```json
"coauthor.latex.tikzInputDirectory": "/Users/username/Documents/LaTeX/tikz"
```

## Creating Custom Profiles

While TexRA doesn't have built-in profile support, you can create multiple configuration sets using VS Code's settings profiles:

1. Create different VS Code profiles for different types of projects
2. Configure TexRA differently in each profile
3. Switch between profiles based on your current task

## Configuration Best Practices

### Optimizing for Performance

For better performance:

```json
"coauthor.model.useStreaming": true,
"coauthor.files.ignored.directories": ["build", "node_modules", "versions", "history"],
"coauthor.logger.verboseOutput": false
```

### Optimizing for Quality

For highest quality results:

```json
"coauthor.model.useStreamingAnthropicReasoning": true,
"coauthor.model.useStreamingOpenAIReasoning": true
```

### Optimizing for Collaboration

For team collaboration:

```json
"coauthor.git.numberOfCommitsToShow": 30,
"coauthor.latex.latexindentConfig": "${workspaceFolder}/.latexindent.yaml"
```

Use workspace settings to ensure consistent configuration across the team.

## Advanced Configuration

### Manual Settings File Editing

For advanced configurations, you can directly edit the VS Code settings JSON:

1. Open Command Palette (Ctrl+Shift+P or Cmd+Shift+P on macOS)
2. Run "Preferences: Open User Settings (JSON)"
3. Add or modify TexRA settings

### Command-Specific Configuration

Some TexRA commands can be configured through their own settings:

```json
"coauthor.setApiKey": {
  "defaultProvider": "anthropic"
},
"coauthor.cleanOutput": {
  "confirmBeforeDeleting": true
}
```

### Cross-Extension Compatibility

Configure TexRA to work well with other extensions:

```json
// LaTeX Workshop compatibility
"latex-workshop.latex.outDir": "%DIR%/build",
"coauthor.files.ignored.directories": ["build"],

// Git extensions compatibility
"git.enableSmartCommit": true,
"coauthor.git.numberOfCommitsToShow": 20
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

Now that you understand how to configure TexRA, you might want to explore:

- [Custom Agents](/guide/custom-agents) - Learn how to create your own specialized agents
- [Best Practices](/reference/best-practices) - Discover recommended settings for different workflows
- [Troubleshooting](/reference/troubleshooting) - Resolve common configuration issues
