# CoAuthor Backend

CoAuthor is a Python package containing utility functions for copiloting with large language models (LLMs) like Anthropic's Claude AI for academic research. It provides a command-line interface (CLI) to perform various text processing and generation tasks.

## Features

- AI-assisted text processing and generation for various tasks
- Command-line interface (CLI) for backend operations
- VS Code extension for seamless integration into your development environment
- Support for LaTeX document processing, including diff functionality
- Automatic figure and TikZ extraction
- Multiple file support for complex projects
- Version control integration

## Installation

To install the python backedn of CoAuthor, download the latest release and run

```bash
pip install -e .
```

Set `.env` to use the OpenAI and Anthropic API keys.

To ease the installation and usage of the front end + backend, we recommend using a git client such as tower or github desktop to track the diffs, and working on your papers/lecture notes in a git-tracked folder.

We also recommend installing locally a tex live distribution with latexdiff, latexindent, latexdiff-vs installed.

## Usage

### CLI Commands

CoAuthor provides various CLI commands for different tasks. Here are some examples:

- `coauthor correct-tex`: Correct LaTeX documents
- `coauthor polish-tex`: Polish LaTeX documents
- `coauthor draw-tex`: Generate LaTeX drawings
- `coauthor meeting2text`: Convert meeting transcripts to text
- `coauthor txt2tex`: Convert plain text to LaTeX
- `coauthor paper2note`: Convert research papers to lecture notes
- `coauthor merge`: Merge LaTeX documents

Use `coauthor --help` for a full list of commands and options.

### VS Code Extension

The VS Code extension provides a user interface for interacting with the CoAuthor backend. It includes features such as:

- File selection for input, auxiliary, and figure files
- Task selection (e.g., correct, polish, draw)
- Model selection
- Execution of CoAuthor commands
- LaTeX diff functionality
- Housekeeping operations (clean output, clean build, indent TeX)

### Customization

#### Customizing Tasks

CoAuthor allows you to customize the list of available tasks directly in your VS Code settings. This feature enables you to tailor the extension to your specific needs.

To customize the tasks:

1. Open VS Code Settings (File > Preferences > Settings or `Ctrl+,`).
2. Search for "CoAuthor" in the settings search bar.
3. Look for the "Coauthor: Tasks" setting.
4. Click on the pencil icon next to the setting to edit the task list.

The default task list looks like this:

```json
"coauthor.tasks": [
  "correct-tex",
  "polish-tex",
  "draw-tex",
  "adapt-tex",
  "write-tex",
  "meeting2text",
  "paper2note",
  "txt2tex"
]
```

You can add, remove, or modify tasks in this list. Each task is represented by a string that serves as both the task's value and label in the CoAuthor interface.

For example, if you want to add a new task for editing lecture notes, you could modify the list like this:

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
]
```

After saving your changes, the new task will appear in the CoAuthor task selection dropdown in the VS Code sidebar.

Remember to ensure that any custom tasks you add are supported by your CoAuthor backend implementation.