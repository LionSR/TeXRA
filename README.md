# CoAuthor: Your Favourite and Intelligent Coauthor for academic research

CoAuthor is a tool designed to help frustrated academics with their writing and research by leveraging the power of large language models (LLMs). It consists of two main components working in tandem to provide a seamless AI-assisted writing experience: the front end VS code extension and the python back end.

## Philosophy and Approach

CoAuthor's development is driven by the author's observation that current large language models (LLMs) possess remarkable, yet often underutilized capabilities in scientific research and academic writing. These models, trained on vast corpora including the entirety of arXiv and outputs from mathematica, demonstrate an ability to understand, manipulate, and generate complex scientific content that extends far beyond simple algebra and solving brain twists.

From the perspective of CoAuthor's creator, current models already exhibit characteristics of Artificial General Intelligence (AGI) or even Artificial Super Intelligence (ASI). The challenge lies in effectively interfacing with and harnessing these capabilities. Traditional web interfaces like ChatGPT or Claude.ai often lead to shallow conversations that fail to fully exploit the models' potential, especially in academic contexts, due to:

1. Limited context windows and output cutoffs
2. Lack of integration with academic tools (e.g., LaTeX processors, diff generators)
3. Inability to handle multi-step reasoning processes effectively

CoAuthor addresses these limitations by implementing an approach inspired by AI expert Andrew Ng's framework for building AI agents, which includes four key design patterns:

1. Reflection: The LLM examines its own work to identify improvements.
2. Tool use: The LLM leverages external tools to gather information or process data.
3. Planning: The LLM develops and executes multi-step plans to achieve complex goals.
4. Multi-agent collaboration: Multiple AI agents work together to solve intricate problems.

Implementing the first three of the four patterns, CoAuthor employs an iterative process that mimics expert academic writing:

1. Analyze the original document and user instructions
2. Formulate a detailed plan in a "scratchpad"
3. Execute the plan, generating revised content
4. Review the changes through self-reflection
5. Refine the output based on this self-criticism

This process is crucial for producing high-quality academic content. For example, when transforming a research paper into lecture notes, CoAuthor:

- Analyzes the paper's structure and identifies key concepts

- Plans a pedagogical approach in the scratchpad

- Generates initial notes

- Reviews its work, identifying areas for improvement (e.g., clarity of explanations, need for additional examples)

- Refines the notes based on this self-criticism

Without reasonings, polishing a prose has an infinite number of possible answers, since different authors have different taste, and the model would just collapse to one of it that are far from what the user need or even simply output the input to be one the safe side.

CoAuthor's reflection mechanism, particularly effective with models like Anthropic's Claude trained using constitutional AI principles, enables sophisticated self-criticism. After generating output, the AI reviews its work, identifying potential improvements in areas such as argument structure, use of evidence, or mathematical rigor. This process often catches subtle errors or inconsistencies that might be missed in a single pass, significantly enhancing the quality of academic writing.

CoAuthor also integrates LLMs with specialized academic tools:

- latexdiff: For clear visualization of document changes
- latexindent: For consistent LaTeX formatting
- texcount: For document statistics

These integrations is critical for maximizing LLM performance in academic writing. By delegating formatting tasks to these tools, the LLM focuses its computational resources on substantive aspects like argument structure and logical flow. For instance, after generating a revised LaTeX document, CoAuthor automatically runs latexindent for consistent formatting and latexdiff to clearly visualize changes, streamlining the revision process. To see why this is helpful, I recommend seeing the oscar winning movie - everything everywhere all at once. It is a great movie that shows how one person can struggle if she is in different universes simulatenously.

Coauthor also leverages the long context windows of modern LLMs (200k tokens for Anthropic models, 128k for GPT-4 Turbo) to process entire research papers or book chapters in a single pass. For instance, when adapting a 50-page research paper, CoAuthor can analyze the entire document, ensuring consistent terminology and logical flow from introduction to conclusion. This is super difficult for human due to the limited short-term memory of the brain.

The multimodal capabilities of recent LLMs are integrated into CoAuthor, particularly for handling scientific figures. When working on a physics paper, for example, CoAuthor can analyze existing TikZ figures, suggest improvements based on the surrounding text, and generate new TikZ code to implement these changes. It can also write detailed captions that accurately describe the figure content and ensure consistency with the main text, a task that often requires deep understanding of the scientific content.

CoAuthor's intelligent merge feature showcases the advanced capabilities of models like GPT-4 Turbo and Claude 3.5 Sonnet in understanding and generating and applying diffs. When merging changes from multiple authors, the system can comprehend the context of each modification, resolve conflicts, and even suggest improvements that synthesize ideas from different sources.

By combining these advanced AI techniques with traditional academic research techniques and writing tools, CoAuthor aims to be a collaborative partner in the academic writing process. It's capable of understanding complex scientific concepts, providing insights, and continuously improving its output. For instance, when working on a theoretical physics paper, CoAuthor can suggest novel connections between different theories, propose experimental setups to test hypotheses, and even identify potential flaws in mathematical proofs (or even help you finish the proof!).

Looking forward, as LLMs continue to evolve, I anticipate CoAuthor's capabilities will expand further. The system is designed to easily incorporate advancements in AI, potentially leading to breakthroughs in how academic research is conducted. By accelerating the writing and revision process, enhancing interdisciplinary connections, and catching errors early, CoAuthor has the potential to significantly accelerate the pace of scientific discovery.

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

Although GPT models are supported, we recommend using sonnet+ or opus for the best experience.

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
- `merge-tex`: Merge LaTeX documents intelligently, ensuring consistency and handling conflicts

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
- **Intelligent Merge**: Automatically merges LaTeX documents, ensuring consistency and handling conflicts intelligently

For detailed information on these features, consult the respective backend and frontend READMEs.

## Recommended Settings

To reduce clutter, configure LaTeX-workshop's output directory:

1. In VS Code settings, search for "Latex-workshop: Out Dir"
2. Set to `%DIR%/build`

This directs all LaTeX output files to a `build` subdirectory. Works with relative/absolute paths from the root file. No trailing slash needed.

**Note:** Default for `latexmk` users. The extension auto-detects output directory from LaTeX tool arguments.

## Syncing Across Computers

For users working on multiple computers, we recommend using a cloud storage service like Dropbox to sync the following folders:

- Log: Contains thinking logs and other processing information
- Diffs: Stores difference files generated by LaTeX diff functionality
- Versions: Keeps track of different versions of your documents

To maintain your local directory structure while syncing these folders, we suggest using soft links. This approach allows you to store the actual folders in Dropbox while creating symbolic links in your local project directory. For example:

```bash
ln -s /path/to/Dropbox/coauthor-papers/ProjectName/Diffs /path/to/local/ProjectName
ln -s /path/to/Dropbox/coauthor-papers/ProjectName/Versions /path/to/local/ProjectName
```

Replace `/path/to/Dropbox` and `/path/to/local` with your actual Dropbox and local project paths.

This method ensures consistent access to your CoAuthor outputs and version history across all your work environments while maintaining your preferred local directory structure.
