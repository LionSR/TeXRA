<script setup>
import DoctorReportCard from '../.vitepress/components/DoctorReportCard.vue';
import InstallTroubleshootCards from '../.vitepress/components/InstallTroubleshootCards.vue';
</script>

# Installation guide

This guide walks you through installing TeXRA and the tools it depends on. The agents themselves need only a model provider; the LaTeX toolchain below is for compiling, diffing, and previewing the documents they work on.

## System requirements

TeXRA runs on all major operating systems. Minimum requirements:

- **Visual Studio Code**: Version 1.125 or newer (for the VS Code extension)
- **Operating System**: Windows, macOS, or Linux
- **Internet Connection**: Required for API access to language models

## Installing the extension

### From extension marketplaces

The shortest path is an extension marketplace:

1.  Open VS Code or your VSCodium-compatible editor.
2.  Open the Extensions view (select the square icon in the Activity Bar or press `Ctrl+Shift+X`).
3.  Search for "TeXRA".
4.  Find the extension published by "texra-ai".
5.  Select **Install**.
6.  Reload your editor if prompted.

TeXRA is available on both the official VS Code Marketplace and the Open VSX Registry:

<a href="vscode:extension/texra-ai.texra" target="_blank" style="display: inline-block; background-color: #007ACC; color: white; padding: 8px 12px; text-decoration: none; border-radius: 4px; font-weight: bold; margin: 10px 5px 10px 0;">Open in VS Code</a>
<a href="https://open-vsx.org/extension/texra-ai/texra" target="_blank" style="display: inline-block; background-color: #4D5D99; color: white; padding: 8px 12px; text-decoration: none; border-radius: 4px; font-weight: bold; margin: 10px 0 10px 5px;">View on Open VSX</a>

You can also install TeXRA in your preferred editor through a protocol link:

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

Read the [TeXRA CLI guide](./texra-cli.md) for usage, shell completion, and workspace defaults.

### From VSIX file

1. Open VS Code
2. Download the newest release (`.vsix` file, e.g., `texra-<version>.vsix`)
3. Find the `.vsix` file in the VS Code file explorer
4. Right-click the `.vsix` file
5. From the context menu, select "Install Extension VSIX"

## Installing required dependencies

TeXRA needs a few external tools. Only a **LaTeX distribution** is required for core document processing; the other tools below unlock specific features. Install the ones you need and follow the instructions for your operating system.

<FeatureCards
  min="220px"
  :cards="[
    { icon: 'file-code', title: 'LaTeX distribution', tag: 'Required', tagVariant: 'accent', desc: 'Core document processing: compiles and rendering .tex.', chips: [{ text: 'MiKTeX / TeX Live', variant: 'neutral' }] },
    { icon: 'diff-multiple', title: 'Perl', tag: 'Optional', tagVariant: 'neutral', desc: 'Backs the latexindent and latexdiff scripts.', chips: [{ text: 'auto-format', variant: 'info' }, { text: 'LaTeX diffs', variant: 'info' }] },
    { icon: 'image', title: 'GraphicsMagick / ImageMagick', tag: 'Optional', tagVariant: 'neutral', desc: 'Figure and image processing.', chips: [{ text: 'figures', variant: 'info' }] },
    { icon: 'file-pdf', title: 'Ghostscript', tag: 'Optional', tagVariant: 'neutral', desc: 'Rasterizes PDF figures for the image tools above.', chips: [{ text: 'figures', variant: 'info' }] }
  ]"
/>

<p class="hero-caption">Install only what you need: a LaTeX distribution is the one hard requirement; Perl, GraphicsMagick/ImageMagick, and Ghostscript each unlock a specific optional feature.</p>

::: tip Check what's detected with `texra doctor`
Run `texra doctor` to see what TeXRA found: Node.js, the workspace and packaged resources, your TeXRA account and available models, usage logging, the LaTeX toolchain (`latexmk`, `pdflatex`, `xelatex`, `lualatex`, `bibtex`, `biber`, `latexdiff`, `latexindent`), and the workspace config file. The optional image tools (GraphicsMagick/ImageMagick, Ghostscript) are not part of the doctor report; a feature that needs them tells you when they are missing.
:::

<DoctorReportCard />

<p class="hero-caption"><code>texra doctor</code> checks the runtime, your account and models, usage logging, the full LaTeX toolchain, and the workspace config. Optional image tools are not listed; the feature that needs them reports when one is missing.</p>

### Homebrew {#homebrew}

::: info WHAT IS HOMEBREW?
[Homebrew](https://brew.sh/) is a free package manager for macOS and Linux that installs command-line tools and applications from the terminal. Many of the macOS instructions below use `brew install` commands, which require Homebrew.
:::

If you're on macOS and don't have Homebrew yet, open the **Terminal** app (in Applications, under Utilities) and paste this command:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Follow the on-screen prompts to complete the installation. Then you can use any of the `brew install` commands in the sections below.

::: tip
If you prefer not to use Homebrew, each section also links to the tool's official website, where you can download a traditional installer.
:::

### LaTeX distribution

::: tip IMPORTANT
TeXRA needs a LaTeX distribution to process LaTeX documents.
:::

#### Windows

Install either **MiKTeX** or **TeX Live** (MiKTeX is easier for beginners):

**MiKTeX (recommended for Windows)**:

1. Go to [miktex.org/download](https://miktex.org/download)
2. Download the Windows installer
3. Run the downloaded `.exe` file and follow the setup wizard
4. When prompted, choose "Install missing packages on the fly" so MiKTeX downloads LaTeX packages as you need them

**TeX Live (alternative)**:

1. Go to [tug.org/texlive/windows.html](https://tug.org/texlive/windows.html)
2. Download the `install-tl-windows.exe` installer
3. Run the installer. The full installation may take a while because TeX Live downloads all packages up front

After installing either distribution, **restart VS Code** so TeXRA can detect the new programs. To verify the installation, open a terminal (Command Prompt or PowerShell) and run:

```bash
pdflatex --version
```

#### macOS

Install **TeX Live** through [Homebrew](#homebrew). This is the recommended option for most TeXRA users: it is smaller, stays current with `brew upgrade`, and skips the Mac-specific GUI apps that VS Code users don't need:

```bash
brew install texlive
```

Alternative distributions:

- **MacTeX with GUI apps** (includes TeXShop, BibDesk, etc., ~4 GB): `brew install --cask mactex`, or download the `.pkg` from [tug.org/mactex](https://www.tug.org/mactex/mactex-download.html)
- **MacTeX without GUI apps** (smaller MacTeX variant): `brew install --cask mactex-no-gui`

After installing, **restart VS Code** so TeXRA can detect the new programs. To verify, open Terminal and run:

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
Perl backs the `latexindent` and `latexdiff` LaTeX tools (both are Perl scripts). You only need it if you use auto-formatting or LaTeX diffs. It ships with macOS and with TeX Live, and is present on most Linux installs, but **not** with MiKTeX, and not on minimal or container Linux images. Check with `perl --version` rather than assuming.
:::

#### Windows

TeX Live for Windows ships its own Perl, so `latexindent` and `latexdiff` work without further setup. **MiKTeX does not bundle Perl.** If you installed MiKTeX (the option recommended above for beginners), install Perl separately:

1. Download [Strawberry Perl](https://strawberryperl.com/)
2. Run the installer, which adds Perl to your PATH
3. Restart VS Code, then verify in Command Prompt or PowerShell:

```bash
perl --version
```

If you skip this on MiKTeX, TeXRA still compiles documents; only auto-formatting and LaTeX diffs are unavailable. The setup assistant flags the missing dependency and points to the same download.

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

- Download from the [GraphicsMagick website](http://www.graphicsmagick.org/download.html)
- Add the installation directory to PATH

**macOS**:

```bash
brew install graphicsmagick
```

**Linux**:

```bash
sudo apt-get install graphicsmagick
```

#### ImageMagick (alternative)

**Windows**:

- Download from the [ImageMagick website](https://imagemagick.org/script/download.php)
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
GraphicsMagick/ImageMagick use Ghostscript to rasterize PDF figures. Install it alongside GraphicsMagick/ImageMagick only if you use TeXRA's figure/image processing features.
:::

#### Windows

- Download from the [Ghostscript website](https://ghostscript.com/releases/gsdnld.html)
- If you run into compatibility issues, install version 9.52 from the [Ghostscript 9.52 release page](https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/tag/gs952)

#### macOS

```bash
brew install ghostscript
```

#### Linux

```bash
sudo apt-get install ghostscript
```

## Setting up API keys

TeXRA talks to model providers directly with an API key you supply. You need a key from at least one provider (Anthropic, OpenAI, Google, etc.), and you give it to TeXRA the same way on every platform: the key is named `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` and so on.

### In the VS Code extension

The shortest path: open the TeXRA Dashboard, go to the **Providers & Models** tab, and select the provider you want. Paste the key and it is saved in VS Code's secret storage. You can also run **TeXRA: Set API Key** from the Command Palette, or put the keys in a `.env` file in your project; the extension reads it on startup.

<ApiKeysHero />

<p class="hero-caption">The Dashboard's Providers & Models tab → API configuration: each provider shows its key status (Set · Env · Not set) with Set, Get, and Remove actions.</p>

### In the CLI

Set the provider key in your shell, then check that it is picked up:

```bash
export ANTHROPIC_API_KEY=sk-…
texra doctor
```

The CLI **doesn't read `.env` files automatically** (the extension does). If you already keep keys in a project `.env`, load them into the shell first, for example in bash or zsh:

```bash
set -a; . .env; set +a
texra doctor
```

If you prefer not to manage keys, connect a provider subscription instead. A ChatGPT subscription unlocks the Codex models, and a Grok (xAI SuperGrok) subscription unlocks the xAI models. `texra auth login` separately signs in to your TeXRA account:

```bash
texra auth chatgpt login
texra auth grok login
texra auth status
```

Read the [TeXRA CLI guide](./texra-cli.md) for provider keys, subscriptions, and workspace defaults.

::: info Getting API Keys

- **OpenAI API Key**: Available from [OpenAI API](https://platform.openai.com/api-keys)
- **Anthropic API Key**: Available from [Anthropic Console](https://console.anthropic.com/)
- **Google API Key**: Available from [Google AI Studio](https://aistudio.google.com/app/apikey)
- **OpenRouter API Key**: Available from [OpenRouter Dashboard](https://openrouter.ai/keys)
- **xAI API Key**: Available from [xAI Console](https://console.x.ai/)
- **DeepSeek API Key**: Available from [DeepSeek Platform](https://platform.deepseek.com/api_keys)
- **Moonshot API Key**: Available from [Moonshot Console](https://platform.moonshot.cn/console); a Kimi Code plan key (`KIMI_CODE_API_KEY`) is a separate slot alongside it
- **DashScope API Key**: Available from [DashScope Console](https://dashscope.aliyun.com/api-console/)
- **MiniMax API Key**: Available from [MiniMax Platform](https://platform.minimax.io/) (international) or [MiniMax China](https://platform.minimaxi.com/) (China region)
- **GLM API Key**: Available from [Z.AI](https://z.ai/) (international) or [BigModel](https://open.bigmodel.cn/) (China region)
- **Meta API Key** (Muse Spark): Available from [dev.meta.ai](https://dev.meta.ai/)
  :::

## Verifying installation

To verify that TeXRA and its dependencies are installed correctly:

1. Open VS Code
2. Select the TeXRA icon in the Secondary Side Bar
3. The TeXRA panel should load without errors
4. Create or open a LaTeX document
5. Try a simple command like `TeXRA: Indent Current TeX` from the Command Palette (the editor title bar only shows TeXRA's Fix Compilation button for LaTeX files)

If a component is missing, TeXRA shows an error message that names what needs to be installed.

## Troubleshooting installation

### Common installation issues

Most installation problems fall into one of four categories. Find your symptom and work through its checks:

<InstallTroubleshootCards />

<p class="hero-caption">Four common failure modes and the checks for each: a loading extension, LaTeX or image processing, and API keys.</p>

### Getting help

If an installation problem persists:

1. Check the [GitHub Issues page](https://github.com/LionSR/TeXRA/issues) for known problems
2. Look for error messages in the TeXRA ProgressBoard
3. File a new issue with details about your system and the specific error

## Next steps

With TeXRA and its dependencies installed, you're ready to start. Read the [Quick start guide](/guide/quick-start) to learn the basics, or explore specific features in the other documentation sections.
