# CoAuthor Frontend (VS Code Extension)

This is the frontend component of the CoAuthor project, a Visual Studio Code extension that provides a user-friendly interface for interacting with the CoAuthor backend.

## Features

- File selection for input, auxiliary, and figure files
- Task and model selection
- Execution of CoAuthor commands directly from VS Code
- LaTeX diff visualization
- Housekeeping operations (clean output, clean build, indent TeX)
- Customizable settings

## Installation

For quick installation, refer to the [main README](../README.md).

For manual installation or development setup:

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

## Usage

CoAuthor frontend provides several commands that can be accessed via the command palette (Ctrl+Shift+P or Cmd+Shift+P on macOS):

- `CoAuthor: Clean Output Files`
- `CoAuthor: Clean Build Files`
- `CoAuthor: Indent TeX Files`
- `CoAuthor: Pack Single File`
- `CoAuthor: Clean Single File`
- `CoAuthor: Generate LaTeX Diff`
- `CoAuthor: Generate LaTeX Diff (Version Control)`
- `CoAuthor: Get Recent Commits`
- `CoAuthor: Refresh Commit Information`
- `CoAuthor: Select Multiple Input Files`
- `CoAuthor: Select Input File`
- `CoAuthor: Select Auxiliary File`
- `CoAuthor: Select Figure File`
- `CoAuthor: Execute Task`

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
