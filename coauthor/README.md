# CoAuthor Backend

This is the backend component of the CoAuthor project, a Python package containing utility functions for copiloting with large language models (LLMs) like Anthropic's Claude AI and OpenAI's GPT for academic research.

## Detailed Features

- AI-assisted text processing and generation for various tasks
- LaTeX document processing, including diff functionality
- Automatic figure and TikZ extraction
- Multiple file support for complex projects
- Version control integration
- Customizable prompts and settings

## Installation

For quick installation, refer to the [main README](../README.md).

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

### Configuring Global Git Ignore

We recommend adding the contents of `.gitignore.sample` to your global Git ignore file. This helps prevent unnecessary files from being tracked across all your Git repositories. Here's how to do it:

1. First, check if you already have a global gitignore file:

   ```bash
   git config --global core.excludesfile
   ```

2. If you don't have one, create it:

   ```bash
   touch ~/.gitignore_global
   git config --global core.excludesfile ~/.gitignore_global
   ```

3. Append the contents of `.gitignore.sample` to your global gitignore:

   ```bash
   cat .gitignore.sample >> ~/.gitignore_global
   ```

This will ensure that the files and patterns listed in `.gitignore.sample` are ignored across all your Git repositories, helping to keep your commits clean and focused on relevant changes.

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
- Associated prompt files (e.g., system prompts, user prompts) are stored in XML format in subdirectories within the `tasks` directory, named after the task (e.g., `tasks/article`, `tasks/lecture`). These XML files contain the prompts that guide the AI model in generating outputs for the task.

### Adding New Tasks

To add a new task:

1. Create a new Python file in the `tasks` directory (e.g., `new_task.py`).
2. Define the task logic, following the structure of existing tasks.
3. Create a new subdirectory in `tasks` for your task's prompt files (e.g., `tasks/new_task`).
4. Add necessary prompt files in XML format (e.g., `prompts.xml`).
5. Update the CLI interface in `coauthor/cli.py` to include your new task.

### Modifying Prompts

To modify existing prompts:

1. Navigate to the appropriate subdirectory in `tasks` (e.g., `tasks/article` for article-related tasks).
2. Edit the relevant XML prompt files (e.g., `prompts.xml`).
3. Your changes will be automatically picked up by the task scripts when they load the prompts.

Remember to follow the existing XML structure and conventions when adding new tasks or modifying prompts. This ensures consistency and makes it easier for others to understand and maintain the codebase.

### Prompt Inheritance

CoAuthor supports a hierarchical structure for prompts, allowing child prompts to inherit from parent prompts. This feature promotes code reuse and makes it easier to create specialized versions of existing tasks. Here's how it works:

1. In the child XML file, use the `inherits` attribute in the `<task>` tag to specify the parent task.
2. The child prompt will inherit all settings and prompts from the parent.
3. You can override or add to the inherited content in the child prompt file.

For example, let's look at how `prompts_polish_with_auxiliary.xml` inherits from `prompts_polish.xml`:

Parent prompt (`prompts_polish.xml`):

```xml
<task name="polish">
  <settings>
    <!-- Parent settings -->
  </settings>
  <prompts>
    <system_prompt>
      <!-- Parent system prompt -->
      You are a computer scientist
    </system_prompt>
    <user_prefix>
      <!-- Parent user prefix -->
    </user_prefix>
    ...
  </prompts>
</task>
```

Child prompt (`prompts_polish_physics.xml`):

```xml
<task name="polish_physicist" inherits="polish">
  <settings>
    <!-- Child settings -->
  </settings>
  <prompts>
    <system_prompt>
      <!-- Child system prompt -->
      You are a physicist.
    </system_prompt>
  </prompts>
</task>
```

In this example, `prompts_polish_with_auxiliary.xml` inherits the settings and prompts from `prompts_polish.xml` but uses its own sysmtem prompts. This inheritance mechanism allows you to create specialized versions of tasks while reusing most of the existing prompt structure.

## Task Execution Logic

CoAuthor's task execution follows a sophisticated process inspired by advanced AI reasoning techniques such as Chain of Thought (CoT) and Reasoning and Acting (ReAct). This approach allows for more nuanced, multi-step problem solving and self-correction.

### Basic Execution Flow

1. **Input Processing**: The program reads the input file and any additional files specified (e.g., auxiliary files, figure inputs).

2. **Initial Generation**: Based on the task type and input, the AI model generates an initial output. This output is saved as the first version of the result.

3. **Continuation Handling**: If the initial generation is incomplete (e.g., due to token limits), the program automatically continues the generation in chunks. Each chunk is appended to the output file, ensuring a cohesive final result.

4. **Output Files**: Several files are generated during this process:
   - Main output file (e.g., `input_file_task_model.tex`)
   - Log file (e.g., `input_file_log.txt`) containing execution details and statistics

### Reflection Mechanism

If the `--reflect` option is enabled, CoAuthor implements a self-reflection step, similar to the introspection phase in ReAct:

1. **Reflection Generation**: After the initial output, the AI model reviews its work and generates reflections on potential improvements.

2. **Refinement**: Based on these reflections, the model produces a refined version of the output.

3. **Additional Output Files**:
   - Reflection output file (e.g., `input_file_task_reflect_model.tex`)
   - Updated log file with reflection statistics

This reflection process embodies the principle of Chain of Thought, allowing the AI to explicitly reason about its own output and make improvements.

### LaTeX Diff Generation

To facilitate easy comparison between versions, CoAuthor automatically generates LaTeX diff files:

1. **Initial Diff**: A diff between the original input and the first output is generated (e.g., `input_file_task_model_diff.tex`).

2. **Reflection Diff**: If reflection is enabled, additional diffs are created:
   - Between the original input and the reflected output
   - Between the initial output and the reflected output

These diff files use `latexdiff` to highlight changes, making it easy for users to review modifications.

### Design Principles

The multi-stage execution process in CoAuthor, including the reflection mechanism, is inspired by advanced AI reasoning frameworks:

1. **Chain of Thought (CoT)**: By allowing the AI to generate, then reflect, and then refine, we implement a form of explicit reasoning. This mimics the CoT approach, where intermediate steps of thinking are made explicit, leading to more accurate and thoughtful outputs.

2. **ReAct (Reasoning and Acting)**: The reflection stage is analogous to the "Reflect" step in the ReAct framework. It allows the AI to introspect on its own output, identify potential issues or improvements, and then act on those reflections in the refinement stage.

3. **Iterative Refinement**: The continuation handling and reflection processes implement a form of iterative refinement, allowing the AI to build upon and improve its initial outputs.

This design allows CoAuthor to produce more thoughtful, accurate, and refined outputs, especially for complex tasks like academic writing and LaTeX document processing.

## Advanced Features

### Figure and TikZ Extraction

CoAuthor can automatically extract and process figures from your LaTeX documents:

- Use `--auto_extract_figure` to automatically extract figure paths from the input file.
- Use `--auto_extract_tikz_figure` to extract and compile TikZ figures from the input file.

Example:

```bash
coauthor polish-tex --input_file your_file.tex --auto_extract_figure --auto_extract_tikz_figure
```

### Multiple Input Files

For complex projects, CoAuthor supports processing multiple input files:

```bash
coauthor polish-tex --input_file main.tex --input_files chapter1.tex,chapter2.tex
```

### Tex Count Integration

CoAuthor can provide LaTeX document statistics using the `texcount` tool:

```bash
coauthor tex-count your_file.tex
```

This command will output statistics like word count, number of headers, number of floats, etc.

## Task-Specific Features

### Meeting Transcription (meeting2text)

CoAuthor can improve and structure meeting transcripts:

```bash
coauthor meeting2text --input_file transcript.txt --context_file context.txt
```

The `context_file` should contain information about the meeting participants and topic.

### Paper to Lecture Notes Conversion (paper2note)

Convert research papers into lecture notes:

```bash
coauthor paper2note --input_file paper.tex --sample_chapters chapter1.tex,chapter2.tex --sample_paper sample_paper.tex --sample_note sample_note.tex
```

### Slide to Paper Conversion (slide2paper)

Convert presentation slides into a research paper format:

```bash
coauthor slide2paper --input_file draft.tex --figure_inputs slides.pdf
```

This task takes slide images or a PDF of a presentation (specified by `--figure_inputs`) and generates a comprehensive LaTeX research paper. The `--input_file` can be an existing draft of the paper or an empty file. It expands on key points from the slides, incorporating additional details, explanations, and mathematical formulations. The output is a well-structured, publication-ready LaTeX document.

Additional specific instructions for this task can be found in the `prompts_slide2paper.xml` file in the appropriate task directory.

### Paper to Slide Conversion (paper2slide)

Convert research paper into a LaTeX Beamer presentation:

```bash
coauthor paper2slide --input_file paper.tex
```

This task takes a LaTeX research paper as input and creates a professional LaTeX Beamer presentation. It condenses the paper's content into a series of slides, focusing on key points, methodology, results, and conclusions. The output is a LaTeX Beamer document ready for academic presentations.

Additional specific instructions for this task can be found in the `prompts_paper2slide.xml` file in the appropriate task directory.

## Version Control Integration

CoAuthor integrates with version control systems:

- Use `coauthor latexdiff input.tex edited.tex` to generate a diff between two LaTeX files.
- Use `coauthor latexdiff-vc input.tex commit_hash` to generate a diff against a specific git commit.

## Cleaning and Packing

CoAuthor provides utilities for cleaning up and packing your work:

- `coauthor clean-output`: Cleans up output files.
- `coauthor clean-build`: Cleans up build directories.
- `coauthor pack-single input.tex --task polish --model opus`: Packs the output files for a specific task into a versioned folder.

## Environment Variables

CoAuthor uses the following environment variables:

- `OPENAI_API_KEY`: Your OpenAI API key
- `ANTHROPIC_API_KEY`: Your Anthropic API key
- `MODEL`: Default model to use (e.g., "opus", "gpt4o")
- `PROMPT_DIR`: Directory containing prompt files
- `LATEXINDENT_CONFIG`: Path to custom latexindent configuration file

These can be set in your `.env` file or your system's environment variables.

## Code Structure

The main logic for CoAuthor is distributed across several Python files:

- `coauthor/cli.py`: Defines the command-line interface
- `coauthor/process.py`: Contains the core logic for processing tasks
- `coauthor/model_utils.py`: Utilities for interacting with AI models
- `coauthor/file_utils.py`: File handling utilities
- `coauthor/tex_tools.py`: LaTeX-specific utilities

Task-specific logic is contained in individual files in the `tasks/` directory, such as `tasks/edit_tex.py`, `tasks/prl_reply.py`, etc.

## Extending CoAuthor

To add a new task to CoAuthor:

1. Create a new Python file in the `tasks/` directory
2. Define your task logic, following the pattern in existing task files
3. Add necessary prompt files in XML format in a subdirectory of `tasks/`

## Known Issues

- If your frontend version is older than 0.5.6, you need to uninstall and reinstall the extension due to a change in the creator's name.
- Make sure your VS code installation is newer than 1.89.0.
