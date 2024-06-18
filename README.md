# coauthor README

## Features

Describe specific features of your extension including screenshots of your extension in action. Image paths are relative to this README file.

For example if there is an image subfolder under your extension project workspace:

\!\[feature X\]\(images/feature-x.png\)

> Tip: Many popular extensions utilize animations. This is an excellent way to show off your extension! We recommend short, focused animations that are easy to follow.

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

* `myExtension.enable`: Enable/disable this extension.
* `myExtension.thing`: Set to `blah` to do something.

## Known Issues

Calling out known issues can help limit users opening duplicate issues against your extension.

## Release Notes

Users appreciate release notes as you update your extension.

## [0.2.1]

* Supported the pdf figure inputs.

## [0.2.0]

* Supported png and jpeg figure inputs.

## [0.1.9]

* Added a CleanSingle Button to clean up the generated file for the selected input.
* UI changes

## [0.1.8]

* Fixed the file filter to exclude certain files and directories

## [0.1.7]

* Fixed the passing of the reflection parameter to the backend

## [0.1.6]

* Fixed the bug that the model parameter is not passed to the backend correctly

## [0.1.5]

* Added hacks to process the scratchpad in the generated tex files

## [0.1.4]

* Created the Clean-Output Button
* Simplifies the execute logic

## [0.1.0]

* Added basic functionalities
* Initial release

---

## Following extension guidelines

Ensure that you've read through the extensions guidelines and follow the best practices for creating your extension.

* [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## Working with Markdown

You can author your README using Visual Studio Code. Here are some useful editor keyboard shortcuts:

* Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux).
* Toggle preview (`Shift+Cmd+V` on macOS or `Shift+Ctrl+V` on Windows and Linux).
* Press `Ctrl+Space` (Windows, Linux, macOS) to see a list of Markdown snippets.
