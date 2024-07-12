# CoAuthor Backend

CoAuthor is a Python package containing utility functions for copiloting with large language models (LLMs) like Anthropic's Claude AI for academic research. It provides a command-line interface (CLI) to perform various text processing and generation tasks.

## Features

- AI-assisted text processing and generation for various tasks
- Command-line interface (CLI) for backend operations
- Support for LaTeX document processing, including diff functionality
- Automatic figure and TikZ extraction
- Multiple file support for complex projects
- Version control integration

## Installation

To install the CoAuthor backend, download the latest release and run

```bash
pip install -e .
```

After installation, you need to set up your API keys. Create a `.env` file in the root directory of the project using the provided `.env.sample` as a template:

1. Copy `.env.sample` to `.env`
2. Open `.env` in a text editor
3. Replace the placeholder values with your actual API keys:

  ```bash
  OPENAI_API_KEY=your_actual_openai_api_key_here
  ANTHROPIC_API_KEY=your_actual_anthropic_api_key_here
  ```

4. Optionally, you can change the default model or set a custom `LATEXINDENT_CONFIG` path.

This `.env` file will be automatically loaded when you run CoAuthor, providing the necessary API keys for OpenAI and Anthropic services.

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

## Customization

### latexindent

CoAuthor uses `latexindent` for formatting LaTeX files. You can customize its behavior by setting the `LATEXINDENT_CONFIG` environment variable in your `.env` file. This allows you to specify a custom configuration file for `latexindent`.

For example, you can create a `latexindent.yaml` file with your desired settings:

```yaml
lookForAlignDelims:
  align:
    delims: 1
    alignDoubleBackSlash: 0
    spacesAfterAmpersand: 0
    spacesBeforeDoubleBackSlash: 0
```

Then, in your `.env` file, set the path to this configuration:

```bash
LATEXINDENT_CONFIG=/path/to/your/latexindent.yaml
```

This will instruct `latexindent` to use your custom settings when formatting LaTeX files.

## Integration with VS Code Extension

CoAuthor backend can be seamlessly integrated with the CoAuthor VS Code extension for a more user-friendly interface. For information on installing and using the VS Code extension, please refer to the [CoAuthor Frontend README](coauthor-for-vs-code/README.md).

## Additional Recommendations

- Use a git client (e.g., Tower, GitHub Desktop) to track diffs in your git-tracked paper/lecture note folders.
- Install a full, complete, and local TeX Live distribution to use latexdiff, latexindent, and latexdiff-vc.

## Tasks and Prompts

CoAuthor's tasks are defined in the `tasks` directory. Each task typically has its own Python script and associated prompt files. Here's how the structure works:

### Task Structure

- Each task is usually defined in a separate Python file in the `tasks` directory (e.g., `edit_tex.py`, `edit_lecture.py`, `merge.py`).
- These Python files define the main logic for each task, including argument parsing, file handling, and interaction with the AI model.
- Associated prompt files (e.g., system prompts, user prompts) are stored in subdirectories within the `tasks` directory, named after the task (e.g., `tasks/article`, `tasks/lecture`).

### Adding New Tasks

To add a new task:

1. Create a new Python file in the `tasks` directory (e.g., `new_task.py`).
2. Define the task logic, following the structure of existing tasks.
3. Create a new subdirectory in `tasks` for your task's prompt files (e.g., `tasks/new_task`).
4. Add necessary prompt files (e.g., `system_prompt.txt`, `user_prefix.txt`, `user_request.txt`).
5. Update the CLI interface in `coauthor/cli.py` to include your new task.

### Modifying Prompts

To modify existing prompts:

1. Navigate to the appropriate subdirectory in `tasks` (e.g., `tasks/article` for article-related tasks).
2. Edit the relevant prompt files (e.g., `system_prompt_correct.txt`, `user_request_polish.txt`).
3. Your changes will be automatically picked up by the task scripts when they load the prompts.

Remember to follow the existing code structure and conventions when adding new tasks or modifying prompts. This ensures consistency and makes it easier for others to understand and maintain the codebase.

For any issues or feature requests related to the backend, please open an issue in the GitHub repository.
