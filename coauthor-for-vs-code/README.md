# CoAuthor Frontend (VS Code Extension)

This is the frontend component of the CoAuthor project, a Visual Studio Code extension that provides a user-friendly interface for interacting with the CoAuthor backend.

## Features

- File selection for input, auxiliary, and figure files
- Task and model selection
- Execution of CoAuthor commands directly from VS Code
- LaTeX diff visualization
- Housekeeping operations (clean output, clean build, indent TeX)
- Customizable settings
- **Adaptive Theming**: CoAuthor now automatically adapts to VS Code's light and dark themes, ensuring a consistent and comfortable viewing experience.

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

CoAuthor frontend provides several commands that can be accessed via the command palette (Ctrl+Shift+P or Cmd+Shift+P on macOS) or through the CoAuthor sidebar.

### File Selection

CoAuthor supports multiple file inputs for various file types:

1. **Input Files**: You can select multiple input files for tasks that require it.
2. **Sample Files**: For tasks that use reference or sample files.
3. **Auxiliary Files**: Additional files needed for the task.
4. **Figure Files**: Image files to be included in the document.

For each file type, you can:

- Select multiple files using the "Multiple" button
- Remove individual files by clicking the "-" button next to each file
- Reorder files by dragging and dropping them in the list

This flexible file selection system allows you to easily manage complex projects with multiple related files.

### Specific Instructions

The "Specific Instructions" text area allows you to provide detailed instructions for the AI model. These instructions are not just passed along verbatim; instead, they are carefully analyzed and expanded upon by the model. The AI will:

1. Interpret your instructions in the context of the selected task
2. Break down complex instructions into manageable steps
3. Apply relevant domain knowledge to enhance the execution of your instructions
4. Generate a detailed plan of action before making any changes to your document

This process ensures that your instructions are carried out thoroughly and intelligently, often leading to more comprehensive and nuanced results than you might have initially envisioned.

### Buttons and Controls

The CoAuthor sidebar provides several buttons and controls for easy interaction:

1. **Task Selection**: Choose the specific task you want to perform (e.g., correct-tex, polish-tex, draw-tex).
2. **Model Selection**: Select the AI model to use for the task (e.g., Sonnet+, Opus, GPT-4).
3. **Reflect**: Toggle whether the AI should perform a reflection step after the initial task.
4. **Execute**: Run the selected task with the chosen settings and files.
5. **Current**: Quickly select the currently open file as the input file.
6. **Empty**: Clear the current selection for multiple files.
7. **Multiple**: Open a file picker to select multiple files.

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
  "draw-st",
  "paper2slide",
  "slide2paper"
]
```

### Extension Settings

Users can customize the included directories by modifying their VS Code settings:

```json
{
  "coauthor.includedDirectories": ["Discrete-Time", "FiguresEx", "AnotherDirectory"]
}
```

## Housekeeping Operations

The CoAuthor VS Code extension provides a user-friendly interface for performing housekeeping operations on your LaTeX projects. These operations are designed to work seamlessly with all CoAuthor features, including the Intelligent Merge functionality.

### Clean Single

The "Clean Single" operation removes output files associated with a specific input file, task, and model. It handles both normal output and intelligent merge output.

To use this feature:

1. Select your input file in the CoAuthor sidebar
2. Choose the task and model
3. Click the "Clean" button in the "Housekeeping" section

### Pack Single

The "Pack Single" operation collects output files associated with a specific input file, task, and model, and moves them to a versioned folder. It also handles both normal output and intelligent merge output.

To use this feature:

1. Select your input file in the CoAuthor sidebar
2. Choose the task and model
3. Click the "Pack" button in the "Housekeeping" section

### Clean Output Files

This operation removes all output files in the current directory. To use it, click the "Clean Output" button in the CoAuthor sidebar.

### Clean Build Files

This operation cleans up build directories. To use it, click the "Clean Build" button in the CoAuthor sidebar.

### Indent TeX

This operation runs the `latexindent` tool on your TeX files to improve formatting. Click the "Indent TeX" button to use this feature.

### LaTeX Diff Operations

CoAuthor provides powerful diff functionality to compare different versions of your LaTeX documents:

1. **LaTeX Diff**: Generate a diff between two LaTeX files. Select an input file and an edited file, then click the "latexdiff" button.
2. **LaTeX Diff VC**: Generate a diff against a specific git commit. Select an input file and a commit hash, then click the "latexdiff-vc" button.
3. **Pack/Clean LaTeX Diff VC**: Pack or clean the files generated from latexdiff-vc. Use the "Pack" or "Clean" buttons in the LaTeX Diff VC section.

### Merge Operation

The "Merge" button allows you to intelligently merge changes from an edited file back into the original file. This feature is particularly useful when working with AI-generated edits or collaborating with others.

All these operations use a flexible file pattern system to ensure they catch all relevant files, including those generated by the intelligent merge feature. This ensures that your working directory remains clean and organized, regardless of the complexity of your LaTeX project or the number of merge operations performed.

These features can be particularly useful when working with complex projects or after performing multiple intelligent merge operations, helping you maintain a clean and efficient workspace.
