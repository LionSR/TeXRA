# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Features

- Add descriptive tooltips for Input, Reference, Auxiliary and Media file selectors in the main webview

## [0.33.0] - 2025-08-19 🎂 Birthday Edition

### Features

- Show TeXRA task status in the VS Code status bar
- Automatically resize large images (> 2000px) before base64 encoding to optimize memory usage and performance
- Allow disabling LaTeX formatting and silencing missing `latexindent` warnings
- Added configurable `texra.maxImageDimension` setting to control the maximum image size threshold
- Add "New" button in main view to reset all fields
- Add `texra.includeToolUseAgents` setting to optionally show built-in tool-use agents in the agent dropdown
- Prompt users to install LaTeX Workshop extension with "Never remind again" option for enhanced LaTeX features

### Bug Fixes

- Stabilize status bar command registration and task cancellation handling
- Detect MSYS2 Perl directories on Windows so `latexdiff` can find `perl`
- Prevent first task from being marked as error when progress view loads
- Rename OpenRouter alias `anthropic/claude-opus-4.1:thinking` to `anthropic/claude-opus-4.1`
- Fixed DeepSeek model streaming response aggregation
- Fixed Google model streaming to preserve finish reason correctly
- Respect existing LaTeX Workshop configuration when updating settings

### Improvements

- Enhanced image processing with dimension validation, better error handling, and improved logging
- Enhanced LaTeX environment setup with better extension recommendations
- Improved streaming API stability for various model providers
- Increased robustness of LaTeX extraction from agent responses

## [0.32.10] - 2025-08-13

### Bug Fixes

- Prompt users to open a workspace folder when none is active to avoid initialization.

## [0.32.9] - 2025-08-09

### Bug Fixes

- Upload PDFs to OpenAI via the Files API instead of embedding base64 data in Responses requests.

## [0.32.8] - 2025-08-09

### Features

- Enable model streaming & response APIs by default:
  - `texra.model.useOpenAIResponsesAPI` now defaults to `true` (was `false`)
  - `texra.model.useNativeGoogleSDK` now defaults to `true` (was `false`)

## [0.32.7] - 2025-08-08

### Features

- Added Claude Opus 4.1 (regular and thinking) models (`opus41` and `opus41T`)
- Added GPT OSS 120B and 20B reasoning models (`gptoss` and `gptoss-`)
- Added GPT-5 family models (`gpt5`, `gpt5-`, `gpt5--`)
- Route GPT OSS models through OpenAI Responses API by default

### Bug Fixes

- Updated OpenAI, Anthropic, and Gemini SDKs to their latest releases

## [0.32.6] - 2025-08-03

### Features

- **Follow-up Chat**: Continue conversations with tool-use agents (web search, code execution) directly in the progress view with multi-line input support (Shift+Enter for new lines, Enter to send)
- **Code Syntax Highlighting**: Code blocks in progress view now have syntax highlighting that automatically adapts to your VS Code theme

## [0.32.5] - 2025-07-31

### Features

- Added syntax highlighting for code blocks in the progress view
- Introduced tool-use agents with support for web search and code execution
- Added stream sorting option in progress view settings

### Bug Fixes

- Fixed duplicate agents appearing in the dropdown menu
- Improved theme switching for code highlighting
- Fixed various issues with file list button interactions

## [0.32.4] - 2025-07-25

### Features

- Right-click on YAML agent files in Explorer to quickly add them to your agent list
- Improved agent configuration with better file type handling and validation

### Bug Fixes

- Fixed restoration of agent states when reopening TeXRA sessions
- Improved agent metadata handling for better performance tracking

## [0.32.3] - 2025-07-20

### Features

- Improved statistics view UI with cleaner rendering and streamlined display

## [0.32.2] - 2025-07-19

### Bug Fixes

- Fixed missing LaTeX diff message rendering in progress view

## [0.32.1] - 2025-07-10

### Features

- Default model switched to **Gemini 2.5 Pro**
- Added Grok 4 model with extended context window support

## [0.32.0] - 2025-07-07

### Features

- Claude Sonnet 4T (Thinking) model set as default
- Added Grok 4 Beta model support with 131k context window

## [0.31.10] - 2025-07-04

### Features

- Progress view templates for consistent UI
- Markdown rendering restored with KaTeX math support
- Diff errors now displayed as helpful tooltips

## [0.31.9] - 2025-07-01

### Features

- Improved file list display in progress view
- Missing output files now highlighted with direct links for easy access

## [0.31.8] - 2025-06-28

### Features

- Added diagnostics tool and validation agent
- KaTeX math rendering in progress view
- Smoother streaming updates in progress view

## [0.31.7] - 2025-06-25

### Features

- Added bulk latexdiff-vc runner for comparing multiple file versions
- New tool-use agent capabilities

## [0.31.6] - 2025-06-25

### Features

- Live reasoning updates displayed in progress view
- Improved markdown rendering with better styling

## [0.31.5] - 2025-06-23

### Features

- Redesigned scratchpad and thinking sections
- Microphone transcription with ElevenLabs support

## [0.31.4] - 2025-06-17

### Features

- Settings and history buttons moved to editor title bar for easier access
- Optional audio notification when agent rounds complete
- Enhanced agent creator with better YAML template support

## [0.31.3] - 2025-06-15

### Features

- Clipboard image pasting in instruction box with automatic cleanup
- Added arXiv source processor for research papers
- New deep research model support

## [0.31.2] - 2025-06-08

### Features

- Collapsible LaTeX diff sections for better organization
- Automatic detection of TeX tools on all platforms
- Cleaner error messages throughout the extension

## [0.31.1] - 2025-06-04

### Features

- Added GitHub Copilot model support
- Smoother streaming output display
- Diff view auto-refresh and quick access to compiled outputs

## [0.31.0] - 2025-06-03

### Features

- Google AI thought summaries displayed in progress board
- Improved diff editor with smart word wrap
- Dynamic setting updates without restart

## [0.30.9] - 2025-05-24

### Features

- Automatic cleanup of output files after housekeeping
- Simplified log navigation with collapsible sections
- Unified dropdown interface for tools and auto-extract options

## [0.30.8] - 2025-05-22

### Features

- Clickable output filenames for quick file access
- Improved history browser with better action buttons
- Refined UI spacing and visual consistency

## [0.30.7] - 2025-05-21

### Features

- File progress tracking and diff visualization in progress view
- Updated API pricing information for all models
- Round configuration now available in agent settings

## [0.30.6] - 2025-05-19

### Features

- Updated SDKs for OpenAI, Anthropic, and Google models
- Improved error messages and user feedback

## [0.30.5] - 2025-05-13

### Features

- New command to apply LaTeX replacements to current file
- Added Moonshot Kimi and Alibaba Qwen model support
- Configurable LaTeX diff markup options

## [0.30.2] - 2025-05-06

### Improvements

- Updated Gemini model naming for clarity

## [0.30.1] - 2025-05-06

### Features

- Updated Gemini 2.5 Pro model configuration
- Enhanced quick-start documentation

## [0.30.0] - 2025-05-04

### Features

- Explorer now hides build directories by default
- Enhanced DeepSeek model support
- Improved PDF viewer with better tab management

## [0.29.11] - 2025-05-04

### Features

- Added O4 models support
- Improved DeepSeek integration with official API and OpenRouter

### Improvements

- Updated delete button icon in progress view

## [0.29.10] - 2025-05-04

### Improvements

- Code formatting improvements and stability enhancements

## [0.29.7] - 2025-05-02

### Bug Fixes

- Fixed progress view display issues

## [0.29.2] - 2025-04-22

### Features

- Added Gemini-2.5-Flash model support
- Enhanced Unicode character replacements

## [0.29.0] - 2025-04-17

### Features

- First public release of TeXRA
