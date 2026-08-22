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
to confirm available models, and `texra tools list` to check tool availability
(`texra tools status <id>` shows one integration).
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
   - VS Code extension: open the **Dashboard → Models** tab and re-enter the key for the affected provider
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

### OpenRouter connectivity

**Problem**: Issues connecting to models via OpenRouter.

**Solutions**:

1. **OpenRouter configuration**:
   - Verify your OpenRouter API key is set correctly
   - Check that "Use OpenRouter for all models" is enabled in the Dashboard → Providers & Models tab → OpenRouter settings

2. **Model availability**:
   - Make sure the requested model is available via OpenRouter
   - Check the OpenRouter dashboard for model status

3. **Rate limiting**:
   - OpenRouter may have different rate limits than direct APIs
   - Check for rate limit error messages in the logs

## Document processing issues

### LaTeX processing errors

**Problem**: Errors when processing LaTeX documents.

**Solutions**:

1. **Verify LaTeX installation**:
   - Make sure your LaTeX distribution is installed correctly
   - Check whether required packages are installed
   - Run `tlmgr list --only-installed` (TeX Live) or check MiKTeX Package Manager

2. **Document validation**:
   - Verify the document compiles outside of TeXRA
   - Fix any LaTeX errors in the original document

3. **Package dependencies**:
   - Some LaTeX packages might be missing
   - Install required packages with your LaTeX package manager

4. **File path issues**:
   - Make sure file paths don't contain special characters
   - Use relative paths within your workspace

### TikZ figure extraction problems

**Problem**: Issues with extracting or compiling TikZ figures.

**Solutions**:

1. **TikZ package installation**:
   - Verify TikZ and PGF packages are installed
   - Check for other required TikZ libraries

2. **Template configuration**:
   - Customize the TikZ template in settings to include the packages you need:

   ```json
   "texra.latex.tikzTemplate": "\\documentclass[tikz,border=10pt]{standalone}\n\\usepackage{tikz}\n..."
   ```

3. **Path configuration**:
   - Set the correct TikZ input directory:

   ```json
   "texra.latex.tikzInputDirectory": "/path/to/tikz/inputs"
   ```

4. **Compilation errors**:
   - Check build logs for specific error messages
   - Simplify complex TikZ figures that might exceed compiler limits

### Image processing issues

**Problem**: Errors related to image or PDF processing.

**Solutions**:

1. **GraphicsMagick/ImageMagick**:
   - Verify installation with `gm version` or `convert -version`
   - Reinstall if necessary

2. **Ghostscript**:
   - Check installation with `gs --version`
   - Make sure the version is compatible (9.52 recommended for Windows)

3. **Permission issues**:
   - Make sure you have write permission in output directories
   - Check temporary directory permissions

4. **Format compatibility**:
   - Some image formats might not be supported
   - Convert images to PNG or JPG for better compatibility

## AI model issues

### Model response errors

**Problem**: Errors when getting responses from AI models.

**Solutions**:

1. **Check API quotas and limits**:
   - Verify you haven't exceeded usage limits
   - Check billing status for your API account

2. **Response timeout**:
   - For large documents, the model might time out
   - Try breaking the task into smaller chunks
   - Enable streaming for the provider in the **Models** tab so long responses
     arrive incrementally instead of in a single large reply

3. **Context length**:
   - Documents might exceed the model's context window
   - Use models with larger context windows for big documents
   - Split large documents into smaller parts

4. **Model-specific issues**:
   - Some models might have specific limitations
   - Check whether the task is appropriate for the selected model
   - Try a different model for your task

### Quality issues

**Problem**: Low-quality or unexpected outputs from AI models.

**Solutions**:

1. **Improve instructions**:
   - Be more specific in your instructions
   - Provide clear examples of desired outputs
   - Specify what should and shouldn't be changed

2. **Use reflection rounds**:
   - Use agents that include follow-up entries in `userRequest` (or add them via a custom agent)
   - TeXRA runs these additional rounds when they exist, which often improves output quality

3. **Use better models**:
   - Move to more capable models for complex tasks
   - Try Claude Opus 5 or GPT-5.5 for highest quality
   - Match the model to your specific task

4. **Reference materials**:
   - Provide better reference files to guide the model
   - Include examples of desired style and formatting

## Interface issues

### File selection issues

**Problem**: Problems with selecting or managing files in TeXRA.

**Solutions**:

1. **Workspace configuration**:
   - Make sure you're working within a VS Code workspace
   - Open a folder rather than individual files

2. **File path issues**:
   - Avoid very long file paths or special characters
   - Use relative paths within the workspace

3. **File list not updating**:
   - Restart VS Code if file lists remain outdated
   - Confirm that the file uses one of TeXRA's built-in supported extensions

4. **File selection issues**:
   - Try adding files one by one with the picker instead of dragging in bulk
   - If a file does not appear after dropping, confirm that TeXRA supports its extension
   - Check the developer console (`Developer: Open Webview Developer Tools`) for errors

## Output file issues

### Missing output files

**Problem**: Output files are not generated or cannot be found.

**Solutions**:

1. **Check file paths**:
   - Open the generated file from the ProgressBoard file list
   - Use **Open in task storage** from the ProgressBoard toolbar to browse the run folder
   - Check the ProgressBoard log for file paths

2. **Permission issues**:
   - Make sure you have write permission in the output directory
   - Try running VS Code with administrator/sudo privileges

3. **Naming conflicts**:
   - Check whether output files exist under unexpected names
   - Open the run's task storage folder from the ProgressBoard and look for `r0/output.extension`

4. **Process interruption**:
   - The AI process might have been interrupted before completion
   - Check the ProgressBoard for error messages or signs of interruption

### Output file corruption

**Problem**: Generated output files are incomplete or corrupted.

**Solutions**:

1. **Incomplete generation**:
   - Check whether the AI reached the token limit
   - Enable streaming for the provider in the **Models** tab for more reliable
     completion of long outputs

2. **XML parsing issues**:
   - TeXRA uses XML to structure its output (e.g., `<documents>...</documents>`).
   - Malformed XML from the LLM (e.g., a missing closing tag like `</documents>`) can cause extraction failures.
   - **Solution:** Check the raw output file (e.g., `r0/output.xml`) for XML structure problems. Add missing closing tags or fix other structural errors by hand, then re-run any processing you need or extract the content by hand.

<XmlRepairCard />

<p class="hero-caption">A dropped <code>&lt;/documents&gt;</code> breaks extraction. Open <code>r0/output.xml</code> and restore the closing tag to recover the run.</p>

3. **Encoding problems**:
   - Use consistent text encoding (UTF-8 recommended)
   - Check for special characters that might cause issues

4. **File size limits**:
   - Very large outputs might be truncated
   - Break large tasks into smaller parts

## Performance issues

### Slow response times

**Problem**: TeXRA operations take too long to complete.

**Solutions**:

1. **Model selection**:
   - Faster models: Gemini Flash, Claude Haiku, GPT-5.4
   - Match the model to task complexity
   - Reserve the most capable models for tasks that need them
2. **Document size**:
   - Large documents take longer to process
   - Break large documents into smaller chunks
   - Use only essential context files
3. **Network issues**:
   - Check your internet connection speed
   - API requests might be delayed by network issues

## LaTeX diff issues

### Diff generation failures

**Problem**: LaTeX diff fails to generate or produces errors.

**Solutions**:

1. **LaTeX compatibility**:
   - Make sure both documents use compatible LaTeX commands
   - Some complex LaTeX constructs might cause diff issues
   - Simplify documents if necessary

2. **latexdiff installation**:
   - Verify latexdiff is installed: `latexdiff --version`
   - Install or update if needed:

   ```bash
   # Perl installation
   cpan Algorithm::Diff
   cpan Latexdiff
   ```

3. **File encoding**:
   - Use consistent encoding across files (UTF-8 recommended)
   - Check for special characters that might cause issues

4. **Document validation**:
   - Verify both documents compile independently
   - Fix any LaTeX errors before generating the diff

### Diff visualization problems

**Problem**: LaTeX diff output is difficult to read or doesn't show changes correctly.

**Solutions**:

1. **LaTeX style conflicts**:
   - Custom document classes might conflict with diff markup
   - Try simplifying the preamble for diff documents
2. **Complex changes**:
   - Very large or complex changes might not display well
   - Break the diff into smaller sections
   - Consider using the intelligent merge feature instead

## Integration issues

### VS Code integration problems

**Problem**: Issues with TeXRA's integration with VS Code features.

**Solutions**:

1. **Extension conflicts**:
   - Disable other LaTeX extensions temporarily
   - Enable them one by one to identify conflicts
2. **Version incompatibility**:
   - Update VS Code to the latest version
   - Make sure TeXRA is up to date
   - Check the minimum VS Code version requirement

### LaTeX Workshop integration

**Problem**: Conflicts or issues with the LaTeX Workshop extension.

**Solutions**:

1. **Output directory conflicts**:
   - Configure consistent output directories:
   ```json
   "latex-workshop.latex.outDir": "%DIR%/build"
   ```

## Debugging tips

### Using ProgressBoard

The ProgressBoard is your main debugging tool. Read the [ProgressBoard guide](./progress-board.md) for a full explanation of its features.

Key points for troubleshooting:

1. **Access ProgressBoard**:
   - The ProgressBoard shares the TeXRA view in the Secondary Side Bar with the
     launcher: select the TeXRA icon, then switch to the Progress view
   - If it is not visible, open it from the Command Palette: "TeXRA: Show Progress"

2. **Interpreting logs**: entries are colour-coded by severity, and nested
   entries expand to reveal detail: green for information and successful
   operations, yellow for warnings, red for errors that need attention.

<ProgressLogHero />

<p class="hero-caption">ProgressBoard colour-codes every entry by severity (green info/success, yellow warnings, red errors), with task-id chips and expandable nested detail.</p>

3. **Finding specific information**:
   - Look for task IDs to track specific operations
   - Expand nested entries to see detailed information

4. **Sharing logs for support**:
   - Copy relevant sections from the ProgressBoard
   - Include them when reporting issues on GitHub

### Getting support

If this guide does not resolve your issue:

1. **Check GitHub issues**:
   - Search existing issues in the [TeXRA repository](https://github.com/LionSR/TeXRA/issues)
   - Look for similar problems and solutions

2. **Report new issues**:
   - Describe your environment in detail
   - Include steps to reproduce the problem
   - Attach relevant log excerpts from ProgressBoard
   - Mention your OS, VS Code version, and TeXRA version

3. **Temporary workarounds**:
   - Try alternative workflows while waiting for a fix
   - Use different models or agents that might work better
   - Consider splitting complex tasks into simpler ones
4. **Direct contact**:
   - For critical bugs or private reports, email [contact@texra.ai](mailto:contact@texra.ai)

## Next steps

If you've resolved your issue or want to learn more about TeXRA:

- [Best practices](/guide/best-practices): learn how to use TeXRA effectively
- [Configuration](/guide/configuration): customize TeXRA for your needs
- [Agent reference](/guide/built-in-agents): explore the available agents
