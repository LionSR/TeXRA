<script setup>
import ProgressLogHero from '../.vitepress/components/ProgressLogHero.vue';
import XmlRepairCard from '../.vitepress/components/XmlRepairCard.vue';
import ToolPathSearchOrder from '../.vitepress/components/ToolPathSearchOrder.vue';
import DoctorSliceHero from '../.vitepress/components/DoctorSliceHero.vue';
</script>

# Troubleshooting

This guide helps you diagnose and resolve common issues with TeXRA, whether an agent run stalls, a model refuses to connect, or the LaTeX toolchain is missing. Entries are grouped by category so you can find the one that matches your problem.

::: tip CLI users
Most steps below describe the VS Code extension, but the underlying causes
(missing dependencies, API keys, model settings) apply to every surface. From
the terminal, run `texra doctor` to diagnose your environment, `texra models list`
to confirm available models, and `/plugins` in `texra chat` to see each
integration's state.
:::

## Installation issues

### Extension not loading

**Problem**: TeXRA doesn't appear in the sidebar or shows errors during load.

**Solutions**:

1. **Check VS Code compatibility**:
   - Make sure you're running VS Code version 1.125 or newer
   - Update VS Code if needed

2. **Verify installation**:
   - Open the Extensions view (Ctrl+Shift+X)
   - Search for "TeXRA"
   - If it is not installed or is disabled, install or enable it
   - Try reinstalling from the VSIX file

3. **Check error logs**:
   - Open the Output panel (Ctrl+Shift+U)
   - Select "TeXRA" from the dropdown menu
   - Look for specific error messages

4. **Check extension conflicts**:
   - Temporarily disable other extensions that might conflict
   - Restart VS Code and check whether TeXRA works

### Dependency installation problems

**Problem**: Error messages about missing dependencies like LaTeX, Perl, or GraphicsMagick.

One command checks them all. `texra doctor` probes the LaTeX toolchain (plus
Node, auth, and model access) and says exactly what is missing and how to fix
it:

<DoctorSliceHero
  :rows="[
    { state: 'pass', name: 'LaTeX latexmk', message: 'LaTeX build orchestration' },
    { state: 'pass', name: 'LaTeX pdflatex', message: 'PDFLaTeX compiler' },
    {
      state: 'warn',
      name: 'LaTeX latexdiff',
      message: 'latexdiff was not found on PATH.',
      hint: 'Install latexdiff or a TeX distribution that provides it.',
    },
  ]"
/>

**Solutions**:

1. **Verify dependencies manually**:

   ```bash
   latexmk --version  # or pdflatex --version
   perl --version
   gm version  # For GraphicsMagick
   gs --version  # For Ghostscript
   ```

2. **Check the PATH environment**:
   - Make sure installation directories are in your system PATH
   - Restart your terminal and VS Code after updating PATH

- When you launch VS Code from the system menu or Finder, it may inherit a minimal PATH. TeXRA searches common locations in the following order:

<ToolPathSearchOrder />

<p class="hero-caption">Launched from Finder or the Start menu, VS Code inherits a minimal PATH, so TeXRA probes these well-known install dirs in order, per OS, falling back to <code>kpsewhich</code> and <code>texmf-dist/scripts</code>.</p>

**macOS:**

1. `/opt/homebrew/bin` (Apple Silicon Homebrew)
2. `/usr/local/bin` (Intel Homebrew and general tools)
3. `/Library/TeX/texbin` (MacTeX symlink)
4. `/usr/texbin` (legacy MacTeX location)
5. `/Applications/MiKTeX Console.app/Contents/bin` (MiKTeX app bundle)
6. `~/bin` (MiKTeX default symlink target)
7. `~/.local/bin` (user-local tools such as Claude Code's native installer)
8. Versioned TeX Live directories (e.g., `/usr/local/texlive/2024/bin/universal-darwin`)
9. User-specific installations in `~/texlive/*/bin/*` and `~/TinyTeX/bin/*`

**Windows:**

1. `C:\Program Files\MiKTeX\miktex\bin\x64` (64-bit MiKTeX)
2. `C:\Program Files\MiKTeX\miktex\bin` (32-bit MiKTeX)
3. `C:\Program Files\MiKTeX 2.9\miktex\bin\x64` and `C:\Program Files\MiKTeX 2.9\miktex\bin` (legacy MiKTeX 2.9)
4. `C:\Program Files (x86)\MiKTeX\miktex\bin` and `C:\Program Files (x86)\MiKTeX 2.9\miktex\bin` (32-bit on 64-bit Windows)
5. `C:\Strawberry\perl\bin` (Strawberry Perl)
6. Ghostscript in `C:\Program Files\gs\*\bin` and `C:\Program Files (x86)\gs\*\bin` (newest version first)
7. `%LOCALAPPDATA%\Programs\MiKTeX\miktex\bin\x64` and `%LOCALAPPDATA%\Programs\MiKTeX\miktex\bin` (user MiKTeX installation)
8. `%LOCALAPPDATA%\Programs\MiKTeX 2.9\miktex\bin\x64` and `%LOCALAPPDATA%\Programs\MiKTeX 2.9\miktex\bin` (legacy user MiKTeX 2.9)
9. `%LOCALAPPDATA%\MiKTeX\miktex\bin\x64` and `%LOCALAPPDATA%\MiKTeX\miktex\bin` (user MiKTeX without Programs subfolder)
10. Scoop `shims` and `apps\*\current` directories (when Scoop is installed)
11. MSYS2 `usr\bin`, `mingw64\bin`, and `mingw32\bin` under `C:\msys64`, `C:\msys32`, or `%MSYS2_HOME%` (when `perl.exe` exists there)
12. TeX Live's bundled Perl in `C:\texlive\*\tlpkg\tlperl\bin` (and under `%USERPROFILE%\texlive`)
13. Versioned TeX Live directories (e.g., `C:\texlive\2024\bin\windows`)
14. User-specific installations in `%USERPROFILE%\texlive\*\bin\*` and `%USERPROFILE%\TinyTeX\bin\*`

**Linux:**

1. `/usr/local/bin`
2. `/usr/bin`
3. `/opt/miktex/bin` (MiKTeX installed via APT/AUR)
4. `/snap/bin` (Ubuntu snap packages)
5. `/home/linuxbrew/.linuxbrew/bin` (Linuxbrew)
6. `~/bin` (MiKTeX default symlink target)
7. `~/.local/bin` (user-local tools such as Claude Code's native installer)
8. Versioned TeX Live directories
9. User-specific installations

**Fallback mechanisms:**

- If tools aren't found in standard paths, TeXRA searches `texmf-dist/scripts` directories
- Uses `kpsewhich` to locate Perl scripts (e.g., `latexdiff.pl`)
- Runs Perl scripts with the `perl` interpreter when needed

Opening VS Code from a configured terminal provides the most reliable environment.

3. **Manual installation**:
   - Follow the steps in the [installation guide](/guide/installation)
   - Use the recommended installation methods for your OS

4. **Fix permissions issues**:
   - Make sure you have permission to run these tools
   - On macOS/Linux, check file permissions with `ls -la`

## API connection issues

### API key problems

**Problem**: Error messages related to API keys or authentication failures.

**Solutions**:

1. **Verify API keys**:
   - VS Code extension: open **Settings → Models → API keys** and re-enter the key for the affected provider
   - CLI: set the provider's API-key environment variable (or connect a provider subscription with `texra auth chatgpt login`)

2. **Check API key validity**:
   - Verify your API keys are active in the provider dashboards
   - Check for billing issues or usage limits

3. **Network issues**:
   - Make sure your network allows connections to API endpoints
   - Check whether a firewall or network policy is blocking the connection

4. **Provider status**:
   - Check the status pages for OpenAI, Anthropic, or Google
   - Temporary API outages may cause connection issues

## Document processing issues

### LaTeX compilation and diff errors

- **Check the toolchain**: Run `texra doctor` to confirm `latexmk`, `pdflatex`, `bibtex`, `biber`, `latexdiff`, and `latexindent` are found on `PATH`.
- **Verify standalone compilation**: Make sure the original `.tex` document compiles cleanly outside of TeXRA before running a diff or extraction task.
- **Missing LaTeX packages**: Install missing style files with `tlmgr install <pkg>` (TeX Live) or the MiKTeX Console.
- **Diff fails to compile**: Complex custom macros or unclosed math environments can conflict with `latexdiff` markup. Format both files first (`latexindent` or `tex-fmt`), or lower **Math markup in diffs** on **Settings → LaTeX → Compile & diff**.

### TikZ and image processing errors

- **Verify Ghostscript and GraphicsMagick / ImageMagick**: Rasterizing PDFs for models without native PDF support requires both tools (`gm version` or `convert -version`, and `gs --version`).
- **Custom TikZ packages or macros**: Add custom packages to `"texra.latex.tikzTemplate"` and custom style paths to `"texra.latex.tikzInputDirectory"` in `.texra/config.json` (see [TikZ figures](./tikz-figures.md#customizing-tikz-processing)).

## AI model and output issues

### Timeouts, context limits, or weak results

- **Rate limits and quota**: Check your provider dashboard if requests fail with quota or billing errors.
- **Large documents**: If a run times out or hits the output token limit on a long `.tex` file, split the file into per-section inputs or raise the model's max output tokens.
- **Slow turnaround**: Document tasks run multi-pass reasoning and can take 10–30 minutes on frontier reasoning models. For quick edits, pick a faster model (`google/gemini-3.8-flash`, `anthropic/claude-haiku-4-5-20251001`, `deepseek/deepseek-flash`, or `openai/gpt-6-luna`), or use an interactive chat agent instead.
- **Stronger reasoning**: For hard derivations, proofs, or complex merges, use a flagship model (`anthropic/claude-fable-5-1`, `anthropic/claude-opus-5-5`, `openai/gpt-6-astra`, `openai/gpt-6.1-sol`, or `google/gemini-3.1-pro-preview`) and enable reflection (`--reflect` or additional `task.requests` passes).

### Missing or truncated output files

1. **Locate the run folder**:
   - In VS Code, check **Generated Files** in the ProgressBoard or click **Open in run storage** (<wa-icon library="texra" name="folder-open"></wa-icon>) to open `executions/<run-id>/`.
   - Each revision writes its extracted file under its input filename (e.g., `r0/draft.tex`, `r1/draft.tex`), alongside the raw model response `r0/output.xml`.
2. **Repair malformed XML**:
   - Document tasks wrap their output in `<documents><document name="...">...</document></documents>`.
   - If the model hits its output token limit or drops the closing `</document>` / `</documents>` tag, extraction fails. Open `r0/output.xml` in the run folder and restore the missing closing tag to recover the text:

<XmlRepairCard />

<p class="hero-caption">A dropped <code>&lt;/documents&gt;</code> breaks extraction. Open <code>r0/output.xml</code> and restore the closing tag to recover the run.</p>

### High memory use in long CLI sessions

**Problem**: A `texra` session that has run for days, or launched many
subagents, slows down and eventually exits with a `JavaScript heap out of
memory` error.

**Solutions**:

1. **Update TeXRA**: 0.40.8 and later release the per-subagent and
   per-request state that earlier versions kept for the whole session.
2. **Raise the heap limit** for very long runs. Node caps the heap at a few
   gigabytes by default:

   ```bash
   NODE_OPTIONS=--max-old-space-size=8192 texra chat
   ```

3. **Capture a heap snapshot** if memory still grows, so the retained objects
   can be inspected in Chrome DevTools:

   ```bash
   NODE_OPTIONS=--heapsnapshot-near-heap-limit=1 texra chat
   ```

   Node writes a `.heapsnapshot` file into the working directory right before
   it would run out of memory. Attach it to a bug report.

## Debugging tips

### Using ProgressBoard

The ProgressBoard is your main debugging tool in VS Code. Read the [ProgressBoard guide](./progress-board.md) for a full walkthrough.

1. **Open the ProgressBoard**: Select the TeXRA icon in the Secondary Side Bar and click **Tasks**, or run **TeXRA: Show Tasks** from the Command Palette.
2. **Inspect logs**: Entries are color-coded by severity (green for info/success, yellow for warnings, red for errors) and expand to show nested tool calls and model responses:

<ProgressLogHero />

<p class="hero-caption">ProgressBoard color-codes every entry by severity (green info/success, yellow warnings, red errors), with task-id chips and expandable nested detail.</p>

3. **Copy diagnostics**: Select `⋯` → **Copy diagnostics** on a task header to copy the task ID, model, status, output paths, and any compile errors for a bug report.

### Getting support

- **GitHub Issues**: Search or open an issue on [LionSR/TeXRA](https://github.com/LionSR/TeXRA/issues) with your OS, TeXRA version, reproduction steps, and `texra doctor` or **Copy diagnostics** output.
- **Email**: For private reports, write to [contact@texra.ai](mailto:contact@texra.ai).

## Next steps

If you've resolved your issue or want to learn more about TeXRA:

- [Best practices](/guide/best-practices): learn how to use TeXRA effectively
- [Configuration](/guide/configuration): customize TeXRA for your needs
- [Agent reference](/guide/built-in-agents): explore the available agents
