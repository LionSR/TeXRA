# CoAuthor Backend

This is the backend component of the CoAuthor project, a Python package containing utility functions for copiloting with large language models (LLMs) like Anthropic's Claude AI and OpenAI's GPT for academic research.

## Detailed Features

- AI-assisted text processing and generation for various agents
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
OPENROUTER_API_KEY=your_actual_openrouter_api_key_here
GOOGLE_API_KEY=your_actual_google_api_key_here
```

4. Optionally, you can change the default model or set a custom `LATEXINDENT_CONFIG` path.

This `.env` file will be automatically loaded when you run CoAuthor, providing the necessary API keys for the services.

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

CoAuthor provides various CLI commands for different tasks:

- Document Editing:

  - `coauthor run correct_tex`: Correct LaTeX documents
  - `coauthor run polish_tex`: Polish LaTeX documents
  - `coauthor run draw_tex`: Generate LaTeX drawings
  - `coauthor run convert_tex`: Convert LaTeX documents
  - `coauthor run ocr_tex`: OCR processing for LaTeX

- Document Conversion:

  - `coauthor run meeting2text`: Convert meeting transcripts to text
  - `coauthor run text2tex`: Convert text to LaTeX
  - `coauthor run txt2tex`: Convert text to LaTeX with templates
  - `coauthor run paper2note`: Convert papers to lecture notes
  - `coauthor run adapt`: Adapt text to different contexts
  - `coauthor run paper2poster`: Convert paper to poster
  - `coauthor run slide2paper`: Convert slides to paper
  - `coauthor run paper2slide`: Convert paper to slides
  - `coauthor run paper2cover`: Convert paper to cover letter
  - `coauthor run translate2chn`: Translate to Chinese

- Paper Tools:

  - `coauthor run correct_prl`: Correct PRL papers
  - `coauthor run polish_prl`: Polish PRL papers
  - `coauthor run revise_prl`: Revise PRL papers
  - `coauthor run draft_rebuttal_prl`: Draft PRL rebuttals
  - `coauthor run revise_rebuttal_prl`: Revise PRL rebuttals

- Writing Tools:

  - `coauthor run paper2referee`: Write referee reports
  - `coauthor run revise_referee_report`: Revise referee reports
  - `coauthor run statement`: Write academic statements
  - `coauthor run revise_nsf_grant`: Revise NSF grants
  - `coauthor run revise_marie_curie`: Revise Marie Curie grants

- Utility Tools:
  - `coauthor merge`: Merge LaTeX documents
  - `coauthor clean-output`: Clean output files
  - `coauthor clean-build`: Clean build directories
  - `coauthor clean-single`: Clean single agent output
  - `coauthor clean-multiple`: Clean multiple agent output
  - `coauthor pack-single`: Pack single agent output
  - `coauthor pack-multiple`: Pack multiple agent output
  - `coauthor indent-tex`: Indent LaTeX files
  - `coauthor latexdiff`: Compare LaTeX files
  - `coauthor latexdiff-vc`: Compare with git versions
  - `coauthor tex-count`: Count LaTeX statistics
  - `coauthor extract-figure-path`: Extract the list of figures
  - `coauthor extract-tikzpictures`: Extract TikZ pictures

Use `coauthor --help` for a full list of commands and their options.

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

## Agents and Prompts

CoAuthor's agents are defined in the `agents` directory. Each Agent typically has its own Python script and associated prompt files. Here's how the structure works:

### Agent Structure

- Each Agent is defined in a separate Python file in the `agents` directory (e.g., `article.py`, `lecture.py`, `merge.py`).
- These Python files define the main logic for each Agent, including argument parsing, file handling, and interaction with the AI model.
- Associated prompt files are stored in YAML format in subdirectories within the `agents` directory, named after the Agent (e.g., `agents/article`, `agents/lecture`).
- Each agent directory contains YAML files that define the prompts and configurations for different modes of operation.

### Adding New Agents

To add a new Agent:

1. Create a new Python file in the `agents` directory (e.g., `new_agent.py`).
2. Define the Agent logic, following the structure of existing agents.
3. Create a new subdirectory in `agents` for your Agent's prompt files (e.g., `agents/new_agent`).
4. Add necessary prompt files in YAML format (e.g., `prompts.yaml`, `config.yaml`).
5. Update the CLI interface in `coauthor/cli.py` to include your new Agent.

### Modifying Prompts

To modify existing prompts:

1. Navigate to the appropriate subdirectory in `agents` (e.g., `agents/article` for article-related agents).
2. Edit the relevant YAML prompt files.
3. Your changes will be automatically picked up by the Agent scripts when they load the prompts.

The YAML files typically contain:

- System prompts that define the agent's role and capabilities
- User message templates
- Configuration settings for the agent
- Any additional instructions or context needed by the agent

Example YAML structure:

```yaml
name: paper2cover
settings:
  documentTag: cover_letter
  endTag: </cover_letter>
  outputExt: tex
  prefills:
    - <scratchpad>
    - <scratchpad>

requiredFilesInternal:
  TEMPLATE_COVER_LETTER: template_cover_letter.txt

prompts:
  systemPrompt: |
    You are an expert academic writer. Your task is to...

  userPrefix: |
    I am going to give you a LaTeX document...

  userRequest: |
    Based on the document provided, please...

  userReflect: |
    Let's critically reflect on what we've written...
```

### Prompt Inheritance

CoAuthor supports a hierarchical structure for prompts, allowing child prompts to inherit from parent prompts. Here's how it works:

1. In the child YAML file, use the `inherits` field to specify the parent agent.
2. The child prompt will inherit all settings and prompts from the parent.
3. You can override or add to the inherited content in the child prompt file.

Example:

Parent prompt (`polish.yaml`):

```yaml
name: polish
settings:
  documentTag: polish
  outputExt: tex
prompts:
  systemPrompt: |
    You are a computer scientist and expert writer.
  userPrefix: |
    Polish this text:
```

Child prompt (`polish_physics.yaml`):

```yaml
name: polish_physics
inherits: polish
settings:
  documentTag: polish_physics # Override parent setting
prompts:
  systemPrompt: |
    You are a physicist and expert writer.
    # Other prompts are inherited from parent
```

This inheritance mechanism allows you to create specialized versions of agents while reusing most of the existing prompt structure.

## Agent Execution Logic

CoAuthor's Agent execution follows a sophisticated process inspired by advanced AI reasoning techniques such as Chain of Thought (CoT) and Reasoning and Acting (ReAct). This approach allows for more nuanced, multi-step problem solving and self-correction.

### Basic Execution Flow

1. **Input Processing**: The program reads the input file and any additional files specified (e.g., reference files, auxiliary files, figure inputs).

2. **Initial Generation**: Based on the Agent type and input, the AI model generates an initial output. This output is saved as the first version of the result.

3. **Continuation Handling**: If the initial generation is incomplete (e.g., due to token limits), the program automatically continues the generation in chunks. Each chunk is appended to the output file, ensuring a cohesive final result.

4. **Output Files**: Several files are generated during this process:
   - Main output file (e.g., `inputFile_agent_model.tex`)
   - Log file (e.g., `inputFile_log.txt`) containing execution details and statistics

### Reflection Mechanism

If the `--reflect` option is enabled, CoAuthor implements a self-reflection step, similar to the introspection phase in ReAct:

1. **Reflection Generation**: After the initial output, the AI model reviews its work and generates reflections on potential improvements.

2. **Refinement**: Based on these reflections, the model produces a refined version of the output.

3. **Additional Output Files**:
   - Reflection output file (e.g., `inputFile_agent_reflect_model.tex`)
   - Updated log file with reflection statistics

This reflection process embodies the principle of Chain of Thought, allowing the AI to explicitly reason about its own output and make improvements.

### LaTeX Diff Generation

To facilitate easy comparison between versions, CoAuthor automatically generates LaTeX diff files:

1. **Initial Diff**: A diff between the original input and the first output is generated (e.g., `inputFile_agent_model_diff.tex`).

2. **Reflection Diff**: If reflection is enabled, additional diffs are created:
   - Between the original input and the reflected output
   - Between the initial output and the reflected output

These diff files use `latexdiff` to highlight changes, making it easy for users to review modifications.

### Design Principles

The multi-stage execution process in CoAuthor, including the reflection mechanism, is inspired by advanced AI reasoning frameworks:

1. **Chain of Thought (CoT)**: By allowing the AI to generate, then reflect, and then refine, we implement a form of explicit reasoning. This mimics the CoT approach, where intermediate steps of thinking are made explicit, leading to more accurate and thoughtful outputs.

2. **ReAct (Reasoning and Acting)**: The reflection stage is analogous to the "Reflect" step in the ReAct framework. It allows the AI to introspect on its own output, identify potential issues or improvements, and then act on those reflections in the refinement stage.

3. **Iterative Refinement**: The continuation handling and reflection processes implement a form of iterative refinement, allowing the AI to build upon and improve its initial outputs.

This design allows CoAuthor to produce more thoughtful, accurate, and refined outputs, especially for complex agents like academic writing and LaTeX document processing.

## Advanced Features

### Common Flags

CoAuthor supports various flags that can be used with most commands:

- Model and Processing:

  - `--model`: Model to use (default: "sonnet+")
  - `--reflect`: Enable reflection round after initial processing
  - `--instruction`: Provide specific instructions for processing

- Input Files:

  - `--inputFile`: Path to the main input file
  - `--inputFiles`: Multiple input files (comma-separated)
  - `--referenceFile`: Path to a reference file
  - `--referenceFiles`: Multiple reference files (comma-separated)
  - `--auxiliaryFile`: Path to an auxiliary file
  - `--auxiliaryFiles`: Multiple auxiliary files (comma-separated)
  - `--figureFile`: Path to a figure file
  - `--figureFiles`: Multiple figure files (comma-separated)

- Output Control:

  - `--outputFiles`: Specify output file paths (comma-separated)
  - `--outputNameOverride`: Override the default output name
  - `--editedFile`: Path to a file that has already been edited

- Tool Usage:
  - `--usePrefillFromInput`: Use the prefill from the input file
  - `--autoExtractFigure`: Automatically extract figures from input
  - `--autoExtractTikzFigure`: Extract and compile TikZ figures
  - `--autoExtractTikzFigureReflect`: Include TikZ reflection
  - `--attachTeXCount`: Attach tex count statistics
  - `--autoConfirmation`: Automatically confirm model's questions
  - `--printInputPrompt`: Print the input prompt to an XML file

Example usage:

```bash
coauthor run polish_tex --inputFile paper.tex --reflect --autoExtractFigure --attachTeXCount
```

### Figure and TikZ Extraction

CoAuthor can automatically extract and process figures from your LaTeX documents:

- Use `--autoExtractFigure` to automatically extract the list of figures from the input file
- Use `--autoExtractTikzFigure` to extract and compile TikZ figures from the input file
- Use `--autoExtractTikzFigureReflect` to include TikZ reflection in the output
- Use `--attachTeXCount` to include the tex count statistics in the user message

Example:

```bash
coauthor run polish_tex --inputFile your_file.tex --autoExtractFigure --autoExtractTikzFigure
```

### Multiple Input Files

For complex projects, CoAuthor supports processing multiple input files:

```bash
coauthor run polish_tex --inputFile main.tex --inputFiles chapter1.tex,chapter2.tex
```

### Version Control Integration

CoAuthor integrates with version control systems:

- Use `coauthor latexdiff input.tex edited.tex` to generate a diff between two LaTeX files
- Use `coauthor latexdiff-vc input.tex commitHash` to generate a diff against a specific git commit

### Cleaning and Packing

CoAuthor provides utilities for cleaning up and packing your work:

- `coauthor clean-output`: Cleans up output files
- `coauthor clean-build`: Cleans up build directories
- `coauthor pack-single input.tex --agent polish --model opus`: Packs the output files for a specific Agent into a versioned folder

## Environment Variables

CoAuthor uses the following environment variables:

- `OPENAI_API_KEY`: Your OpenAI API key
- `ANTHROPIC_API_KEY`: Your Anthropic API key
- `OPENROUTER_API_KEY`: Your OpenRouter API key
- `GOOGLE_API_KEY`: Your Google API key
- `MODEL`: Default model to use (e.g., "opus", "gpt4o")
- `PROMPT_DIR`: Directory containing prompt files
- `LATEXINDENT_CONFIG`: Path to custom latexindent configuration file

These can be set in your `.env` file or your system's environment variables.

## Code Structure

The main logic for CoAuthor is distributed across several Python files:

- `coauthor/cli.py`: Defines the command-line interface
- `coauthor/process.py`: Contains the core logic for processing agents
- `coauthor/model_utils.py`: Utilities for interacting with AI models
- `coauthor/file_utils.py`: File handling utilities
- `coauthor/tex_tools.py`: LaTeX-specific utilities

Agent-specific logic is contained in individual files in the `agents/` directory, such as `agents/article.py`, `agents/lecture.py`, etc.

## Extending CoAuthor

To add a new Agent to CoAuthor:

1. Create a new Python file in the `agents/` directory
2. Define your Agent logic, following the pattern in existing Agent files
3. Add necessary prompt files in YAML format in a subdirectory of `agents/`

## Known Issues

- If your frontend version is older than 0.5.6, you need to uninstall and reinstall the extension due to a change in the creator's name
- Make sure your VS code installation is newer than 1.93.1
