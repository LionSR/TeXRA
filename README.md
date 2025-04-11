# TeXRA: Your Favourite and Intelligent TeXRA for Academic Research

TeXRA is a powerful VS Code extension designed to help frustrated academics with their writing and research by leveraging the power of large language models (LLMs). It provides a seamless AI-assisted writing experience through an intuitive interface integrated directly into VS Code.

See [texra.ai](https://texra.ai). For detailed guides and usage instructions, visit the [**Full Documentation Site**](https://texra.ai/docs/).

## UI Features

- Enhanced file selection interface with improved multiple file selection and management
- Streamlined agent execution process with clearer options and feedback
- Improved error handling and user notifications for a smoother experience
- Automatic adaptation to VS Code's light and dark themes, ensuring a consistent and comfortable viewing experience
- Integrated LaTeX support with intelligent document processing
- Built-in version control features including LaTeX diff functionality
- Advanced PDF and image handling capabilities:
  - PDF page counting and conversion to images
  - Image encoding and processing
  - Support for various image formats (PNG, JPG, SVG, etc.)
- LaTeX-specific tools:
  - Automatic document indentation
  - Word and element counting (text, headers, captions, math)
  - Smart merging of included files
- YAML and XML configuration support
- Git integration for version control

## Architecture

TeXRA is built as a TypeScript-based VS Code extension that provides:

- Multiple AI agent support: correct, polish, draw, adapt, and more
- LaTeX document processing and enhancement
- Automatic figure and TikZ extraction
- Version control integration (latexdiff functionality)
- Customizable prompts and settings
- Direct integration with OpenAI and Anthropic APIs

## Installation Guide

1. Open VS Code
2. Download the newest release (`.vsix` file, e.g., `texra-0.28.0.vsix`) from the release page of the Github repo
3. Find the newest `.vsix` file in the VS Code file explorer
4. Right-click on the `.vsix` file
5. From the context menu, select "Install Extension VSIX"
6. Configure your API keys in VS Code settings:
   - OpenAI API key
   - Anthropic API key

## Required Dependencies

TeXRA requires several system dependencies for full functionality. See the [**Installation Guide**](https://texra.ai/docs/guide/installation.html) in the full documentation for detailed setup instructions for your operating system.

### LaTeX Distribution

- Install a LaTeX distribution:
  - Windows:
    - MiKTeX ([download](https://miktex.org/download)) or
    - TeX Live ([download](https://tug.org/texlive/windows.html))
  - macOS: MacTeX ([download](https://www.tug.org/mactex/mactex-download.html))
  - Linux: TeX Live (`sudo apt-get install texlive-full` for Ubuntu)

### Perl

- Required for LaTeX tools and document processing
- Windows: Included with MiKTeX
- macOS: Pre-installed
- Linux: Install via package manager (`sudo apt-get install perl` for Ubuntu)

### GraphicsMagick/ImageMagick & Ghostscript (Optional Fallbacks)

These tools are primarily used as a fallback for converting PDF pages to images if you use AI models **without** native PDF support. They may also be used for other less common image processing tasks.

- **GraphicsMagick (Recommended)** or **ImageMagick**: For image manipulation.
- **Ghostscript**: Required by GraphicsMagick/ImageMagick for PDF processing.

See the [Installation Guide](https://texra.ai/docs/guide/installation.html) for setup details if needed.

After installing these dependencies, ensure they are accessible from the command line by adding them to your system's PATH environment variable if necessary.

## Basic Usage

1. Open a LaTeX or text file in VS Code
2. Access the TeXRA sidebar (look for the logo icon in the Activity Bar)
3. Select your desired agent (e.g., polish, correct, draw)
4. Choose your input file(s) and any additional options
5. (Optional) Select auxiliary files or figures
6. Choose your preferred AI model
7. Write specific instructions for the agent (vague requests like "make it better" can lead to unpredictable results!).
8. Click "Execute" to run the AI-assisted agent
9. Review the output in the newly created file

Although many models are supported, we recommend using Anthropic sonnet\*/opus or O1/O3-series or Gemini 2 Flash/Thinking model for the best experience.

## Available AI Agents

TeXRA provides agents optimized for various academic tasks. Some core examples include:

- `correct`: Fix typos, grammatical errors, and LaTeX syntax issues.
- `polish`: Improve writing style, clarity, and flow.
- `draw`: Create or enhance TikZ figures from descriptions.
- `paper2slide`: Convert research papers into presentation slides.
- `paper2note`: Transform papers into structured lecture notes.

See the [**Built-in Agents Guide**](https://texra.ai/docs/guide/built-in-agents.html) for the full default list and detailed descriptions.

This list can also be customized in the VS Code settings.

## Customization

TeXRA offers various customization options through VS Code settings:

- Configure available AI agents and their parameters
- Adjust included directories and file types
- Fine-tune prompts for specific agents
- Customize model parameters like temperature and max tokens
- Set up output directories and file handling preferences

## Advanced Features

- Multi-file processing for complex projects
- Automatic TikZ figure extraction and compilation
- LaTeX diff functionality for version comparison
- Git integration for accessing recent commits
- Intelligent document merging with conflict resolution
- Custom prompt templates for specialized tasks
- PDF processing capabilities:
  - Convert PDFs to high-quality images
- LaTeX document analysis:
  - Word count statistics
- File organization tools:
  - Automatic build directory management
  - Smart file backup and versioning
  - Cross-platform path handling

## Support & Feedback

Encountering issues or have suggestions? Please report them on our [**GitHub Issues page**](https://github.com/texra-ai/texra-issues/issues).

## License

Before the author(s) have figured out the best way to use and distribute TeXRA and its potential academic value and social impact, the code is under private license.

© [TeXRA Team] [2025]. All rights reserved.
This repository and its contents are proprietary and confidential.
Unauthorized copying, distribution, or use is strictly prohibited.
