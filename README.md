# CoAuthor: AI-Powered Academic Writing Assistant

CoAuthor is a tool designed to help frustrated academics with their writing by leveraging the power of large language models (LLMs). It consists of two main components working in tandem to provide a seamless AI-assisted writing experience.

## Components

### 1. CoAuthor Backend

A robust Python package that serves as the engine for AI-assisted text processing and generation. It interfaces with LLMs like OpenAI's GPT and Anthropic's Claude to perform a variety of academic writing tasks.

Key features:

- Multiple task support: correct, polish, draw, adapt, and more
- LaTeX document processing
- Automatic figure and TikZ extraction
- Version control integration (latexdiff functionality)
- Customizable prompts and settings

For detailed backend information, see the [CoAuthor Backend README](coauthor/README.md).

### 2. CoAuthor Frontend (VS Code Extension)

A user-friendly Visual Studio Code extension that provides an intuitive interface for interacting with the CoAuthor backend.

Key features:

- Easy file selection for input, auxiliary, and figure files
- Task and model selection
- Execution of CoAuthor commands directly from VS Code
- LaTeX diff visualization
- Housekeeping operations (clean output, clean build, indent TeX)

For detailed frontend information, see the [CoAuthor Frontend README](coauthor-for-vs-code/README.md).

## Quick Installation Guide

### Backend Installation

1. Ensure you have Python 3.9+ installed.
2. Clone the repository:

   ```bash
   git clone https://github.com/your-repo/coauthor.git
   cd coauthor
   ```

3. Install the package:

   ```bash
   pip install -e .
   ```

4. Set up your API keys:
   - Copy `.env.sample` to `.env`
   - Edit `.env` and add your OpenAI and Anthropic API keys

### Frontend Installation

1. Open VS Code.
2. Open the folder containing the CoAuthor extension (where the `releases` folder is located).
3. In the VS Code file explorer, navigate to the `releases` folder.
4. Find the newest `.vsix` file (e.g., `coauthor-0.5.6.vsix`).
5. Right-click on the `.vsix` file.
6. From the context menu, select "Install Extension VSIX".

For manual installation or development setup, refer to the [CoAuthor Frontend README](coauthor-for-vs-code/README.md).

## Basic Usage

1. Open a LaTeX or text file in VS Code
2. Access the CoAuthor sidebar (look for the unicorn icon in the Activity Bar)
3. Select your desired task (e.g., polish, correct, draw)
4. Choose your input file(s) and any additional options
5. (Optional) Select auxiliary files or figures
6. Choose your preferred AI model
7. Click "Execute" to run the AI-assisted task
8. Review the output in the newly created file

## Available Tasks

CoAuthor supports a variety of tasks, including but not limited to:

- `correct-tex`: Fix typos and minor errors in LaTeX documents
- `polish-tex`: Improve the writing style and clarity of LaTeX documents
- `draw-tex`: Create or enhance TikZ figures in LaTeX documents
- `adapt-tex`: Adapt existing LaTeX content to a new context or style
- `write-tex`: Generate new LaTeX content based on instructions
- `meeting2text`: Convert meeting transcripts into structured text
- `paper2note`: Transform research papers into lecture notes
- `txt2tex`: Convert plain text to LaTeX format

For a full list of tasks and their descriptions, refer to the backend and frontend READMEs.

## Customization

CoAuthor offers various customization options:

- Modify available tasks in VS Code settings
- Adjust included directories and file types
- Fine-tune prompts for specific tasks (see backend documentation)
- Configure model parameters like temperature and max tokens

## Advanced Features

- Multi-file processing for complex projects
- Automatic TikZ figure extraction and compilation
- LaTeX diff functionality for version comparison
- Integration with git for accessing recent commits

For detailed information on these features, consult the respective backend and frontend READMEs.
