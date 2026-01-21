# Installation Guide

## System Requirements

- **Visual Studio Code**: Version 1.99 or newer
- **Operating System**: Windows, macOS, or Linux
- **Internet Connection**: Required for API access

## Installing the Extension

### From Marketplace

1. Open VS Code
2. Go to Extensions (`Ctrl+Shift+X`)
3. Search for "TeXRA"
4. Click Install

<a href="vscode:extension/texra-ai.texra" target="_blank" style="display: inline-block; background-color: #007ACC; color: white; padding: 8px 12px; text-decoration: none; border-radius: 4px; font-weight: bold; margin: 10px 5px 10px 0;">Open in VS Code</a>
<a href="https://open-vsx.org/extension/texra-ai/texra" target="_blank" style="display: inline-block; background-color: #4D5D99; color: white; padding: 8px 12px; text-decoration: none; border-radius: 4px; font-weight: bold; margin: 10px 0 10px 5px;">View on Open VSX</a>

### From VSIX File

1. Obtain the `.vsix` file
2. In VS Code, right-click the file in the explorer
3. Select "Install Extension VSIX"

## Required Dependencies

### LaTeX Distribution

A LaTeX distribution is required for document processing.

| Platform | Installation |
|----------|--------------|
| Windows | [MiKTeX](https://miktex.org/download) or [TeX Live](https://tug.org/texlive/windows.html) |
| macOS | [MacTeX](https://www.tug.org/mactex/mactex-download.html) or `brew install --cask mactex` |
| Linux | `sudo apt-get install texlive-full` |

### Perl

Required for LaTeX tools. Pre-installed on macOS. Included with MiKTeX/TeX Live on Windows. On Linux: `sudo apt-get install perl`

### GraphicsMagick (Recommended)

For image processing. Alternatively, use ImageMagick.

| Platform | Installation |
|----------|--------------|
| Windows | [Download](http://www.graphicsmagick.org/download.html), add to PATH |
| macOS | `brew install graphicsmagick` |
| Linux | `sudo apt-get install graphicsmagick` |

### Ghostscript

Required by GraphicsMagick/ImageMagick for PDF processing.

| Platform | Installation |
|----------|--------------|
| Windows | [Download](https://ghostscript.com/releases/gsdnld.html) |
| macOS | `brew install ghostscript` |
| Linux | `sudo apt-get install ghostscript` |

## Setting Up API Keys

1. Click the TeXRA icon in the Activity Bar
2. Click "Set API Key"
3. Select your provider and enter your key

You can also define keys in a `.env` file in your workspace (e.g., `ANTHROPIC_API_KEY`).

**Get API keys from:**
- [Anthropic Console](https://console.anthropic.com/)
- [OpenAI API](https://platform.openai.com/api-keys)
- [Google AI Studio](https://aistudio.google.com/app/apikey)
- [OpenRouter](https://openrouter.ai/keys)
- [xAI Console](https://console.x.ai/)
- [DeepSeek Platform](https://platform.deepseek.com/api_keys)

## Verifying Installation

1. Open VS Code and click the TeXRA icon
2. The panel should load without errors
3. Try "Indent Current TeX" from the editor title menu

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Extension not loading | Check VS Code version (1.99+), check Output panel for errors |
| LaTeX errors | Verify `latexmk --version` works in terminal |
| Image processing errors | Verify GraphicsMagick and Ghostscript are in PATH |
| API key issues | Check key is correct, check usage limits |

For more help, check [GitHub Issues](https://github.com/texra-ai/texra-issues/issues).

## Next Steps

See the [Quick Start Guide](/guide/quick-start) to begin using TeXRA.
