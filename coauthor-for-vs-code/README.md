# Coauthor README

## Usage

CoAuthor provides a CLI with several commands for different tasks.

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

* `myExtension.enable`: Enable/disable this extension.
* `myExtension.thing`: Set to `blah` to do something.


Users can customize the included directories by modifying their VS Code settings, either in the UI or in their settings.json file:
```json
{
  "coauthor.includedDirectories": ["Discrete-Time", "FiguresEx", "AnotherDirectory"]
}
```

## Known Issues

Calling out known issues can help limit users opening duplicate issues against your extension.

## Release Notes

Users appreciate release notes as you update your extension.

### 0.4.3
- Added auto-extract figure option in VS Code extension
- Implemented automatic figure path extraction from LaTeX files
- Improved polish functionality with refined prompts and better figure handling
- Enhanced reflection process for polishing task
- Various minor improvements and bug fixes

### 0.4.2
- Streamlined TeX and ST processing by removing long versions of commands
- Merged polish_tex and polish_tex_long functionality
- Enhanced logging with summary statistics
- Added figure extraction and word count utility scripts
- Updated prompts for more detailed improvement plans
- Refactored model utility functions for better reusability
- Improved reflection process with more detailed action plans
- Added summary logging for both initial processing and reflection steps

## [0.4.1]

* small fixes to the execute button for the single auxiliary file case.

## [0.4.0]

* added the handling of multiple figures in the backend and make it works also in the frontend.

## [0.3.12]

* more fixes for selecting multiple input files and/or figures

## [0.3.11]

* fixes for selecting multiple input files and/or figures

## [0.3.10]

* UI optimizations

## [0.3.9]

* polish pass the multiple selected input files and/or figures to the backend: only show relative path if softlinks is encountered.

## [0.3.8]

* now possible to pass the multiple selected input files and/or figures to the backend

## [0.3.7]

* Added the possibility to select multiple input files and or figures, and display selected files in the extension UI (Activity Bar tab).
* Set the default open dialog for file selection to the same path of the select input file if it is set.

## [0.3.6]

* Set figure file to "None" and reflect to "False" when a task starting with "Correct" is selected.

## [0.3.5]

* increase the number of git commit message to show up to 20.
* handled softlinks folders

## [0.3.4]

* Added draw-tex and draw-st tasks in the backend and the UI.

## [0.3.3]

* Further Fixes to the clean-single function.

## [0.3.2]

* Fixed the clean-single function.

## [0.3.1]

* Safe housekeeping terminal.

## [0.3.0]

* A functional latexdiff/latexdiff-vs UI that automatically open the generated diff file

## [0.2.9]

* Added the latexdiff-vc button

## [0.2.8]

UI improvements and refresh button fix.

## [0.2.8]

UI improvements: 
* moved to using h3 for section headers and h4 for subsections.
* right-aligned the button for latexdiff and latexdiff-vc

## [0.2.7]

* added the latexdiff-vs button to diff with a version in the commit history 

## [0.2.6]

* small UI bump

## [0.2.5]

* added the automatic call to update the select revision file for latexdiff only for those that match the input.

## [0.2.4]

* handled the case when the housekeeping terminal is not available.

## [0.2.3]

* added the latexdiff button

## [0.2.2]

Quality of life improvements: 
* gave a name to the housekeeping terminal.
* ignored more files and directories when searching for files.
* tweaking the continuation mode for claude and GPTs on the backend side.


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



