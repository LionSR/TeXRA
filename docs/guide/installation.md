<script setup>
import DoctorReportCard from '../.vitepress/components/DoctorReportCard.vue';
import InstallTroubleshootCards from '../.vitepress/components/InstallTroubleshootCards.vue';
</script>

# Installation Guide

This guide will walk you through the process of installing TeXRA and all its dependencies to ensure optimal performance.

## System Requirements

TeXRA is designed to work on all major operating systems with the following minimum requirements:

- **Visual Studio Code**: Version 1.125 or newer (for the VS Code extension)
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

### CLI

The standalone `texra` command is published to npm. Install it globally (requires
Node.js >=22.9.0):

```bash
npm install -g @texra-ai/cli
```

Or with [Homebrew](https://github.com/texra-ai/homebrew-tap) on macOS and Linux:

```bash
brew install texra-ai/tap/texra
```

See [TeXRA CLI](./texra-cli.md) for usage, shell completion, and workspace defaults.

### From VSIX File

1. Open VS Code
2. Obtain the newest release (`.vsix` file, e.g., `texra-<version>.vsix`)
3. Find the `.vsix` file in the VS Code file explorer
4. Right-click on the `.vsix` file
5. From the context menu, select "Install Extension VSIX"

## Installing Required Dependencies

Now for the slightly less fun part – making sure TeXRA has the tools it needs. Only a **LaTeX distribution** is strictly required for core document processing; the other tools below unlock specific features. Install the ones you need and follow the instructions for your operating system.

<FeatureCards
  min="220px"
  :cards="[
    { icon: 'file-code', title: 'LaTeX distribution', tag: 'Required', tagVariant: 'accent', desc: 'Core document processing — compiling and rendering .tex.', chips: [{ text: 'MiKTeX / TeX Live', variant: 'neutral' }] },
    { icon: 'diff-multiple', title: 'Perl', tag: 'Optional', tagVariant: 'neutral', desc: 'Backs the latexindent and latexdiff scripts.', chips: [{ text: 'auto-format', variant: 'info' }, { text: 'LaTeX diffs', variant: 'info' }] },
    { icon: 'image', title: 'GraphicsMagick / ImageMagick', tag: 'Optional', tagVariant: 'neutral', desc: 'Figure and image processing.', chips: [{ text: 'figures', variant: 'info' }] },
    { icon: 'file-pdf', title: 'Ghostscript', tag: 'Optional', tagVariant: 'neutral', desc: 'Rasterizes PDF figures for the image tools above.', chips: [{ text: 'figures', variant: 'info' }] }
  ]"
/>

<p class="hero-caption">Install only what you need: a LaTeX distribution is the one hard requirement; Perl, GraphicsMagick/ImageMagick, and Ghostscript each unlock a specific optional feature.</p>

::: tip Check what's detected with `texra doctor`
Run `texra doctor` to see what TeXRA found — the LaTeX toolchain, runtime and authentication, and which optional tools are deferred until first use.
:::

<DoctorReportCard />

<p class="hero-caption"><code>texra doctor</code> groups its findings: the full LaTeX toolchain and runtime/auth are verified up front, while the optional image tools and Wolfram are checked on demand the first time a feature needs them.</p>

### Homebrew {#homebrew}

::: info WHAT IS HOMEBREW?
[Homebrew](https://brew.sh/) is a free package manager for macOS and Linux that makes it easy to install command-line tools and applications from the terminal. Many of the macOS instructions below use `brew install` commands, which require Homebrew to be installed first.
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

::: info OPTIONAL
Perl backs the `latexindent` and `latexdiff` LaTeX tools (both are Perl scripts). You only need it if you use auto-formatting or LaTeX diffs. It ships with macOS and with TeX Live, and is present on most Linux installs — but **not** with MiKTeX, and not on minimal or container Linux images. Check with `perl --version` rather than assuming.
:::

#### Windows

TeX Live for Windows ships its own Perl, so `latexindent` and `latexdiff` work out of the box. **MiKTeX does not bundle Perl** — if you installed MiKTeX (the option recommended above for beginners), install Perl separately:

1. Download [Strawberry Perl](https://strawberryperl.com/)
2. Run the installer, which adds Perl to your PATH
3. Restart VS Code, then verify in Command Prompt or PowerShell:

```bash
perl --version
```

If you skip this on MiKTeX, TeXRA still compiles documents; only auto-formatting and LaTeX diffs are unavailable. The Setup Wizard flags the missing dependency and points to the same download.

#### macOS

- Pre-installed
- Verify with `perl --version` in Terminal

#### Linux

```bash
sudo apt-get install perl
```

### GraphicsMagick/ImageMagick

::: tip OPTIONAL
Needed only for TeXRA's figure and image processing features. GraphicsMagick is the recommended option for better performance; ImageMagick is a drop-in alternative.
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

::: info OPTIONAL
Ghostscript is used by GraphicsMagick/ImageMagick to rasterize PDF figures. Install it alongside GraphicsMagick/ImageMagick only if you use TeXRA's figure/image processing features.
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

TeXRA talks to model providers directly with an API key you supply. You need a key from at least one provider — Anthropic, OpenAI, Google, etc. — and you give it to TeXRA the same way on every platform: the key is named `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` and so on.

### In the VS Code Extension

The friendliest path: open the TeXRA Dashboard, go to the **Providers & Models** tab, and click the provider you want. Paste the key and it's saved in VS Code's secret storage. You can also run **TeXRA: Set API Key** from the Command Palette, or drop the keys in a `.env` file in your project — the extension reads it on startup.

<ApiKeysHero />

<p class="hero-caption">The Dashboard's Providers & Models tab → API configuration: each provider shows its key status (Set · Env · Not set) with Set, Get, and Remove actions.</p>

### In the CLI

Set the provider key in your shell, then check it's picked up:

```bash
export ANTHROPIC_API_KEY=sk-…
texra doctor
```

The CLI **doesn't read `.env` files automatically** (the extension does). If you already keep keys in a project `.env`, load them into the shell first — for example in bash or zsh:

```bash
set -a; . .env; set +a
texra doctor
```

Prefer not to manage keys at all? Connect a provider subscription instead:

```bash
texra auth chatgpt login
texra auth status
```

See [TeXRA CLI](./texra-cli.md) for provider keys, subscriptions, and workspace defaults.

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
2. Click on the TeXRA icon in the Secondary Side Bar
3. The TeXRA panel should load without errors
4. Create or open a LaTeX document
5. Try a simple command like "Indent Current TeX" from the editor title menu

If any component is missing, TeXRA will typically show an error message indicating what needs to be installed.

## Troubleshooting Installation

### Common Installation Issues

Most installation problems fall into one of four categories. Find your symptom and work through its checks:

<InstallTroubleshootCards />

<p class="hero-caption">Four common failure modes and the checks for each: a loading extension, LaTeX or image processing, and API keys.</p>

### Getting Help

If you encounter persistent installation issues:

1. Check the [GitHub Issues page](https://github.com/texra-ai/texra-issues/issues) for known problems
2. Look for error messages in the TeXRA ProgressBoard
3. File a new issue with detailed information about your system and the specific error

## Next Steps

With TeXRA and all dependencies installed, you're ready to start using the tool to enhance your academic research. Check out the [Quick Start Guide](/guide/quick-start) to learn the basics, or examine specific features in the other documentation sections.
