# Coauthor README

## Usage

CoAuthor is a powerful VS Code extension designed to assist developers and researchers in their coding and writing tasks. It provides a seamless integration with large language models to enhance productivity and streamline workflows.

## Features

- **AI-Powered Assistance**: Leverage the power of large language models to get intelligent suggestions and help with your coding and writing tasks.
- **Multiple File Support**: Work with multiple input files simultaneously for complex projects.
- **LaTeX Integration**: Special support for LaTeX documents, including diff functionality and figure extraction.
- **Customizable Settings**: Tailor the prompt to your needs with configurable settings.
- **Version Control Integration**: Easily access and compare recent commits in your project.

## Installation Guide

Follow these steps to install the necessary components for the extension:

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

6. **Install the Companion Python Package**:

   ```bash
   cd coauthor
   pip install -e .
   ```

7. **Put your OpenAI/ANTHROPIC API Key environment variable**:

   ```bash
   export OPENAI_API_KEY="your_openai_api_key"
   export ANTHROPIC_API_KEY="your_anthropic_api_key"
   ```

## Extension Settings

Include if your extension adds any VS Code settings through the `contributes.configuration` extension point.

For example:

This extension contributes the following settings:

- `myExtension.enable`: Enable/disable this extension.
- `myExtension.thing`: Set to `blah` to do something.

Users can customize the included directories by modifying their VS Code settings, either in the UI or in their settings.json file:

```json
{
  "coauthor.includedDirectories": ["Discrete-Time", "FiguresEx", "AnotherDirectory"]
}
```

## Commands

CoAuthor provides several commands that can be accessed via the command palette:

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

## Known Issues

Calling out known issues can help limit users opening duplicate issues against your extension.

---

## Following extension guidelines

Ensure that you've read through the extensions guidelines and follow the best practices for creating your extension.

- [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)
