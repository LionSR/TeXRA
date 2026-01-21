# Configuration

TeXRA settings are accessible through VS Code:

1. Open Settings (`Ctrl+,` or `Cmd+,`)
2. Search for "TeXRA"
3. Adjust settings as needed

All settings have sensible defaults - most users won't need to change anything.

## Key Settings

### API Providers

- **texra.model.useOpenRouter**: Route requests through OpenRouter instead of direct APIs
- **texra.model.useStreaming**: Enable streaming responses (recommended)

### Tool-Use Agents

- **texra.toolUse.requireEditApproval**: Show diff view before applying edits (default: true)
- **texra.toolUse.persistence.enabled**: Keep sessions across VS Code restarts

### LaTeX

- **texra.latex.formatter**: Choose `latexindent`, `tex-fmt`, or `none`
- **texra.latex.tikzInputDirectory**: Additional paths for TikZ compilation

### Files

- **texra.files.ignored.directories**: Folders to exclude from file lists
- **texra.files.included.inputExtensions**: File types to show as inputs

## Workspace vs User Settings

- **User Settings**: Apply to all projects
- **Workspace Settings**: Apply only to current project (`.vscode/settings.json`)

Use workspace settings for project-specific configuration like custom TikZ paths or team-shared formatter configs.
