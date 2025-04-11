# Installation Guide

This guide will walk you through the process of installing TeXRA and all its dependencies to ensure optimal performance.

## System Requirements

TeXRA is designed to work on all major operating systems with the following minimum requirements:

- **Visual Studio Code**: Version 1.96.2 or newer
- **Operating System**: Windows, macOS, or Linux
- **Internet Connection**: Required for API access to language models

## Installing the Extension

### From VS Code Marketplace (Recommended)

The easiest way to install TeXRA is directly from the Visual Studio Code Marketplace:

1.  Open VS Code.
2.  Go to the Extensions view (click the square icon in the Activity Bar or press `Ctrl+Shift+X`).
3.  Search for "TeXRA".
4.  Find the extension published by "texra-ai".
5.  Click the "Install" button.
6.  Reload VS Code if prompted.

<a href="https://marketplace.visualstudio.com/items?itemName=texra-ai.texra" target="_blank" style="display: inline-block; background-color: #007ACC; color: white; padding: 8px 12px; text-decoration: none; border-radius: 4px; font-weight: bold; margin: 10px 0;">View on Marketplace</a>

## Installing Required Dependencies

Now for the slightly less fun part – making sure TeXRA has all the tools it needs to work its magic. TeXRA relies on several external tools to function properly. Follow the instructions for your operating system.

### LaTeX Distribution

::: tip IMPORTANT
A LaTeX distribution is required for TeXRA to properly process LaTeX documents.
:::

#### Windows

Install either:

- **MiKTeX**: Download and install from [miktex.org](https://miktex.org/download)
- **TeX Live**: Download and install from [tug.org/texlive/windows.html](https://tug.org/texlive/windows.html)

#### macOS

Install MacTeX:

- Download from [tug.org/mactex/mactex-download.html](https://www.tug.org/mactex/mactex-download.html)
- Or use Homebrew: `brew install --cask mactex`

#### Linux (Ubuntu/Debian)

Install TeX Live:

```bash
sudo apt-get update
sudo apt-get install texlive-full
```

### Perl

::: info
Perl is required for LaTeX tools and document processing.
:::

#### Windows

- Included with MiKTeX or TeX Live
- Verify installation by running `perl --version` in Command Prompt

#### macOS

- Pre-installed
- Verify with `perl --version` in Terminal

#### Linux

```bash
sudo apt-get install perl
```

### GraphicsMagick/ImageMagick

::: tip RECOMMENDED
GraphicsMagick is the recommended option for better performance.
:::

#### GraphicsMagick

**Windows**:

- Download from [GraphicsMagick website](http://www.graphicsmagick.org/download.html)
- Add installation directory to PATH

**macOS**:

```bash
brew install graphicsmagick
```

**Linux**:

```bash
sudo apt-get install graphicsmagick
```

#### ImageMagick (Alternative)

**Windows**:

- Download from [ImageMagick website](https://imagemagick.org/script/download.php)
- Follow the [detailed installation guide](https://github.com/yakovmeister/pdf2image/blob/HEAD/docs/gm-installation.md)

**macOS**:

```bash
brew install imagemagick
```

**Linux**:

```bash
sudo apt-get install imagemagick
```

### Ghostscript

::: warning REQUIRED
Ghostscript is required by GraphicsMagick/ImageMagick for PDF processing.
:::

#### Windows

- Download from [Ghostscript website](https://ghostscript.com/releases/gsdnld.html)
- For compatibility issues, you might need to install version 9.52 from [this link](https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/tag/gs952)

#### macOS

```bash
brew install ghostscript
```

#### Linux

```bash
sudo apt-get install ghostscript
```

## Setting Up API Keys

TeXRA requires API keys to access language models. Here's how to set them up:

1. Open VS Code with TeXRA installed
2. Click on the TeXRA icon in the Activity Bar
3. Click "Set API Key" in the TeXRA panel
4. Select the provider (OpenAI or Anthropic)
5. Enter your API key when prompted

![API Key Setup](/images/api-key-setup.png)

::: info Getting API Keys

- **OpenAI API Key**: Available from [OpenAI API](https://platform.openai.com/api-keys)
- **Anthropic API Key**: Available from [Anthropic Console](https://console.anthropic.com/)
- **Google API Key**: Available from [Google AI Studio](...)
  :::

## Verifying Installation

To verify that TeXRA and all dependencies are correctly installed:

1. Open VS Code
2. Click on the TeXRA icon in the Activity Bar
3. The TeXRA panel should load without errors
4. Create or open a LaTeX document
5. Try a simple command like "Indent Current TeX" from the editor title menu

If any component is missing, TeXRA will typically show an error message indicating what needs to be installed.

## Optimizing Your Setup

### Setting Up VS Code

For optimal use with TeXRA:

1. Move TeXRA to the secondary sidebar:

   - Open VS Code's Command Palette (Ctrl+Shift+P or Cmd+Shift+P on macOS)
   - Run "View: Toggle Secondary Side Bar Visibility" (or use Alt+Cmd+B on macOS)
   - Drag the TeXRA view from the primary sidebar to the secondary sidebar

2. Configure LaTeX Workshop (if installed):
   - In VS Code settings, search for "Latex-workshop: Out Dir"
   - Set to `%DIR%/build` to direct LaTeX output files to a build subdirectory
   - Add `-pdf` and `-f` to latexmk command for better compatibility:

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

### Setting Up Cross-Computer Sync

If you work across multiple computers:

1. Use cloud storage (e.g., Dropbox) to sync key folders:

   - **Diffs**: Stores difference files from LaTeX diff operations
   - **History**: Tracks different versions of your documents

2. Create symbolic links to maintain your local directory structure:
   ```bash
   ln -s /path/to/Dropbox/texra-papers/ProjectName/Diffs /path/to/local/ProjectName
   ln -s /path/to/Dropbox/texra-papers/ProjectName/History /path/to/local/ProjectName
   ```

## Troubleshooting Installation

### Common Installation Issues

1. **Extension Not Loading**:

   - Check VS Code's minimum version requirement (1.96.2+)
   - Look for errors in the Output panel (select "TeXRA" in the dropdown)
   - Try reinstalling the extension

2. **LaTeX Processing Errors**:

   - Verify LaTeX is in your system PATH
   - Run `pdflatex --version` in terminal to confirm installation
   - Check if required LaTeX packages are installed

3. **Image Processing Errors**:

   - Confirm GraphicsMagick/ImageMagick is properly installed
   - Verify Ghostscript is installed and accessible
   - Check PATH environment variables

4. **API Key Issues**:
   - Verify API keys are entered correctly
   - Check your subscription status and usage limits
   - Ensure your network allows connections to API endpoints

### Getting Help

If you encounter persistent installation issues:

1. Check the [GitHub Issues page](https://github.com/texra-ai/texra-issues/issues) for known problems
2. Look for error messages in the TeXRA ProgressBoard
3. File a new issue with detailed information about your system and the specific error

## Next Steps

With TeXRA and all dependencies installed, you're ready to start using the tool to enhance your academic research. Check out the [Quick Start Guide](/guide/quick-start) to learn the basics, or explore specific features in the other documentation sections.
