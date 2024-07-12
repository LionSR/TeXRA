# CoAuthor Front End

## VS Code Extension

The VS Code extension provides a user interface for interacting with the CoAuthor backend. It includes features such as:

- File selection for input, auxiliary, and figure files
- Task selection (e.g., correct, polish, draw)
- Model selection
- Execution of CoAuthor commands
- LaTeX diff functionality
- Housekeeping operations (clean output, clean build, indent TeX)

## Features

- **AI-Powered Assistance**: Leverage the power of large language models to get intelligent suggestions and help with your coding and writing tasks.
- **Multiple File Support**: Work with multiple input files simultaneously for complex projects.
- **LaTeX Integration**: Special support for LaTeX documents, including diff functionality and figure extraction.
- **Customizable Settings**: Tailor the prompt to your needs with configurable settings.
- **Version Control Integration**: Easily access and compare recent commits in your project.

## Installation

### Quick Installation (Recommended for most users)

If you don't want to customize and recompile the frontend yourself, you can simply install the latest pre-built version:

1. Open VS Code.
2. Open the folder containing the CoAuthor extension (where the `releases` folder is located).
3. In the VS Code file explorer, navigate to the `releases` folder.
4. Find the newest `.vsix` file (e.g., `coauthor-0.5.6.vsix`).
5. Right-click on the `.vsix` file.
6. From the context menu, select "Install Extension VSIX".

This method allows you to quickly install the latest version of the extension directly from within VS Code, without needing to compile the extension yourself.

### Manual Installation (For developers or customization)

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

### Installing the backend

Install the companion Python package (backend):

```bash
cd coauthor
pip install -e .
```

See the README for the backend [CoAuthor Backend README](../README.md). for more information.

## Usage

CoAuthor frontend provides several commands that can be accessed via the command palette:

- `coauthor.cleanOutput`: Clean output files
- `coauthor.cleanBuild`: Clean all build files
- `coauthor.indentTex`: Indent TeX files
- `coauthor.packSingle`: Pack a single file
- `coauthor.cleanSingle`: Clean a single file
- `coauthor.latexDiff`: Generate LaTeX diff
- `coauthor.latexDiffVC`: Generate LaTeX diff with version control
- `coauthor.getRecentCommits`: Get recent commits
- `coauthor.refreshCommits`: Refresh commit information
- `coauthor.selectMultipleFiles`: Select multiple input files
- `coauthor.selectInputFile`: Select an input file
- `coauthor.selectAuxFile`: Select an auxiliary file
- `coauthor.selectFigureFile`: Select a figure file
- `coauthor.execute`: Execute a task

## Customization

### Customizing Tasks

You can customize the list of available tasks in your VS Code settings:

1. Open VS Code Settings (File > Preferences > Settings or `Ctrl+,`).
2. Search for "CoAuthor" in the settings search bar.
3. Look for the "Coauthor: Tasks" setting.
4. Edit the task list to add, remove, or modify tasks.

Example custom task list:

```json
"coauthor.tasks": [
  "correct-tex",
  "polish-tex",
  "draw-tex",
  "adapt-tex",
  "write-tex",
  "meeting2text",
  "paper2note",
  "txt2tex",
  "correct-st",
  "polish-st",
  "draw-st"
]
```

### Extension Settings

Users can customize the included directories by modifying their VS Code settings:

```json
{
  "coauthor.includedDirectories": ["Discrete-Time", "FiguresEx", "AnotherDirectory"]
}
```

## Known Issues

If your frontend version is older than 0.5.6, you need to uninstall and reinstall the extension due to a change in the creator's name.
