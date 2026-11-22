<script setup>
import DoctorReportCard from '../.vitepress/components/DoctorReportCard.vue';
import InstallTroubleshootCards from '../.vitepress/components/InstallTroubleshootCards.vue';
</script>

# Installation guide

Install TeXRA as a VS Code extension, a standalone CLI, or the upcoming [Desktop App](./desktop.md). Chat, coding, and Lean tasks need only an API key or provider subscription; local LaTeX tools are needed for compiling PDFs, generating diffs, and formatting `.tex` files.

## System requirements

- **Operating System**: macOS, Windows, or Linux
- **VS Code**: 1.125+ (for the extension) or **Node.js 22.22.2+ (22.x) / 24.15+** (for the CLI)
- **Internet Connection**: Required for model API calls

::: info Usage logging
TeXRA logs anonymous usage metadata (model, token counts, cost, timing — never prompts, files, or paths) under a random install ID. Opt out anytime with `TEXRA_NO_TELEMETRY=1`, `DO_NOT_TRACK=1`, or `"texra.telemetry.enabled": false`. See [Usage logging](./configuration.md#usage-logging).
:::

## Installing the extension

### From extension marketplaces

Search for **TeXRA** (`texra-ai.texra`) in the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`) of VS Code or any VSCodium-compatible editor and select **Install**.

TeXRA is published on the VS Code Marketplace and the Open VSX Registry:

<a href="vscode:extension/texra-ai.texra" target="_blank" style="display: inline-block; background-color: #007ACC; color: white; padding: 8px 12px; text-decoration: none; border-radius: 4px; font-weight: bold; margin: 10px 5px 10px 0;">Open in VS Code</a>
<a href="https://open-vsx.org/extension/texra-ai/texra" target="_blank" style="display: inline-block; background-color: #4D5D99; color: white; padding: 8px 12px; text-decoration: none; border-radius: 4px; font-weight: bold; margin: 10px 0 10px 5px;">View on Open VSX</a>

You can also install TeXRA in your preferred editor through a protocol link:

- [Open in VS Code](vscode:extension/texra-ai.texra)
- [Open in VS Code Insiders](vscode-insiders:extension/texra-ai.texra)
- [Open in Cursor](cursor:extension/texra-ai.texra)
- [Open in Windsurf](windsurf:extension/texra-ai.texra)

### CLI

Install globally via npm (requires Node.js 22.22.2+ in 22.x, or 24.15+):

```bash
npm install -g @texra-ai/cli
```

Or with [Homebrew](https://github.com/texra-ai/homebrew-tap) on macOS and Linux:

```bash
brew install texra-ai/tap/texra
```

::: details Linux / WSL `EACCES` permission errors with npm
If a system-wide Node.js install fails with `EACCES`, use a version manager ([nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm)) or point npm at a user-owned prefix:

```bash
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"   # add to ~/.bashrc or ~/.zshrc
npm install -g @texra-ai/cli
```
:::

Read the [TeXRA CLI guide](./texra-cli.md) for usage, shell completion, and project defaults.

### Desktop App

Standalone installers for macOS, Windows, and Linux are coming soon. See the [Desktop App guide](./desktop.md).

### From VSIX file

To install from a release `.vsix` archive (`texra-<version>.vsix`), right-click the file in the VS Code Explorer and select **Install Extension VSIX**, or run `code --install-extension texra-<version>.vsix`.

## Installing system dependencies

For compiling and diffing LaTeX documents, you need a local **LaTeX distribution** (optional if you only use TeXRA for chat, code, or Lean). Perl (for `latexdiff` and `latexindent`), GraphicsMagick/ImageMagick, and Ghostscript add optional features:

<FeatureCards
  min="220px"
  :cards="[
    { icon: 'file-code', title: 'LaTeX distribution', tag: 'For LaTeX', tagVariant: 'accent', desc: 'Required for compiling and rendering .tex; optional for chat, code, or Lean.', chips: [{ text: 'MiKTeX / TeX Live', variant: 'neutral' }] },
    { icon: 'diff-multiple', title: 'Perl', tag: 'Optional', tagVariant: 'neutral', desc: 'Backs the latexindent and latexdiff scripts.', chips: [{ text: 'auto-format', variant: 'info' }, { text: 'latexdiff', variant: 'info' }] },
    { icon: 'image', title: 'GraphicsMagick / ImageMagick', tag: 'Optional', tagVariant: 'neutral', desc: 'Figure and image processing.', chips: [{ text: 'figures', variant: 'info' }] },
    { icon: 'file-pdf', title: 'Ghostscript', tag: 'Optional', tagVariant: 'neutral', desc: 'Rasterizes PDF figures for the image tools above.', chips: [{ text: 'figures', variant: 'info' }] }
  ]"
/>

::: tip Check what's detected with `texra doctor`
Run `texra doctor` to inspect what TeXRA detected: Node.js, project folder and packaged resources, available models, usage logging, the LaTeX toolchain (`latexmk`, `pdflatex`, `xelatex`, `lualatex`, `bibtex`, `biber`, `latexdiff`, `latexindent`), and the project config file. Optional image tools (GraphicsMagick/ImageMagick and Ghostscript) are checked on demand when a figure tool runs.
:::

<DoctorReportCard />

### Homebrew {#homebrew}

Many macOS instructions below use [Homebrew](https://brew.sh/). If you don't have it installed, run:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Each section below also links to the official installer if you prefer not to use Homebrew.

### LaTeX distribution

::: tip IMPORTANT
TeXRA needs a local LaTeX distribution to compile `.tex` documents and visual diffs.
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
Perl backs the `latexindent` and `latexdiff` LaTeX tools (both are Perl scripts). You only need it if you use auto-formatting or `latexdiff`. It ships with macOS and with TeX Live, and is present on most Linux installs, but **not** with MiKTeX, and not on minimal or container Linux images. Check with `perl --version` rather than assuming.
:::

#### Windows

TeX Live for Windows ships its own Perl, so `latexindent` and `latexdiff` work without further setup. **MiKTeX does not bundle Perl.** If you installed MiKTeX (the option recommended above for beginners), install Perl separately:

1. Download [Strawberry Perl](https://strawberryperl.com/)
2. Run the installer, which adds Perl to your PATH
3. Restart VS Code, then verify in Command Prompt or PowerShell:

```bash
perl --version
```

If you skip this on MiKTeX, TeXRA still compiles documents; only auto-formatting and `latexdiff` are unavailable. The Setup Assistant flags the missing dependency and points to the same download.

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

### In VS Code or the desktop app

Open **Settings → Models → API keys**, select a provider, and paste your key (saved in `~/.texra/secrets/`, readable only by your user and shared across all TeXRA apps). You can also run **TeXRA: Set API Key** from the Command Palette or add keys to a `.env` file in your project folder (project `.env` values override shell variables for that project).

<ApiKeysHero />

<p class="hero-caption">The Settings Models page → API keys: each provider shows its key status (Key set · Env · Not set) with Set, Get, and Remove actions.</p>

### In the CLI

Export a provider key in your shell and verify with `texra doctor`:

```bash
export ANTHROPIC_API_KEY=sk-…
texra doctor
```

Project `.env` files work here too. Keys exported in a terminal are forwarded to tasks started from that terminal; to save a key permanently, run `texra setup` or put it in `.env`.

To use a provider subscription instead of an API key (ChatGPT, Grok, Kimi Code, or GLM Coding Plan — see [Models](./models.md)):

```bash
texra auth chatgpt login
texra auth grok login
texra auth chatgpt status
```

Read the [TeXRA CLI guide](./texra-cli.md) for provider keys, subscriptions, and project defaults.

::: info Getting API Keys

- **OpenAI API Key**: Available from [OpenAI API](https://platform.openai.com/api-keys); a ChatGPT Pro or Business plan includes [monthly API credits](https://help.openai.com/en/articles/20001626-api-credits-benefit-for-eligible-chatgpt-subscriptions) that this key can spend once you claim them for an API organization you own
- **Anthropic API Key**: Available from [Claude Console](https://platform.claude.com/settings/keys); a Claude Max or Team plan includes [monthly API credits](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers) that this key can spend once you link a Console organization to the plan
- **Google API Key**: Available from [Google AI Studio](https://aistudio.google.com/app/apikey)
- **xAI API Key**: Available from [xAI Console](https://console.x.ai/)
- **DeepSeek API Key**: Available from [DeepSeek Platform](https://platform.deepseek.com/api_keys)
- **Moonshot API Key**: Available from [Moonshot Console](https://platform.moonshot.cn/console); a Kimi Code plan key (`KIMI_CODE_API_KEY`) is a separate slot alongside it
- **DashScope API Key**: Available from [DashScope Console](https://dashscope.aliyun.com/api-console/)
- **MiniMax API Key**: Available from [MiniMax Platform](https://platform.minimax.io/) (international) or [MiniMax China](https://platform.minimaxi.com/) (China region)
- **GLM API Key**: Available from [Z.AI](https://z.ai/) (international) or [BigModel](https://open.bigmodel.cn/) (China region)
- **Meta API Key** (Muse Spark): Available from [dev.meta.ai](https://dev.meta.ai/)
:::

## Verifying and troubleshooting installation

Run `texra doctor` in the terminal, or open the TeXRA view in VS Code and run `TeXRA: Format Current LaTeX File` from the Command Palette on a `.tex` document. If a dependency is missing, TeXRA names the required tool in the error message.

<InstallTroubleshootCards />

<p class="hero-caption">Four common failure modes and the checks for each: extension startup, LaTeX toolchain, figure rasterization, and API keys.</p>

If an issue persists, check the [troubleshooting guide](/guide/troubleshooting) or open an issue on [GitHub](https://github.com/LionSR/TeXRA/issues).

## Next steps

Read [First run](./first-run.md) or the [Quick start guide](/guide/quick-start) to run your first task.
