# TeXRA Frontend (VS Code Extension)

## Features

- Seamless integration with VS Code for academic research assistance
- File selection and management for various document types
- Agent and model selection with customizable parameters
- Real-time LaTeX diff visualization and merge capabilities
- Comprehensive housekeeping operations
- Adaptive theming that matches VS Code's appearance
- Robust logging system for debugging and monitoring
- Modular architecture for future extensibility

## Installation

### For Users

For quick installation, refer to the [main README](README.md), which allows you to quickly install the latest version of the extension directly from within VS Code, without needing to compile the extension yourself.

## Manual Installation (For developers or customization)

If you want to customize or contribute to the extension, follow these steps:

1. **Node.js and npm**: Ensure that Node.js and npm are installed on your system. Download them from [Node.js official site](https://nodejs.org/en/download/package-manager) and select the LTS version for stability.

2. **Yeoman and VS Code Extension Generator**: If not already installed, set up Yeoman and the VS Code Extension Generator by running:

   ```bash
   npm install -g yo generator-code
   ```

3. **VSCE**: Install the Visual Studio Code Extension Manager (vsce) globally using npm:

   ```bash
   npm install -g vsce
   ```

4. **Webpack**: Add Webpack to your project to help with the build process. Install it locally using:

   ```bash
   npm install --save-dev webpack webpack-cli
   ```

5. **Compile and Package**: Finally, compile your project and package it with the following command:
   ```bash
   npm run compile && vsce package
   ```
   or
   ```bash
   npm run build
   ```

## Detailed Usage Instructions

TeXRA frontend provides several commands that can be accessed via the command palette (Ctrl+Shift+P or Cmd+Shift+P on macOS) or through the TeXRA sidebar.

### File Selection

TeXRA supports multiple file inputs for various file types:

1. **Input Files**: You can select multiple input files for agents that require it.
2. **Reference Files**: For agents that use reference or sample files.
3. **Auxiliary Files**: Additional files needed for the agent.
4. **Figure Files**: Image files to be included in the document.

For each file type, you can:

- Select multiple files using the "Multiple" button
- Remove individual files by clicking the "-" button next to each file
- Reorder files by dragging and dropping them in the list

This flexible file selection system allows you to easily manage complex projects with multiple related files.

### Specific Instructions

The "Specific Instructions" text area allows you to provide detailed instructions for the AI model. These instructions are passed along verbatim; in addition, they are also carefully analyzed and expanded upon by the model. The AI will:

1. Interpret your instructions in the context of the selected agent
2. Break down complex instructions into manageable steps
3. Apply relevant domain knowledge to enhance the execution of your instructions
4. Generate a detailed plan of action before making any changes to your document

This process ensures that your instructions are carried out thoroughly and intelligently, often leading to more comprehensive and nuanced results than you might have initially envisioned.

### Buttons and Controls

The TeXRA sidebar provides several buttons and controls for easy interaction:

1. **Agent Selection**: Choose the specific agent you want to perform (e.g., correct, polish, draw).
2. **Model Selection**: Select the AI model to use for the agent (e.g., Sonnet+, Opus, GPT-4).
3. **Reflect**: Toggle whether the AI should perform a reflection step after the initial agent.
4. **Execute**: Run the selected agent with the chosen settings and files.
5. **Current**: Quickly select the currently open file as the input file.
6. **Empty**: Clear the current selection for multiple files.
7. **Multiple**: Open a file picker to select multiple files.

## Core Components

### Command System

The extension's commands are organized in the `commands/` directory and registered through `commands.ts`, including:

- Document processing commands
- File management operations
- Configuration commands
- Housekeeping utilities
- LaTeX diff and merge operations

### Models

The `models/` directory contains model-specific implementations for different AI providers and capabilities.

### Utility Modules

The `utils/` directory contains various utility modules for:

- File system operations and path management (`file`)
- Configuration handling
- Message display functions
- Logging system with structured output (`log`)
- Type checking and validation
- LaTeX-specific operations
- Common utility functions

### Log View

The `progressView/` directory implements the visual logging interface:

- Log viewer UI components
- Log filtering and display
- Real-time log updates
- Log level management
- Search and navigation features

### Terminal Integration

The extension provides integrated terminal support through `terminal.ts`:

- Dedicated terminal instance management
- Command execution
- Process handling

### WebView Interface

The UI is implemented as a WebView (`ViewProvider.ts` and `webview/` directory):

- Modern, responsive design
- Real-time updates
- Theme-aware styling
- Two-way communication with extension

### Folder Explorer

The `folderExplorer.ts` provides:

- Directory tree visualization
- File selection interface
- Path management utilities
- Workspace navigation

### Text Connection

The `textConnection.ts` handles:

- Text processing operations
- Content transformation
- Document manipulation
- String utilities

## Configuration

### Extension Settings

You can customize the list of available agents in your VS Code settings:

1. Open VS Code Settings (File > Preferences > Settings or `Ctrl+,`).
2. Search for "TeXRA" in the settings search bar.
3. Look for the "TeXRA: agents" setting.
4. Edit the agent list to add, remove, or modify agents.

```json
"texra.agents": [
  "correct",
  "polish",
  "draw",
  "meeting2text",
  "paper2note",
  "txt2tex",
  "correct_st",
  "polish_st",
  "draw_st",
  "paper2slide",
  "slide2paper"
]
```

Customize the extension through VS Code settings:

```json
{
  "texra.agents": ["correct", "polish", "draw"]
}
```

### Workspace Setup

For optimal usage:

1. Place the extension in the secondary sidebar
2. Configure your workspace settings
3. Set up any required authentication
4. Initialize your project structure

## Development

### Building

```bash
# Development build with watch mode
npm run watch

# Production build
npm run compile && vsce package
```

### Testing

```bash
# Run test suite
npm test

# Run specific tests
npm test -- --grep "test name"
```

## Housekeeping Operations

The TeXRA VS Code extension provides a user-friendly interface for performing housekeeping operations on your LaTeX projects. These operations are designed to work seamlessly with all TeXRA features, including the Intelligent Merge functionality.

### Clean Single

The "Clean Single" operation removes output files associated with a specific input file, agent, and model. It handles both normal output and intelligent merge output.

To use this feature:

1. Select your input file in the TeXRA sidebar
2. Choose the agent and model
3. Click the "Clean" button in the "Housekeeping" section

### Pack Single

The "Pack Single" operation collects output files associated with a specific input file, agent, and model, and moves them to a versioned folder. It also handles both normal output and intelligent merge output.

To use this feature:

1. Select your input file in the TeXRA sidebar
2. Choose the agent and model
3. Click the "Pack" button in the "Housekeeping" section

### Clean Output Files

This operation removes all output files in the current directory. To use it, click the "Clean Output" button in the TeXRA sidebar.

### Clean Build Files

This operation cleans up build directories. To use it, click the "Clean Build" button in the TeXRA sidebar.

### Indent TeX

This operation runs the `latexindent` tool on your TeX files to improve formatting. Click the "Indent TeX" button to use this feature.

### LaTeX Diff Operations

TeXRA provides powerful diff functionality to compare different versions of your LaTeX documents:

1. **LaTeX Diff**: Generate a diff between two LaTeX files. Select an input file and an edited file, then click the "latexdiff" button.
2. **LaTeX Diff VC**: Generate a diff against a specific git commit. Select an input file and a commit hash, then click the "latexdiff-vc" button.
3. **Pack/Clean LaTeX Diff VC**: Pack or clean the files generated from latexdiff-vc. Use the "Pack" or "Clean" buttons in the LaTeX Diff VC section.

### Merge Operation

The "Merge" button allows you to intelligently merge changes from an edited file back into the original file. This feature is particularly useful when working with AI-generated edits or collaborating with others.

All these operations use a flexible file pattern system to ensure they catch all relevant files, including those generated by the intelligent merge feature. This ensures that your working directory remains clean and organized, regardless of the complexity of your LaTeX project or the number of merge operations performed.

These features can be particularly useful when working with complex projects or after performing multiple intelligent merge
operations, helping you maintain a clean and efficient workspace.

## Recommended Setup

For optimal use with VS Code or Cursor, we recommend placing the TeXRA extension in the right (secondary) sidebar. This setup
allows for a more efficient workflow, especially when working with documents. To achieve this:

1. Open VS Code's Command Palette (Ctrl+Shift+P or Cmd+Shift+P on macOS).
2. Run the command "View: Toggle Secondary Side Bar Visibility" (or use the shortcut ⌥⌘B on macOS).
3. Drag the TeXRA view from the primary sidebar to the newly opened secondary sidebar on the right.

This configuration keeps your document in focus while providing easy access to TeXRA's features.`npm run watch

## LaTeX Configuration

### TikZ Figure Extraction and Compilation

TeXRA provides specialized tools for extracting and compiling TikZ figures from your LaTeX documents. The following settings help you customize this process:

#### TikZ Input Directory

You can configure a directory for additional input files needed when compiling extracted TikZ figures:

1. Open VSCode settings (File > Preferences > Settings)
2. Search for "texra.latex.tikzInputDirectory"
3. Set the absolute path to your TikZ-related input directory

This setting will pass the directory to the TEXINPUTS environment variable specifically when compiling standalone TikZ figures, using the format `.:yourTikzInputDir:$TEXINPUTS`. This ensures the LaTeX compiler can find any custom packages, styles, or macros needed for your TikZ figures.

#### Workspace Path in TEXINPUTS

By default, TeXRA includes your workspace root directory in the TEXINPUTS environment variable when compiling TikZ figures. This helps LaTeX find package files and custom styles that might be located anywhere in your project.

To change this behavior:

1. Open VSCode settings (File > Preferences > Settings)
2. Search for "texra.latex.includeWorkspaceInTexinputs"
3. Uncheck the box to disable including the workspace path

#### TikZ Template

You can customize the template used for generating standalone TikZ documents during the extraction and compilation process:

1. Open VSCode settings (File > Preferences > Settings)
2. Search for "texra.latex.tikzTemplate"
3. Modify the template to include any additional packages or settings needed for your TikZ figures

Example:

```latex
\documentclass[tikz,border=10pt]{standalone}
\usepackage{tikz}
\usepackage{pgfplots}
\usepackage{mathtools}
\usepackage{amsmath}
\usetikzlibrary{positioning}
\usetikzlibrary{patterns}
\usetikzlibrary{arrows.meta, shapes.geometric, matrix, calc, decorations.pathreplacing}
\usetikzlibrary{shapes, arrows}

\begin{document}
{{ tikzpicture }}
\end{document}
```

Note: The `{{ tikzpicture }}` placeholder is required and will be replaced with the extracted TikZ content during the compilation process.
