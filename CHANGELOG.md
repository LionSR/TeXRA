# Changelog

All notable changes to this project will be documented in this file.

## [0.35.4] - 2026-01-08

### Features

- Added **Memory View** for browsing and managing agent memory entries with delete controls.
- Added **context utilization display** showing percentage of context window used on each API call.
- Automatic conversation compaction for OpenAI Responses API to manage long sessions.
- Configurable context management with thinking block clearing for Anthropic models.

### Bug Fixes

- Fixed canceling rejection by pressing Escape on feedback input.
- Fixed memory list not refreshing after deletion failure.
- Fixed thinking block clearing not triggering properly on the client side.
- Fixed LaTeX math delimiters not rendering correctly in markdown output.
- Fixed conversation messages not syncing after tool-use cycles.
- Fixed log content clearing when falling back to default session kind.
- Fixed abort errors not using correct SDK error type.

### Improvements

- Improved tool use display to distinguish user feedback from errors.
- Unified header styles across history, profile, and memory views.
- Simplified run selector dropdown to show only timestamp.
- Moved task-run temp storage from global to workspace storage for better isolation.
- Updated dependencies: Supabase, MCP SDK.

## [0.35.3] - 2026-01-05

### Features

- Added monthly spending limits for relay users.

### Bug Fixes

- Improved progress board layout with better log grouping and reduced whitespace.
- Fixed relay authentication expiring during long-running sessions.

### Improvements

- Internal refactoring to reduce abstraction overhead and improve code organization.

## [0.35.2] - 2025-12-30

### Bug Fixes

- Fixed symlink handling in workspace path resolution and file dialogs.
- Fixed OAuth callback handling for web environments with localhost fallback.
- Fixed status tooltip clipping by positioning it above the indicator.
- Fixed clean auxiliary files button to use correct trash icon.
- Added resuming status styling and changed stopped status to neutral gray.

### Improvements

- Optimized path conversion to avoid redundant operations.

## [0.35.1] - 2025-12-29

### Features

- Added **Gemini 3 Flash** (`gemini3f`) to the default models list.
- Chat and tool-use agents can now be hosted as remote agents.
- Introduced **Max tier** with access to premium models for subscribed users.
- Added **Researcher Access Program** (free tier) with budget models including
  GPT-5 Mini and Nano.
- Added access expiration system for researcher access program.

### Bug Fixes

- Fixed LaTeX-style backtick quotes in document name extraction.
- Fixed dropdown option selection not updating visually.
- Fixed cloud icon sizing inconsistency in agent dropdown.
- Fixed tool name handling in tool definitions resolver.
- Fixed absolute path handling in file location creation.
- Fixed agent and model selection reverting to defaults.
- Fixed missing usage info in OpenAI Responses API streaming.
- Disabled automatic retries by default to give users explicit control.
- Added tooltips to toolbar buttons across all webviews.
- Clarified reference and auxiliary file selector tooltips.
- Fixed provider cache stale state and Google model path extraction.
- Fixed memory leak from undisposed event listener subscription.
- API Access toggle now visible for all authenticated users.
- Fixed tier config retry after transient failures.
- Fixed race conditions in tier system caching.

### Improvements

- Updated core dependencies: Supabase, fs-extra, OpenAI, webpack, Zod v4.

## [0.35.0] - 2025-12-16

### Bug Fixes

- Fixed OpenAI streaming to collect all reasoning items with web search.
- Fixed Google model response text computation.
- Fixed LaTeX replacement rules causing formatting issues.
- Fixed latexdiff output causing compilation errors.
- Fixed model dropdown resetting media selection when changed.
- Fixed stream list not auto-refreshing when status changes.
- API key banner now hides when the model no longer requires a key.

### Improvements

- Updated core dependencies: MCP SDK, Supabase, OpenAI, Zod, webpack.

## [0.34.10] - 2025-12-13

### Features

- Added **GPT-5.2** (`gpt52`, `gpt52pro`) to the default model list with xhigh
  reasoning effort support for extended problem-solving tasks.
- Introduced **flexible user groups** with permission-based access control,
  supporting multi-group visibility and tier levels (Max/Ultra) for remote
  agents.
- Added a **todo list UI** in the progress view for tool-use agents, letting
  you track task progress during agent workflows.
- Added **Research agent** for analytical derivations and scientific research
  tasks.
- Added **Search agent** to the default tool-use agents list for web search
  workflows.
- Profile view now displays a **multi-output support indicator** for agents
  that support multiple outputs.

### Bug Fixes

- Resolved duplicate sign-in messages caused by authentication race conditions.
- Fixed profile view agent selection reliability when switching between
  remote agents.
- OpenAI streaming now correctly includes reasoning items when web search
  results reference them.
- Fixed agent selection race condition when switching session types.

### Improvements

- Updated OpenAI reasoning effort to HIGH for improved model performance.

## [0.34.9] - 2025-12-10

### Features

- Added **native web search** support for Anthropic and OpenAI models, with
  real-time search results displayed in the progress view during streaming.
- Introduced a new **Web Search** tool-use agent optimized for research queries
  that leverage provider-native search capabilities.
- Added **OpenAI deep research models** (`o3-deep-research`, `o4-mini-deep-research`)
  for extended reasoning tasks.
- Updated **DeepSeek models to V3.2** with streaming reasoning support via
  OpenRouter.
- Added **getting started guidance** that appears when opening an empty folder,
  helping new users bootstrap their first project.

### Bug Fixes

- Fixed Windows path handling in progress view stream tabs, resolving duplicate
  tab issues on Windows systems.
- Agent selection now persists correctly when switching between sessions or when
  the selected agent isn't in the current options list.
- Remote agents with multiple output variants now group correctly like local
  agents.
- Improved content block ordering in Anthropic streaming responses, fixing
  issues with interleaved thinking and text blocks.
- Fixed figure path resolution for input files located in subdirectories.
- Fixed `\input` path compatibility by normalizing leading `./` prefixes.
- User-cancelled requests no longer trigger automatic retries.
- Fixed banner display issues when refreshing the webview input.

### Improvements

- Refactored internal HTTP status handling using the `http-status-codes`
  package for better maintainability.
- Consolidated prompt utilities and Zod schemas for improved type safety.
- Updated core dependencies: Anthropic SDK 0.71.2, Google GenAI 1.32.0,
  KaTeX 0.16.27, winston 3.19.0.

## [0.34.8] - 2025-12-04

### Features

- Added **DeepSeek V3.2 Speciale** (`deepseekT+`), a high-compute variant
  optimized for maximum reasoning and agentic performance with 163k context.
- Enabled tool calling for DeepSeek thinking models so they can participate in
  tool-use workflows.

### Bug Fixes

- Improved tool detection on Unix-like systems for `latexdiff` and related
  utilities.

### Improvements

- Refactored internal schema handling for better type safety and
  maintainability.
- Updated core dependencies for improved stability.

## [0.34.7] - 2025-11-30

### Bug Fixes

- Fixed packing and cleaning operations not working correctly.

## [0.34.6] - 2025-11-30

### Features

- Introduced **Remote Agents** with Supabase authentication, letting you browse
  and run cloud-hosted agents directly from the new Profile view.
- Added **manual retry controls** so you can retry failed API requests on demand
  instead of relying solely on automatic retries.
- Display provider icons in the model dropdown for quick visual identification
  of each model's source.

### Improvements

- Added Claude Opus 4.5 (thinking and regular) to the default model catalog,
  VS Code settings, and documentation so the latest Anthropic tier is
  available out of the box.
- Widened agent and model dropdowns by ~20% and added descriptive tooltips
  explaining indicator icons.
- Footer dropdowns now open upward to prevent clipping at the bottom of the
  panel.
- Stream tab close buttons are always visible, making it easier to dismiss
  completed runs.
- File selection lists are now sorted alphabetically by name.
- History view displays the session kind (workflow vs tool use) for each entry.

### Bug Fixes

- Resolved duplicate agent names appearing in the dropdown when multiple
  sources define the same agent.
- The API key banner displays reliably on initial webview load.
- arXiv search queries with multiple terms now return more relevant results.

## [0.34.5] - 2025-11-21

### Improvements

- General refactoring to streamline the extension and keep the progress board
  experience smooth.

### Bug Fixes

- Fixed support for the Kimi 2 Thinking model so it streams reliably again.

## [0.34.4] - 2025-11-14

### Features

- Added a **Collect references** helper that gathers the BibTeX entries your project cites and calls out anything missing, so you can tidy bibliographies before submitting.
- Expanded the model catalog with **GPT-5.1** (`gpt51`), offering GPT-5-class reasoning with fresh pricing and full tool support.

### Improvements

- The progress board now loads conversations faster and keeps stream updates responsive, even for long sessions.
- Run reviews feel smoother thanks to persistent run context, clearer timestamps, and an input box that’s ready whenever a follow-up is needed.
- Workspace cleanup is less disruptive: generated artifacts stick around, TeX files are detected more reliably, and `\input{}` paths stay intact.

### Bug Fixes

- Workflow controls once again behave as expected—resume, restart, and stop actions reliably reflect the state of your run.
- Progress board summaries stay in sync with agent defaults and usage totals, preventing stale data from lingering between refreshes.
- Tool calls are steadier across providers, avoiding duplicate uploads, empty payload errors, and missing workflow outputs.
- Bibliography parsing now handles complex citation files without crashing, keeping reference extraction dependable.

## [0.34.3] - 2025-11-07

### Features

- Add a **Clone Overleaf Project** command that initializes a local workspace
  from an Overleaf project so newcomers can bootstrap a folder without manual
  downloads or Git juggling.
- Require approving tool-proposed edits from the progress board, complete with
  a pending approvals queue, unified diffs, and the ability to turn rejection
  notes directly into follow-up instructions.
- Capture XML output summaries—including detected tag contents, serialized
  `<document>` elements, and single-output paths—so orchestrated workflows can
  reuse generated artifacts without re-running the same tools.
- Add dedicated arXiv metadata/search and Crossref DOI lookup tools to the
  default registry so agents can fetch paper details without manual API calls.
- Add Kimi K2 thinking variants to the model catalog so the latest Moonshot
  releases are immediately available in TeXRA.

### Improvements

- Expand the progress board empty state with a direct shortcut to the Overleaf
  clone flow and streamline the header with toolbar session switching, tighter
  dropdowns, and clearer delete affordances.
- Harden the new Overleaf initialization by validating tokens, enforcing
  workspace preflight checks, and surfacing full command output when cloning.
- Render progress tool logs and tour output in YAML to keep structured
  responses readable at a glance.
- Update Kimi K2 naming and pricing while reusing shared vision helpers so
  image attachments stay consistent across providers.
- Stabilize agent logging, tool-use persistence, and continuation reporting so
  usage totals, follow-up prompts, and streaming status badges stay in sync.

### Bug Fixes

- Stabilize Google Gemini tool calls by simplifying stream aggregation and
  aligning tool-call handling with the provider API.
- Keep the new arXiv metadata tools fresh by resetting cached search state so
  repeat lookups always return current abstracts and figure links.
- Guard progress board detail toggles and approval actions to eliminate
  runtime errors while reviewing runs.
- Fix duplicated LaTeX environment tags that produced malformed `eqnarray`
  blocks in generated documents.
- Restore tool-use cost tracking and keep user edit patches synchronized with
  the approvals workflow.
- Prevent YAML log loaders from failing when generated files expose quick
  actions.
- Fall back to inline file upload when OpenAI Files API times out to prevent
  request failures.

## [0.34.2] - 2025-10-31

### Features

- Redesigned the Progress Board with a resizable split layout, a persistent instruction panel with copy support, and inline follow-up controls for polishing, recording, clearing, or sending responses without leaving the log view.
- Streamlined the main command view with toolbar-based file pickers, context-menu toggles that close when clicking elsewhere, and a radio-group session selector to switch between workflow and chat agents faster.

### Improvements

- Format `read_file` text responses with padded line numbers, extend ranged reads to 2,000 lines, and report when callers request windows beyond the file length for easier downstream edits.
- Expand LaTeX cleanup to convert common HTML entities, remove invalid section endings, and expand legacy equation macros into full environments for cleaner compiled documents.

### Bug Fixes

- Return PDFs and common image formats from the `read_file` tool as native attachments with model guidance so binary files are no longer streamed as corrupted text.

## [0.34.1] - 2025-10-24

### Bug Fixes

- Fix toolbar controls and automatic log scrolling in progress view.
- Fix Claude Haiku 4.5T thinking mode not working correctly.
- Fix dropdown menus being cut off at container edges.

### Improvements

- Show inline progress display when polishing instructions instead of notifications.
- Cleaner and more streamlined progress board stream tabs.
- More compact model selection dropdown for better screen space usage.
- Updated core dependencies for improved stability.

## [0.34.0] - [2025-10-19]

### Features

- Add an interactive VS Code walkthrough that guides first-time users through model setup, file selection, and the progress board.
- Expand the Anthropic catalog with Claude Haiku 4.5 (`haiku45T`, `haiku45`), including pricing, capability metadata, and updated documentation.

### Improvements

- Streamline custom agent prompts by keeping all rounds in the `userRequest` list whileth automatically migrating older `userReflect` entries and highlighting anything that still needs attention.
- Ensure the model picker waits for its options to load so newly enabled models reliably appear, even on slower machines.
- Add Magic Polish and microphone recording controls directly to the progress view follow-up input box with auto-resizing textarea for more convenient conversation continuations.
- Update CoT (Chain-of-Thought) agent icon from terminal to list-tree for clearer visual distinction in progress view stream tabs.

### Bug Fixes

- Restore scratchpad exports to reopen the named document you selected when agents generate multiple files.
- Repair tool-use session migration so previously saved runs load and resume without errors.
- Improve OpenAI "thinking" summaries with clearer spacing, making reasoning traces easier to scan in the progress view.
- Keep workflow outputs visible in the progress board when no new files were written, avoiding unnecessary refreshes.
- Show progress board timestamps in your local timezone instead of UTC.

## [0.33.10] - 2025-10-10

### Features

- Add OpenAI GPT-5 Pro (`gpt5pro`) to the model catalog with updated pricing and documentation.
- Prompt for latexdiff math markup before each run so you can pick the right level of equation detail on demand.
- Introduce new `extract_figures` and `extract_tikz_figures` tools so agents can return referenced images and compiled TikZ PDFs as structured attachments.
- Expand the `read_file` tool with ranged reads, letting agents request only the lines they need from large files.

### Improvements

- Streamline LaTeX figure tooling by auto-managing attachment limits, deferring uploads to provider handlers, and keeping prompts lightweight during tool calls.
- Add one-click **Generate diff** controls and auto-select the relevant comparison commit so you can review outdated files without hunting for hashes.
- Refresh the Progress Board with copy buttons, native status styling, and a cleaner layout that keeps model responses, special details, and status logs easy to scan.
- Update the Progress Board empty state with quick links to create a sample project, fetch an arXiv source, or open the user guide.
- Poll OpenAI background responses while gating progress updates, ensuring long-running background runs advance reliably without stray streaming updates.

### Bug Fixes

- Preserve run-group identifiers so agent error logs stay attached to the latest run in the Progress Board timeline.
- Disable streaming automatically whenever background responses are enabled and mark their updates as status messages to keep background replies stable.
- Stop launching agent runs when initialization fails and harden progress event handling to avoid duplicate task groups and stale badges.
- Hide workflow-only model responses from the Progress Board and ensure compare actions run `latexdiff` before opening diffs, keeping the VS Code compare view reliable.
- Improve LaTeX fenced-block parsing—including inline math and `aligned` environments—so generated summaries retain spacing and formatting.
- Default to the first available workflow agent when none is configured, restoring the expected agent selection in new workspaces.
- Keep arXiv downloads inside their staging folder, move `main.tex` files into place, and clean up the temporary directory after processing.

## [0.33.9] - 2025-10-03

### Features

- Introduce new `apply_path` and `download_arxiv_source` tools so agents can apply patches and fetch arXiv sources without leaving TeXRA.
- Default workflow and tool-use pickers to curated Correct and Chat presets, remember multi-output toggles, and automatically seed custom agent directories for new workspaces.
- Add an **Open storage** button in the progress view with richer file refresh feedback so you can inspect run outputs and diffs immediately.
- Add between-round `latexdiff` controls and Texcount mode selection to customize LaTeX comparison and word-count workflows.
- Add Claude Sonnet 4.5 (thinking and regular) to the Anthropic catalog and default model list so the latest Claude release is immediately available in TeXRA.

### Bug Fixes

- Upload Anthropic PDF attachments to the Files API so requests reuse `file_id`s instead of resending large base64 payloads.
- Ensure follow-up Anthropic requests keep the Files API beta header when referencing previously uploaded PDFs.
- Sanitize Anthropic PDF filenames before uploading so nested paths with forbidden characters no longer trigger Files API errors.
- Skip Anthropic token counting when requests already reference Files API assets and defer PDF uploads until after token usage is calculated to avoid countTokens errors.
- Harden tool-use session resume so queued follow-ups, execution state, and multi-output agents restore reliably after reloads.
- Respect `.gitignore` rules across `glob`, `grep`, and file listings to keep excluded paths out of workspace inspections.
- Stabilize custom agent directory initialization and tool-use registry cleanup so default agents appear consistently.
- Guard Google upload pipelines and diagnostics tooling to avoid sending derived media and to surface clearer errors when runs fail.

## [0.33.8] - 2025-09-30

### Features

- Split the agent picker into workflow and tool-use sessions with a toggle so users can quickly see the agents that apply to their workflow.
- Update Gemini 2.5 Flash preview entries to the September 2025 release.
- Refresh Qwen-Max and Qwen Plus integrations with updated pricing, naming, and thinking support in the DashScope handler.

### Bug Fixes

- Improve scratchpad markdown fallbacks by converting HTML with Turndown when Pandoc is unavailable, keeping formatting stable across environments.
- Ensure prompt XML exports always resolve to absolute paths for both workspace files and execution-scoped runs to avoid downstream lookups failing.
- Harden progress view state handling with validation on task groups, toggles, and stream statuses to prevent invalid data from corrupting summaries.
- Restore main view configurations using the shared task-state helper so history entries hydrate without manual JSON juggling.
- Cap `read_file` tool responses at the first 400 lines to keep large files from overwhelming tool-use transcripts.
- Enable interleaved thinking by default for supported Claude tool-use agents so follow-up reasoning stays in sync with tool results.
- Rebuild the agent selector footer with a compact session toggle and per-session dropdowns so the UI stays narrow and focused.
- Populate the tool-use dropdown from the dedicated `texra.toolUseAgents` list and automatic discovery so the old include toggle is no longer needed.
- Trim the default tool-use agent list to the conversational presets so specialized utilities stay opt-in per workspace.
- Narrow the model selector width and streamline tool-use labelling so dropdowns stay tidy without superscript markers.

### Bug Fixes

- Migrate history view toggle state persistence from JSON strings to structured arrays so expansion settings reliably load across versions.
- Clear queued restore context when the main view fails to initialize, preventing stale state from resurfacing on the next activation.
- Guard the model select observer lifecycle and update queue so successive model option messages render reliably without leaking observers.

## [0.33.7] - 2025-09-22

### Features

- Add install and re-check actions to the dependency banner so required tools can be installed or revalidated in place
- Separate tool-use streams in the Progress Board with All / Workflow / Tool Use filters and clearer tab titles
- Show tool-use hints in the agent dropdown to highlight agents that launch tool workflows
- Add a copy button to each model response entry for quickly reusing generated text
- Persist tool-use sessions across restarts, including a resume command and settings to control retention
- Add workspace-aware `glob`, `grep`, and `ls` tools to the default registry and chat agent so every workflow can inspect files safely
- Introduce a `web_fetch` tool that downloads web pages and converts their HTML into Markdown for review inside agent workflows
- Add dedicated `read_file`, `write_file`, and `edit_file` tools and wire them into the default chat agent for clearer, safer workspace editing
- Ship a built-in read-only `ask` agent so you can inspect project files without risking accidental changes
- Show the active instruction at the top of the Progress Board with expandable and copyable text, keeping prompts visible while a run executes
- Allow DeepSeek chat models to call tools via function calling so they can participate fully in tool-use workflows

### Bug Fixes

- Decode HTML entities in follow-up messages so languages like Chinese render correctly in the Progress Board
- Accept legacy tool configuration keys to keep existing tool-use agents working after the prefill cleanup
- Fix LaTeX replacements for beamer column layouts and Schrödinger names to avoid corrupting generated files
- Skip rendering empty model response logs so the Progress Board no longer shows blank entries
- Disable workflow toolbar actions while viewing tool-use streams to prevent unsupported commands from running
- Trim Anthropic requests and block empty user messages to avoid API errors
- Keep tool-use runs visible by automatically updating the Progress Board filter when a workflow starts in another stream
- Log agent errors inside their stream groups so failures surface directly in the Progress Board timeline
- Honor `.gitignore_global` rules in the `ls` tool so global exclusions stay hidden during workspace listings
- Restore missing `output_text` segments in OpenAI Responses so assistants no longer drop parts of their replies

### Improvements

- Summarize tool-use logs with clearer titles, error highlighting, and expandable sections that collapse very long outputs into a scrollable view

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
- Add `texra.includeToolUseAgents` setting to optionally show built-in tool-use agents in the agent dropdown (deprecated in 0.33.8)
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
