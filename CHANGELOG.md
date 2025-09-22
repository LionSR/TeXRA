# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Features

- Add workspace-aware `glob`, `grep`, and `ls` tools to the default registry and chat agent so every workflow can inspect files safely
- Introduce a `web_fetch` tool that downloads web pages and converts their HTML into Markdown for review inside agent workflows
- Add dedicated `read_file`, `write_file`, and `edit_file` tools and wire them into the default chat agent for clearer, safer workspace editing
- Ship a built-in read-only `ask` agent so you can inspect project files without risking accidental changes
- Show the active instruction at the top of the Progress Board with expandable and copyable text, keeping prompts visible while a run executes
- Allow DeepSeek chat models to call tools via function calling so they can participate fully in tool-use workflows

### Bug Fixes

- Keep tool-use runs visible by automatically updating the Progress Board filter when a workflow starts in another stream
- Log agent errors inside their stream groups so failures surface directly in the Progress Board timeline
- Honor `.gitignore_global` rules in the `ls` tool so global exclusions stay hidden during workspace listings
- Restore missing `output_text` segments in OpenAI Responses so assistants no longer drop parts of their replies

### Improvements

- Summarize tool-use logs with clearer titles, error highlighting, and expandable sections that collapse very long outputs into a scrollable view

## [0.33.7] - 2025-09-18

### Features

- Add install and re-check actions to the dependency banner so required tools can be installed or revalidated in place
- Separate tool-use streams in the Progress Board with All / Workflow / Tool Use filters and clearer tab titles
- Show tool-use hints in the agent dropdown to highlight agents that launch tool workflows
- Add a copy button to each model response entry for quickly reusing generated text
- Persist tool-use sessions across restarts, including a resume command and settings to control retention

### Bug Fixes

- Decode HTML entities in follow-up messages so languages like Chinese render correctly in the Progress Board
- Accept legacy tool configuration keys to keep existing tool-use agents working after the prefill cleanup
- Fix LaTeX replacements for beamer column layouts and Schrödinger names to avoid corrupting generated files
- Skip rendering empty model response logs so the Progress Board no longer shows blank entries
- Disable workflow toolbar actions while viewing tool-use streams to prevent unsupported commands from running
- Trim Anthropic requests and block empty user messages to avoid API errors

## [0.33.6] - 2025-09-14

### Features

- Show a banner when required dependencies are missing and check tools before running
- Add `kimi2` to the model list
- Clarify output file controls in the webview
- Improve tool-use agent infrastructure with better tool definition and parsing

### Bug Fixes

- Detect Ghostscript correctly on Windows and stop flagging GraphicsMagick when ImageMagick is installed
- Show tool-use agents in the dropdown when enabled and restore agent configuration banners
- Improve model API key banner behavior and multi-file toggle labels
- Hide file selection notification when choosing reference, auxiliary, or media files in the main view
- Skip empty thinking logs in model reasoning display

### Improvements

- Updated AI SDK packages: Anthropic SDK 0.62.0, Google GenAI 1.19.0, OpenAI 5.20.2
- Enhanced webview infrastructure with centralized theme handling and message management
- Improved file dialog helpers for better cross-platform compatibility

## [0.33.5] - 2025-09-07 💪

### Features

- Replace Qwen Max with Qwen3 Max for improved reasoning and 256k context
- Update Qwen Plus to 2025-07-28 snapshot with hybrid reasoning and 1M context
- Mark Qwen Plus and Qwen Turbo as reasoning models with optional `enable_thinking`
- Update Moonshot Kimi models to K2 0905 preview and add turbo variant
- Add setting to enable/disable GPT-5 reasoning summaries due to user tier limitations
- Add configuration banner for missing agent files with quick setup actions
- Add visual indicator for agents with multiple output support in dropdown
- Replace "(no key)" with ✗ symbol for cleaner model dropdown display

## [0.33.4] - 2025-09-03

### Features

- Support round-specific reflection prompts and iteration across multiple rounds
- Record per-round agent and tool state for future analysis
- Highlight missing API keys for models with provider-specific banner and setup links
- Add model metadata tooltips showing provider, context window, and cost in model selector dropdown

### Bug Fixes

- Generalize output handling and packaging scripts to work with any round count
- Track total executed rounds in agent statistics
- Consolidate API key setup alerts into banner to avoid multiple popups
- Unescape underscores in LaTeX references to remove unnecessary escape characters

## [0.33.3] - 2025-08-29

### Features

- Include `.bbl` files when searching for reference files
- Guide new users through API key setup with links to provider pages
- Show persistent “Set API Key” banner and status bar warning until a key is configured

### Bug Fixes

- Restrict GPT OSS models to OpenRouter only
- Improve API key detection to check environment variables and only show intro message when no keys are configured

## [0.33.2] - 2025-08-25

### Features

- Add sample project command (`texra.createSampleProject`) to help new users get started with a complete example
- Add chat tool-use agent for interactive document-based conversations
- Stream model responses separately from reasoning for better visibility into agent thinking
- Show helpful empty-state placeholder in progress view with quick links when no tasks are running
- Add interactive launch page to documentation site with repository configuration forms

### Bug Fixes

- Show welcome dialog asynchronously to ensure it displays properly on first launch
- Use active task output selection for pack and clean operations
- Toggle placeholder visibility correctly when clearing progress view logs

### Improvements

- Enhanced progress view with better empty state handling and clearer visual feedback

## [0.33.1] - 2025-08-22

### Features

- Detect arXiv source file type and handle plain `.tex` downloads without extraction
- Add descriptive tooltips for Input, Reference, Auxiliary and Media file selectors in the main webview
- Show onboarding tooltips on first use of the input file selector or model picker, with a "Never remind again" option
- Add real-time streaming display for model reasoning/thinking processes (Claude, DeepSeek, o1)

### Bug Fixes

- Restrict extension to single workspace folder to prevent initialization issues
- Set welcome dialog flag only after the dialog displays to avoid missing messages

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
