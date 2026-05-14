# Installation Guide

This guide will walk you through the process of installing TeXRA and all its dependencies to ensure optimal performance.

## System Requirements

TeXRA is designed to work on all major operating systems with the following minimum requirements:

- **Visual Studio Code**: Version 1.99 or newer
- **Operating System**: Windows, macOS, or Linux
- **Internet Connection**: Required for API access to language models

## Installing the Extension

### From Extension Marketplaces

The easiest way to install TeXRA is directly from an extension marketplace:

1.  Open VS Code or your VSCodium-compatible editor.
2.  Go to the Extensions view (click the square icon in the Activity Bar or press `Ctrl+Shift+X`).
3.  Search for "TeXRA".
4.  Find the extension published by "texra-ai".
5.  Click the "Install" button.
6.  Reload your editor if prompted.

TeXRA is available on both the official VS Code Marketplace and the Open VSX Registry:

<a href="vscode:extension/texra-ai.texra" target="_blank" style="display: inline-block; background-color: #007ACC; color: white; padding: 8px 12px; text-decoration: none; border-radius: 4px; font-weight: bold; margin: 10px 5px 10px 0;">Open in VS Code</a>
<a href="https://open-vsx.org/extension/texra-ai/texra" target="_blank" style="display: inline-block; background-color: #4D5D99; color: white; padding: 8px 12px; text-decoration: none; border-radius: 4px; font-weight: bold; margin: 10px 0 10px 5px;">View on Open VSX</a>

You can also install TeXRA directly in your preferred editor using protocol-based links:

- [Open in VS Code](vscode:extension/texra-ai.texra)
- [Open in VS Code Insiders](vscode-insiders:extension/texra-ai.texra)
- [Open in Cursor](cursor:extension/texra-ai.texra)
- [Open in Windsurf](windsurf:extension/texra-ai.texra)

### Desktop App Beta

The standalone desktop app is in beta development. Public signed installers and
automatic updates are not enabled until the desktop release pipeline is
complete. See [Desktop App](./desktop.md) for supported platforms, current beta
installation expectations, logs, and update behavior.

::: tip Desktop app migration
If you are moving from the VS Code extension to the desktop app, treat the first
desktop launch as a fresh setup. Open the same project folder, then
re-authenticate and reconfigure local provider, agent, Git, and LaTeX settings.
See [Migrating to the Desktop App](./desktop-migration.md).
:::

### CLI Preview

The standalone `texra` command is currently installed from a repository checkout
rather than from npm. See [TeXRA CLI](./texra-cli.md) for build, local link, and
uninstall instructions.

### From VSIX File

1. Open VS Code
2. Obtain the newest release (`.vsix` file, e.g., `texra-0.36.7.vsix`)
3. Find the `.vsix` file in the VS Code file explorer
4. Right-click on the `.vsix` file
5. From the context menu, select "Install Extension VSIX"

## Installing Required Dependencies

Now for the slightly less fun part – making sure TeXRA has all the tools it needs to work its magic. TeXRA relies on several external tools to function properly. Follow the instructions for your operating system.

### Homebrew (macOS only) {#homebrew}

::: info WHAT IS HOMEBREW?
[Homebrew](https://brew.sh/) is a free package manager for macOS that makes it easy to install command-line tools and applications from the terminal. Many of the macOS instructions below use `brew install` commands, which require Homebrew to be installed first.
:::

If you're on macOS and don't have Homebrew yet, open the **Terminal** app (found in Applications → Utilities) and paste this command:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Follow the on-screen prompts to complete the installation. Once finished, you can use any of the `brew install` commands in the sections below.

::: tip
If you prefer not to use Homebrew, each section also links to the tool's official website where you can download a traditional installer.
:::

### LaTeX Distribution

::: tip IMPORTANT
A LaTeX distribution is required for TeXRA to properly process LaTeX documents.
:::

#### Windows

Install either **MiKTeX** or **TeX Live** (MiKTeX is easier for beginners):

**MiKTeX (recommended for Windows)**:

1. Go to [miktex.org/download](https://miktex.org/download)
2. Click the download button for the Windows installer
3. Run the downloaded `.exe` file and follow the setup wizard
4. When prompted, choose "Install missing packages on the fly" — this lets MiKTeX automatically download LaTeX packages as you need them

**TeX Live (alternative)**:

1. Go to [tug.org/texlive/windows.html](https://tug.org/texlive/windows.html)
2. Download the `install-tl-windows.exe` installer
3. Run the installer — the full installation may take a while as TeX Live downloads all packages upfront

After installing either distribution, **restart VS Code** so TeXRA can detect the new programs. You can verify the installation by opening a terminal (Command Prompt or PowerShell) and running:

```bash
pdflatex --version
```

#### macOS

Install **TeX Live** via [Homebrew](#homebrew) — this is the recommended option for most TeXRA users because it is smaller, stays current with `brew upgrade`, and skips the Mac-specific GUI apps that VS Code users don't need:

```bash
brew install texlive
```

Alternative distributions:

- **MacTeX with GUI apps** (includes TeXShop, BibDesk, etc., ~4 GB): `brew install --cask mactex`, or download the `.pkg` from [tug.org/mactex](https://www.tug.org/mactex/mactex-download.html)
- **MacTeX without GUI apps** (smaller MacTeX variant): `brew install --cask mactex-no-gui`

After installing, **restart VS Code** so TeXRA can detect the new programs. You can verify by opening Terminal and running:

```bash
pdflatex --version
```

#### Linux (Ubuntu/Debian)

Install TeX Live:

```bash
sudo apt-get update
sudo apt-get install texlive-full
```

After installing, **restart VS Code** and verify with:

```bash
pdflatex --version
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
4. Select the provider (e.g., Anthropic, OpenAI, Google)
5. Enter your API key when prompted

You can also manage API keys from the **Models tab** in the TeXRA Dashboard, which provides inline set/remove controls for each provider.

TeXRA also loads environment variables from a `.env` file in your workspace. Define variables like `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in this file to avoid entering keys manually.

![API Key Setup](/images/api-key-setup.png)

::: info Getting API Keys

- **OpenAI API Key**: Available from [OpenAI API](https://platform.openai.com/api-keys)
- **Anthropic API Key**: Available from [Anthropic Console](https://console.anthropic.com/)
- **Google API Key**: Available from [Google AI Studio](https://aistudio.google.com/app/apikey)
- **OpenRouter API Key**: Available from [OpenRouter Dashboard](https://openrouter.ai/keys)
- **xAI API Key**: Available from [xAI Console](https://console.x.ai/)
- **DeepSeek API Key**: Available from [DeepSeek Platform](https://platform.deepseek.com/api_keys)
- **Moonshot API Key**: Available from [Moonshot Console](https://platform.moonshot.cn/console)
- **DashScope API Key**: Available from [DashScope Console](https://dashscope.aliyun.com/api-console/)
- **MiniMax API Key**: Available from [MiniMax Platform](https://platform.minimax.io/) (international) or [MiniMax China](https://platform.minimaxi.com/) (China region)
- **GLM API Key**: Available from [Z.AI](https://z.ai/) (international) or [BigModel](https://open.bigmodel.cn/) (China region)
  :::

## Verifying Installation

To verify that TeXRA and all dependencies are correctly installed:

1. Open VS Code
2. Click on the TeXRA icon in the Activity Bar
3. The TeXRA panel should load without errors
4. Create or open a LaTeX document
5. Try a simple command like "Indent Current TeX" from the editor title menu

If any component is missing, TeXRA will typically show an error message indicating what needs to be installed.

## Troubleshooting Installation

### Common Installation Issues

1. **Extension Not Loading**:
   - Check VS Code's minimum version requirement (1.99+)
   - Look for errors in the Output panel (select "TeXRA" in the dropdown)
   - Try reinstalling the extension

2. **LaTeX Processing Errors**:
   - Verify LaTeX is in your system PATH

- Run `latexmk --version` (or `pdflatex --version`) in terminal to confirm installation
- Check if required LaTeX packages are installed

3. **Image Processing Errors**:
   - Confirm GraphicsMagick/ImageMagick is properly installed
   - Verify Ghostscript is installed and accessible
   - Check PATH environment variables

4. **API Key Issues**:
   - Verify API keys are entered correctly
   - Check your usage limits
   - Ensure your network allows connections to API endpoints

### Getting Help

If you encounter persistent installation issues:

1. Check the [GitHub Issues page](https://github.com/texra-ai/texra-issues/issues) for known problems
2. Look for error messages in the TeXRA ProgressBoard
3. File a new issue with detailed information about your system and the specific error

## Next Steps

With TeXRA and all dependencies installed, you're ready to start using the tool to enhance your academic research. Check out the [Quick Start Guide](/guide/quick-start) to learn the basics, or examine specific features in the other documentation sections.
