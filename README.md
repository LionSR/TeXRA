# TeXRA: Your Favourite and Intelligent TeXRA for Academic Research

TeXRA is a powerful VS Code extension designed to help frustrated academics with their writing and research by leveraging the power of large language models (LLMs). It provides a seamless AI-assisted writing experience through an intuitive interface integrated directly into VS Code.

See [PHILOSOPHY.md](PHILOSOPHY.md).

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
2. Download the newest release (`.vsix` file, e.g., `texra-0.5.6.vsix`) from the release page of the Github repo
3. Find the newest `.vsix` file in the VS Code file explorer
4. Right-click on the `.vsix` file
5. From the context menu, select "Install Extension VSIX"
6. Configure your API keys in VS Code settings:
   - OpenAI API key
   - Anthropic API key

## Required Dependencies

TeXRA requires several system dependencies for full functionality:

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

### GraphicsMagick/ImageMagick

Required for PDF and image processing. Install either GraphicsMagick (recommended) or ImageMagick:

#### GraphicsMagick (Recommended)

- Windows: [Download from GraphicsMagick website](http://www.graphicsmagick.org/download.html)
- macOS: `brew install graphicsmagick`
- Linux: `sudo apt-get install graphicsmagick`

#### ImageMagick (Alternative)

- Windows: [Download from ImageMagick website](https://imagemagick.org/script/download.php). Check [detailed installation guide](https://github.com/yakovmeister/pdf2image/blob/HEAD/docs/gm-installation.md#user-content-fn-1-f7f37a073c154c15b8ec0322771634a3).
- macOS: `brew install imagemagick`
- Linux: `sudo apt-get install imagemagick`

### Ghostscript

Required by GraphicsMagick/ImageMagick for PDF processing:

- Windows: [Download from Ghostscript website](https://ghostscript.com/releases/gsdnld.html) You might have to install version 9.52 from [https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/tag/gs952](https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/tag/gs952)
- macOS: `brew install ghostscript`
- Linux: `sudo apt-get install ghostscript`

After installing these dependencies, ensure they are accessible from the command line by adding them to your system's PATH environment variable if necessary.

## Basic Usage

1. Open a LaTeX or text file in VS Code
2. Access the TeXRA sidebar (look for the scholarly duck icon in the Activity Bar)
3. Select your desired agent (e.g., polish, correct, draw)
4. Choose your input file(s) and any additional options
5. (Optional) Select auxiliary files or figures
6. Choose your preferred AI model
7. Click "Execute" to run the AI-assisted agent
8. Review the output in the newly created file

Although many models are supported, we recommend using Anthropic sonnet\*/opus or O1/O3-series or Gemini 2 Flash/Thinking model for the best experience.

## Available AI Agents

TeXRA supports a variety of intelligent agents, including but not limited to:

- `correct`: Fix typos and minor errors in LaTeX documents
- `polish`: Improve the writing style and clarity of LaTeX documents
- `draw`: Create or enhance TikZ figures in LaTeX documents
- `write`: Generate new LaTeX content based on instructions
- `meeting2text`: Convert meeting transcripts into structured text
- `paper2note`: Transform research papers into lecture notes
- `txt2tex`: Convert plain text to LaTeX format
- `merge`: Merge LaTeX documents intelligently, ensuring consistency and handling conflicts
- `slide2paper`: Convert presentation slides into a research paper format
- `paper2slide`: Convert research paper into a latex beamer presentation slides

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

## Recommended Settings

To reduce clutter, configure LaTeX-workshop's output directory:

1. In VS Code settings, search for "Latex-workshop: Out Dir"
2. Set to `%DIR%/build`

This directs all LaTeX output files to a `build` subdirectory. Works with relative/absolute paths from the root file. No trailing slash needed.

**Note:** Default for `latexmk` users. The extension auto-detects output directory from LaTeX tool arguments. Recommend adding `-pdf` and `-f` to the latexmk command:

```json
"latex-workshop.latex.magic.args": [
  "-synctex=1",
  "-interaction=nonstopmode",
  "-file-line-error",
  "%DOC%",
  "-pdf",
  "-f"
]
```

## Syncing Across Computers

For users working on multiple computers, we recommend using a cloud storage service like Dropbox to sync the following folders:

- Log: Contains thinking logs and other processing information
- Diffs: Stores difference files generated by LaTeX diff functionality
- History: Keeps track of different versions of your documents

To maintain your local directory structure while syncing these folders, we suggest using soft links. This approach allows you to store the actual folders in Dropbox while creating symbolic links in your local project directory. For example:

```bash
ln -s /path/to/Dropbox/texra-papers/ProjectName/Diffs /path/to/local/ProjectName
ln -s /path/to/Dropbox/texra-papers/ProjectName/History /path/to/local/ProjectName
```

Replace `/path/to/Dropbox` and `/path/to/local` with your actual Dropbox and local project paths.

## License

Before the author(s) have figured out the best way to use and distribute TeXRA and its potential academic value and social impact, the code is under private license.

© [Sirui Lu] [2024]. All rights reserved.
This repository and its contents are proprietary and confidential.
Unauthorized copying, distribution, or use is strictly prohibited.
