# Troubleshooting

Even the best research assistants (human or AI) have off days. This guide helps you diagnose and resolve common issues you might encounter when using TeXRA. We've organized troubleshooting tips by category to help you quickly find solutions to specific problems.

## Installation Issues

### Extension Not Loading

**Problem**: TeXRA doesn't appear in the sidebar or shows errors during load.

**Solutions**:

1. **Check VS Code compatibility**:

   - Ensure you're running VS Code version 1.96.2 or newer
   - Update VS Code if needed

2. **Verify installation**:

   - Go to Extensions view (Ctrl+Shift+X)
   - Search for "TeXRA"
   - If not installed or disabled, install or enable it
   - Try reinstalling from the VSIX file

3. **Check error logs**:

   - Open Output panel (Ctrl+Shift+U)
   - Select "TeXRA" from the dropdown menu
   - Look for specific error messages

4. **Check extension conflicts**:
   - Temporarily disable other extensions that might conflict
   - Restart VS Code and check if TeXRA works

### Dependency Installation Problems

**Problem**: Error messages about missing dependencies like LaTeX, Perl, or GraphicsMagick.

**Solutions**:

1. **Verify dependencies**:
   Run these commands in your terminal to check installations:

   ```bash
   pdflatex --version
   perl --version
   gm version  # For GraphicsMagick
   gs --version  # For Ghostscript
   ```

2. **Check PATH environment**:

   - Ensure installation directories are in your system PATH
   - Restart your terminal and VS Code after updating PATH

3. **Manual installation**:

   - Follow the detailed installation steps in the [Installation Guide](/guide/installation)
   - Use the recommended installation methods for your OS

4. **Fix permissions issues**:
   - Ensure you have adequate permissions to run these tools
   - On macOS/Linux, check file permissions with `ls -la`

## API Connection Issues

### API Key Problems

**Problem**: Error messages related to API keys or authentication failures.

**Solutions**:

1. **Verify API keys**:

   - Open TeXRA in VS Code
   - Click "Set API Key" option
   - Re-enter your API keys carefully

2. **Check API key validity**:

   - Verify your API keys are active in the provider dashboards
   - Check for any billing issues or usage limits

3. **Network issues**:

   - Ensure your network allows connections to API endpoints
   - Check if you need to configure proxy settings

4. **Provider status**:
   - Check the status pages for OpenAI, Anthropic, or Google
   - Temporary API outages may cause connection issues

### OpenRouter Connectivity

**Problem**: Issues connecting to models via OpenRouter.

**Solutions**:

1. **OpenRouter configuration**:

   - Verify your OpenRouter API key is correctly set
   - Check that `texra.model.useOpenRouter` is set to `true`

2. **Model availability**:

   - Ensure the requested model is available via OpenRouter
   - Check the OpenRouter dashboard for model status

3. **Rate limiting**:
   - OpenRouter may have different rate limits than direct APIs
   - Check for rate limit error messages in the logs

## Document Processing Issues

### LaTeX Processing Errors

**Problem**: Errors when processing LaTeX documents.

**Solutions**:

1. **Verify LaTeX installation**:

   - Ensure your LaTeX distribution is properly installed
   - Check if required packages are installed
   - Run `tlmgr list --only-installed` (TeX Live) or check MiKTeX Package Manager

2. **Document validation**:

   - Verify the document compiles correctly outside of TeXRA
   - Fix any LaTeX errors in the original document

3. **Package dependencies**:

   - Some LaTeX packages might be missing
   - Install required packages using your LaTeX package manager

4. **File path issues**:
   - Ensure file paths don't contain special characters
   - Use relative paths within your workspace

### TikZ Figure Extraction Problems

**Problem**: Issues with extracting or compiling TikZ figures.

**Solutions**:

1. **TikZ package installation**:

   - Verify TikZ and PGF packages are installed
   - Check for other required TikZ libraries

2. **Template configuration**:

   - Customize the TikZ template in settings to include necessary packages:

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

### Image Processing Issues

**Problem**: Errors related to image or PDF processing.

**Solutions**:

1. **GraphicsMagick/ImageMagick**:

   - Verify installation with `gm version` or `convert -version`
   - Reinstall if necessary

2. **Ghostscript**:

   - Check installation with `gs --version`
   - Ensure compatible version (9.52 recommended for Windows)

3. **Permission issues**:

   - Ensure write permissions in output directories
   - Check temporary directory permissions

4. **Format compatibility**:
   - Some image formats might not be supported
   - Convert images to PNG or JPG for better compatibility

## AI Model Issues

### Model Response Errors

**Problem**: Errors when getting responses from AI models.

**Solutions**:

1. **Check API quotas and limits**:

   - Verify you haven't exceeded usage limits
   - Check billing status for your API account

2. **Response timeout**:

   - For large documents, the model might timeout
   - Try breaking down the task into smaller chunks
   - Enable streaming for long responses:

   ```json
   "texra.model.useStreaming": true
   ```

3. **Context length**:

   - Documents might exceed the model's context window
   - Use models with larger context windows for big documents
   - Split large documents into smaller parts

4. **Model-specific issues**:
   - Some models might have specific limitations
   - Check if the task is appropriate for the selected model
   - Try a different model for your task

### Quality Issues

**Problem**: Low-quality or unexpected outputs from AI models.

**Solutions**:

1. **Improve instructions**:

   - Be more specific in your instructions
   - Provide clear examples of desired outputs
   - Specify what should and shouldn't be changed

2. **Enable reflection**:

   - Turn on the "Reflect" option to allow the model to review its work
   - This often improves output quality significantly

3. **Use better models**:

   - Upgrade to more capable models for complex tasks
   - Try Claude 3 Opus or GPT-4o for highest quality
   - Match the model to your specific task

4. **Reference materials**:
   - Provide better reference files to guide the model
   - Include examples of desired style and formatting

## Interface Issues

### File Selection Issues

**Problem**: Problems with selecting or managing files in TeXRA.

**Solutions**:

1. **Workspace configuration**:

   - Ensure you're working within a VS Code workspace
   - Open a folder rather than individual files

2. **File path issues**:

   - Avoid very long file paths or special characters
   - Use relative paths within the workspace

3. **File list not updating**:

   - Click the refresh icon next to the file type
   - Restart VS Code if file lists remain outdated
   - Check file extension settings to ensure your files are included:

   ```json
   "texra.files.included.inputExtensions": [".txt", ".tex", ".md"]
   ```

4. **Multiple file selection issues**:
   - Verify the multiple selection panel is expanded
   - Try adding files one by one instead of in bulk
   - Check the browser console for any JavaScript errors

## Output File Issues

### Missing Output Files

**Problem**: Output files are not generated or cannot be found.

**Solutions**:

1. **Check file paths**:

   - Verify where TeXRA is saving output files
   - Look in the same directory as the input file
   - Check the ProgressBoard log for file paths

2. **Permission issues**:

   - Ensure you have write permissions in the output directory
   - Try running VS Code with administrator/sudo privileges

3. **Naming conflicts**:

   - Check if output files exist but with unexpected names
   - Look for files with pattern: `original_filename_agent_r0_model.extension`

4. **Process interruption**:
   - The AI process might have been interrupted before completion
   - Check the ProgressBoard for error messages or signs of interruption

### Output File Corruption

**Problem**: Generated output files are incomplete or corrupted.

**Solutions**:

1. **Incomplete generation**:

   - Check if the AI reached the token limit
   - Enable streaming for more reliable completion:

   ```json
   "texra.model.useStreaming": true
   ```

2. **XML parsing issues**:

   - TeXRA uses XML to structure its output (e.g., `<document>...</document>`).
   - Malformed XML (e.g., missing closing tags like `</document>`) generated by the LLM can cause extraction failures.
   - **Solution:** Check the raw output file (e.g., `*_r0_*.xml`) for XML structure problems. Manually add missing closing tags or fix other structural errors, then re-run any necessary processing or manually extract the content.

3. **Encoding problems**:

   - Ensure consistent text encoding (UTF-8 recommended)
   - Check for special characters that might cause issues

4. **File size limits**:
   - Very large outputs might be truncated
   - Break down large tasks into smaller parts

## Performance Issues

### Slow Response Times

**Problem**: TeXRA operations take too long to complete.

**Solutions**:

1. **Model selection**:
   - Faster models: Gemini Flash, Claude Haiku, GPT-4o Mini
   - Match model to task complexity
   - Reserve powerful models for tasks that need them
2. **Document size**:
   - Large documents take longer to process
   - Break down large documents into smaller chunks
   - Use only essential context files
3. **Network issues**:
   - Check your internet connection speed
   - API requests might be delayed by network issues

## LaTeX Diff Issues

### Diff Generation Failures

**Problem**: LaTeX diff fails to generate or produces errors.

**Solutions**:

1. **LaTeX compatibility**:

   - Ensure both documents use compatible LaTeX commands
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

   - Ensure consistent encoding across files (UTF-8 recommended)
   - Check for special characters that might cause issues

4. **Document validation**:
   - Verify both documents compile correctly independently
   - Fix any LaTeX errors before attempting diff

### Diff Visualization Problems

**Problem**: LaTeX diff output is difficult to read or doesn't show changes correctly.

**Solutions**:

1. **LaTeX style conflicts**:
   - Custom document classes might conflict with diff markup
   - Try simplifying the preamble for diff documents
2. **Complex changes**:
   - Very large or complex changes might not display well
   - Break down the diff into smaller sections
   - Consider using the intelligent merge feature instead

## Integration Issues

### VS Code Integration Problems

**Problem**: Issues with TeXRA's integration with VS Code features.

**Solutions**:

1. **Extension conflicts**:
   - Disable other LaTeX extensions temporarily
   - Enable one by one to identify conflicts
2. **Version incompatibility**:
   - Update VS Code to the latest version
   - Ensure TeXRA is up to date
   - Check the minimum VS Code version requirement

### LaTeX Workshop Integration

**Problem**: Conflicts or issues with LaTeX Workshop extension.

**Solutions**:

1. **Output directory conflicts**:
   - Configure consistent output directories:
   ```json
   "latex-workshop.latex.outDir": "%DIR%/build",
   "texra.files.ignored.directories": ["build"]
   ```

## Debugging Tips

### Using ProgressBoard

The ProgressBoard is your main debugging tool. See the [ProgressBoard Guide](../guide/progress-board.md) for a full explanation of its features.

Key points for troubleshooting:

1. **Access ProgressBoard**:

   - Look for "TeXRA ProgressBoard" in the panel at the bottom of VS Code
   - If not visible, open it via the Command Palette: "TeXRA: Show ProgressBoard"

2. **Interpreting logs**:

   - Green entries: Information and successful operations
   - Yellow entries: Warnings that might affect performance
   - Red entries: Errors that need attention

3. **Finding specific information**:

   - Use the search function to find relevant messages
   - Look for task IDs to track specific operations
   - Expand nested entries to see detailed information

4. **Sharing logs for support**:
   - Copy relevant sections from the ProgressBoard
   - Include them when reporting issues on GitHub

### Getting Support

If you can't resolve an issue using this guide:

1. **Check GitHub issues**:

   - Search existing issues on the [TeXRA repository](https://github.com/texra-ai/texra-issues/issues)
   - Look for similar problems and solutions

2. **Report new issues**:

   - Provide detailed information about your environment
   - Include steps to reproduce the problem
   - Attach relevant log excerpts from ProgressBoard
   - Mention your OS, VS Code version, and TeXRA version

3. **Temporary workarounds**:
   - Try alternative workflows while waiting for a solution
   - Use different models or agents that might work better
   - Consider splitting complex tasks into simpler ones

## Next Steps

If you've resolved your issue or want to learn more about TeXRA:

- [Best Practices](/reference/best-practices) - Learn how to use TeXRA effectively
- [Configuration](/guide/configuration) - Customize TeXRA for your needs
- [Agent Reference](/reference/agents) - Explore the different agents available
