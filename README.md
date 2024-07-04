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

