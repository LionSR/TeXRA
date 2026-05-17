# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Features

- **Ink-based CLI TUI is the default** — `texra chat` now mounts the Ink TUI for interactive (TTY) sessions instead of the line-based renderer. The TUI ships a multi-pane layout (conversation, subagent/process list, todos+plan), structured slash forms (`/model` picker), persistent input history with `Ctrl-R` reverse search, `Ctrl-A`/`Ctrl-B` focus traversal, and shared `<KeyHints>` footers across every modal. Deprecated renderer flags (`--tui`, `--no-tui`, `--legacy-renderer`, and `--tool-display`) are accepted for compatibility and ignored with a warning. Non-TTY shells (`texra chat | tee`) now get a usage message pointing to `texra run`, the supported non-interactive path.
- **Non-blocking external inquiries** — the `external_inquiry` tool is renamed to `inquiry` and is now non-blocking and durable. Dispatching a question no longer freezes the agent's cycle waiting for the human round-trip to ChatGPT/Gemini/etc. The cycle continues, and the agent is woken with a continuation message when you submit the answer in the panel — even after closing the tab or reloading the extension. Existing custom agent YAMLs that reference `external_inquiry` continue to work via a compatibility alias.

### Bug Fixes

- **CLI workflow output paths** — `texra run` now prints the final workflow output path from run storage. If `--output` is provided, that file is still copied to the requested destination, but stdout identifies the generated run artifact so multi-round workflow output remains unambiguous.

## [0.37.8] - 2026-05-01

### Breaking Changes

- **Legacy session and config migration shims removed** — TeXRA no longer rewrites legacy fields (`agentType`, `maxRounds`, `xmlStructureMode`, `isMultipleOutput`, `session.agentCategory`, and similar) when loading saved sessions or agent settings. Sessions and configurations created by very old versions of the extension may no longer load and must be recreated.

### Improvements

- **Progress view first-run state** — when there are no runs yet, the progress view now shows direct actions to open the Launcher or Dashboard instead of an empty board.
- **Internal rename pass to remove same-name collisions** — renamed several internal types/constants that previously shared a name with an unrelated concept (OS platform string vs. host platform interface; document file categories vs. the VS Code-style file-type bitmask; the LitElement history-item component vs. the schema-derived history entry; the debug saver's `FileOptions` vs. the agent file-options schema; per-item web-search result vs. the wrapper response), and consolidated duplicate definitions of `AgentCategory`, `Disposable`, `LatexConfigField`, and the API provider list down to single sources of truth. No user-visible behavior change.

### Bug Fixes

- **Current DeepSeek V4 pricing** — DeepSeek V4 Flash and Pro now use DeepSeek's current cache-hit pricing, and V4 Pro reflects the active discounted input and output rates.
- **Codicon font packaging** — installed VSIX builds now include the webview icon font assets, so toolbar and settings icons render as icons instead of fallback squares.

## [0.37.7] - 2026-05-01

### Features

- **GitHub subscription for repos and issues** — ask an agent to watch a repository or issue and it will receive activity (comments, state changes, CI results) as follow-ups while it works. Use `owner/repo` to monitor a whole repo, or `owner/repo/issues/N` for a specific issue — the same way PR subscriptions already work. Open Settings → Git to see what's being watched and stop any subscription.
- **Compile & Diff settings in the UI** — LaTeX compile and diff options (auto-compile after each round, timeouts, latexdiff math-markup mode, formatter choice) can now be configured in Settings → LaTeX under **Compile & Diff** without touching `settings.json`. Settings are per-workspace and take effect immediately.
- **Working directory shown on delegation proposals** — when a delegated agent will run in a specific directory, that path now appears on the proposal and permission cards before you approve, so you can confirm it's correct.
- **Send follow-ups freely during delegation** — you can now queue multiple messages while a delegated agent is working; they are delivered in order once it's ready, instead of later messages being silently dropped.

### Bug Fixes

- **Workflow outputs stay out of your workspace until accepted** — generated files remain in run storage and your source files are not marked as modified until you explicitly accept the output.
- **Disk-full errors show an actionable message** — a full disk now produces a clear "free up disk space" notification instead of a raw error, and no retry is attempted.
- **Various smaller fixes** — stable toggle icons; reliable DeepSeek reasoning output; LaTeX fixer button always enabled when appropriate; AI responses no longer silently drop tool calls; no extra approval prompt between orchestrator and delegated subtask; follow-up input wraps long URLs, paths, and pasted log output instead of overflowing the panel; progress board recovers from corrupted or outdated saved state instead of crashing on startup.

## [0.37.6] - 2026-04-27

### Features

- **GPT-5.5 Pro** — OpenAI's GPT-5.5 Pro (`gpt55pro`) is now available in the model catalog as an opt-in choice for the hardest planning, long-horizon, and large-codebase tasks. It extends GPT-5.5 with a 1.05M-token context window and `xhigh` default reasoning effort. Premium pricing ($30/M input, $180/M output) and Ultra-tier only on the relay — enable it from Settings → Models when GPT-5.5 isn't enough.
- **Computer Scientist (ML) multi-agent preset** — a new built-in team preset tuned for empirical ML and CS work pairs a numerics agent for code-driven experiments with a search agent for literature and a review/criticize agent for methodology and baseline scrutiny.
- **Setup assistant can run terminal commands** — the setup wizard can now hand off sudo prompts and interactive installers to your VS Code terminal instead of stalling on them.

### Improvements

- **Premium-pricing advisory for GPT Pro models** — `gpt5pro`, `gpt52pro`, and `gpt55pro` now show a warning in the model dropdown tooltip and the Settings → Models tab pointing users to the External Inquiry tool, which lets agents ask you to paste an answer from your own ChatGPT subscription instead of paying per-token API rates for these flagship Pro models.
- **Friendlier first-run experience** — the status bar now shows a "Get Started" button that opens the setup assistant for both sign-in and API-key flows; if agents fail to load you get a dismissible notification with Retry and View Logs actions; and the welcome view lists numbered next steps instead of a generic message.
- **Model labels in selection lists** — model labels (e.g. "Fastest", "Balanced") now appear alongside model names in the Settings → Models selection list so you can tell at a glance what each choice is optimised for.
- **Recent runs shown first** — the progress board now lists your most recent runs at the top.
- **Scrollable command output** — long command output in the progress board scrolls independently, and you can copy it in formatted or plain-text form.
- **More reliable follow-ups during delegation** — messages sent while a delegated agent is still working are queued and delivered once it's ready, instead of being dropped.
- **Settings UI polish** — model and agent dropdowns are wider; model labels appear in run tab headers; the GitHub tools section shows prerequisite hints; and the Multi-Agent tab layout is more compact and consistent.
- **API setup guidance in Models tab** — a hint banner appears in Settings → Models when no API key is detected, giving users a direct path to configuration.
- **External Inquiry quick-links** — the External Inquiry panel now includes direct links to documentation so users know when and how to use it.

### Bug Fixes

- **Progress board fails to open after a crash** — TeXRA now recovers cleanly if its saved state was corrupted by an unexpected shutdown, so the progress board always opens on startup.
- **Agent panels stuck open after delegation** — panels from completed delegated work now close properly and can no longer get stuck mid-initialisation.
- **GitHub status stale in Settings** — the GitHub connection status now refreshes each time you open Settings instead of showing outdated information.

## [0.37.5] - 2026-04-24

### Breaking Changes

- **Workflow outputs stay in task storage** — generated workflow files no
  longer appear directly beside your source files. Review them from the
  progress view, open the run's task storage folder, accept selected outputs,
  or pack the run into `History/`.

### Features

- **GPT-5.5** — OpenAI's GPT-5.5 (`gpt55`) is now the flagship OpenAI model in the default lineup. It reaches strong results with fewer reasoning tokens, follows instructions more literally, is more precise on large tool surfaces, and produces more polished and concise answers by default. The default reasoning effort is **medium** — raise to `high`/`xhigh` only when it makes a measurable difference. Image inputs preserve more visual detail by default, improving figure and screenshot understanding. The [Codex CLI](docs/guide/codex-cli.md) integration uses `gpt-5.5` for delegated Codex turns. GPT-5.4 (`gpt54`, `gpt54-`, `gpt54--`) remains available as a lower-cost option.
- **Terminal-quality command output** — command-heavy runs are much easier to read, especially during builds, installs, and diagnostics.
- **Clearer pull-request awareness** — GitHub-related work is easier to monitor and return to from the settings and progress views.
- **DeepSeek V4 models** — DeepSeek V4 Flash and DeepSeek V4 Pro are now available in the model catalog.

### Improvements

- **More guided first run** — the welcome banner now surfaces the setup walkthrough so new users can step through environment, tools, and model access without hunting for it.
- **More dependable long-running work** — extended agent sessions recover more smoothly from interruptions and ambiguous turns.
- **Sharper model defaults** — new and upgrading users get a cleaner default model lineup while advanced options remain available.
- **Sharper literature workflows** — agents are better at turning full-paper context into focused, usable research guidance.
- **More helpful guidance** — setup, orchestration, Git, LaTeX, and Lean workflows now present clearer next steps.
- **More polished progress UI** — streams, controls, and dropdowns are more compact, consistent, and easier to scan, and session hints dismiss with a subtler control.
- **Quieter diagnostics** — routine messages stay out of the way, and user-facing errors focus on recovery.

### Bug Fixes

- **More reliable workflow history** — older workflow tabs recover their context more consistently.
- **Settings refresh fixes** — API key, agent, model, and GitHub changes now update related UI state more reliably.
- **More robust PR workflows** — temporary GitHub failures are handled more gracefully.
- **Restored output and diff displays** — generated outputs and diff views display correctly again.
- **Cleaner command-stream labels** — background command streams no longer show irrelevant labels.
- **More complete chat exports** — exported conversations preserve more of the visible interaction.
- **DeepSeek cache reporting** — DeepSeek V4 Flash and DeepSeek V4 Pro usage now distinguishes prompt-cache hits and misses more clearly.
- **Fuller Anthropic responses** — prefilled content now reaches the final output instead of being dropped.
- **Crisper terminal-style logs** — command output is easier to scan and no longer runs together.
- **Smarter delegation choices** — the orchestrator reaches for a real agent when one fits the task.

## [0.37.4] - 2026-04-21

### Breaking Changes

- **Workflow outputs now live in run history** — workflow results are kept with the run that produced them, giving you a cleaner workspace and a clearer review path through the progress view.

### Features

- **Guided first-run setup** — TeXRA can now walk users through environment checks, missing tools, and model access with a more guided setup experience.
- **Higher-confidence workflow review** — generated LaTeX opens naturally, is easier to inspect, and is checked more consistently before acceptance.
- **A more capable team experience** — multi-agent workflows now feel more like coordinated teams, with clearer proposals and better handoffs.
- **Richer project awareness** — TeXRA surfaces more useful context across the sidebar, Explorer, and progress view while agents work.
- **Pull-request collaboration support** — agents can help keep PR work moving with less manual monitoring.
- **Claude Opus 4.7 support** — the latest Opus 4.7 models are available for demanding research and engineering tasks.
- **Better isolation for advanced delegation** — larger multi-agent runs can keep parallel work better separated when configured.

### Improvements

- **Smoother Codex orchestration** — Codex-backed work fits more naturally into long multi-agent sessions.
- **Safer workspace activation** — TeXRA now waits for trusted workspaces before enabling agent features.
- **Cleaner first-run defaults** — optional integrations that need extra setup are quieter for new users.
- **More durable long workflows** — long-running model work is handled more robustly.
- **More readable progress surfaces** — workflow instructions, selected tabs, history, and webview styling are easier to scan.

### Bug Fixes

- **More reliable workflow builds** — assets and related files are handled better during workflow review.
- **Better compact layouts** — child streams collapse and reopen more predictably.
- **Persistent sidebar placement** — VS Code restores the TeXRA sidebar location more reliably.
- **Cleaner command palette behavior** — TeXRA commands no longer appear before the extension is ready.
- **More reliable GitHub updates** — CI and review activity are tracked more consistently.
- **Clearer cancellation behavior** — cancelled requests no longer become generic provider errors.
- **More reliable relay routing** — provider-prefixed model IDs route correctly through relay.
- **Proposal and toolbar polish** — stream toolbar state and proposal-card layout behave more consistently.
- **More reliable follow-ups** — messages sent during delegated work are handled more gracefully.
- **Thinking-model display fixes** — reasoning summaries are visible again for supported thinking models.
- **More robust Codex effort handling** — higher effort settings no longer break Codex sessions.
- **Helper-agent loading fixes** — built-in helper agents validate and load properly again.

## [0.37.3] - 2026-04-15

### Features

- **Better multi-file paper support** — workflow agents handle papers with shared files and bibliographies more reliably.
- **More flexible arXiv downloads** — downloaded papers can be saved where they fit your project organization.
- **Remote-agent transparency** — Ultra users can inspect the prompt sent to a remote agent.
- **Settings import** — settings can now be loaded from a saved file.

### Improvements

- **Long-paper handling is more reliable** — large documents are processed more smoothly.
- **More careful orchestration** — the orchestrator asks for clarification more often when a request is ambiguous.
- **Dismissed banners stay dismissed** — onboarding and info banners respect your choices across sessions.

### Bug Fixes

- Fixed stale run state sometimes affecting new agent runs.

## [0.37.2] - 2026-04-09

### Features

- **Orchestrator-first onboarding** — new users are guided toward the orchestrator as the default starting point.
- **Codex effort setting** — Codex runs can now use configurable reasoning effort.
- **More responsive follow-ups** — follow-up messages interrupt waiting agents more reliably.
- **New Codex skill presets** — additional ready-made Codex workflows are available for research and Lean work.

### Improvements

- **Clearer labels and terminology** — agent modes, approvals, settings, and warnings are easier to understand.
- **Improved orchestrator UX** — orchestrator guidance and mode-specific instructions are more consistent.
- **Richer Codex display** — Codex activity is easier to inspect in the progress view.
- **Better error messages** — common setup and agent errors now include clearer next steps.
- **Tighter stream tabs** — progress tabs use space more efficiently.

### Bug Fixes

- Fixed an activation issue that could prevent TeXRA from starting correctly.

## [0.37.0] - 2026-04-04

### Features

- **External AI consultations** — agents can help coordinate questions to external AI services from within a TeXRA session.
- **Redesigned Codex experience** — Codex work is easier to follow, continue, and review inside TeXRA.
- **Expanded model routing** — OpenRouter support is now more deeply integrated.

### Improvements

- **Better organization for concurrent work** — related background activity and delegated work are easier to follow in the progress view.
- **More responsive long-running output** — background command output appears more naturally while work is still running.
- **Improved performance with many streams** — the sidebar stays responsive with large active sessions.
- **Tool toggles** — individual tools can now be enabled or disabled from the Tools settings tab.
- **More self-contained document outputs** — generated documents are easier to understand without reading the full conversation.

### Bug Fixes

- Fixed Codex sessions occasionally hanging or duplicating work.
- Stopping background work is more reliable.
- Resolving one external consultation no longer changes the active response unexpectedly.

## [0.36.10] - 2026-03-28

### Features

- **OpenRouter provider** — new toggle in model settings to route all API calls through OpenRouter, letting you use a single API key for any supported model.

### Improvements

- Updated dependencies (KaTeX, Codex SDK, OpenRouter SDK).

## [0.36.9] - 2026-03-26

### Features

- **Context compactization for OpenAI-compatible models** — DeepSeek, Kimi, GLM, and MiniMax models now support automatic context compactization, preventing long tool-use sessions from hitting context window limits. The model summarizes older messages when token usage exceeds 75% of the context window.
- **Wait for specific background executions** — the `executions` tool's wait action now accepts an optional `ids` parameter to monitor specific background tasks instead of waiting for any active execution.
- **MiniMax reasoning split** — MiniMax thinking models now return structured reasoning content instead of embedded `<think>` tags, improving display and downstream processing.

### Bug Fixes

- Fixed Codex CLI not being detected for WSL users.
- Fixed tool-use agent errors ending the conversation instead of allowing follow-up messages to retry.
- Fixed workflow delegation losing extract-figure flags when the LLM omitted them, now inheriting from the parent agent.

### Improvements

- **Extract figure badges in delegation UI** — workflow proposals now show labeled badges for auto-extract figure and TikZ flags in the approval panel and log entries.
- **Better Codex tool display** — Codex processes show a robot icon in the background tasks panel and display structured prompt details in the progress view.
- Updated VS Code engine requirement to 1.105.0.
- Updated dependencies (Supabase, Hono, MCP SDK, fast-xml-parser, KaTeX, OpenAI, Vite, and others).

## [0.36.8] - 2026-03-23

### Features

- **MiniMax and GLM model providers** — added MiniMax and Zhipu AI (GLM) as model providers, with region toggles for China and international endpoints.
- **Zotero collections browser** — agents can now browse your Zotero collection folders to discover and organize references before adding papers.
- **Email file support** — attach or read `.eml` email files directly; TeXRA extracts headers, body text, and image attachments into readable content.
- **Git author attribution** — new option in the Git settings tab to mark commits made by TeXRA with a custom author name and email, so agent-authored changes are easy to identify.
- **LaTeX asset extraction in workflows** — workflow agents can automatically extract referenced figures and TikZ diagrams when delegating tasks, with toggles in the delegation UI.
- **Paginated listings** — history, memory, and tool execution lists now paginate instead of loading everything at once, keeping the interface responsive with large collections.

### Bug Fixes

- Fixed git settings checkbox staying disabled after reopening the settings panel.
- Fixed rare crash during agent conversations.
- Fixed agents occasionally launching in the wrong execution mode.
- Fixed background agents continuing to run after closing their stream tabs.

### Improvements

- **Helper model validation** — TeXRA now checks credentials before starting a task, showing clear messages like "API key missing" instead of failing mid-run.
- **File tracking in multi-agent workflows** — the orchestrator now reports which files each sub-task edited, so you can review changes at a glance.
- **arXiv paper organization** — downloaded arXiv papers are saved into a `References/` subdirectory instead of the workspace root.
- **Cleaner stream switching** — plan and todo sections collapse when switching between stream tabs to reduce clutter.
- **Execution timing** — terminal and sub-task results now show how long they took to run.
- **Better resource cleanup** — closing the extension properly stops background processes to prevent memory leaks.
- Updated dependencies.

## [0.36.7] - 2026-03-17

### Features

- **LaTeX error fixer** — new title bar button for `.tex` files that automatically compiles, diagnoses, and fixes errors, warnings, and overfull boxes.
- **OpenAI Codex tool** — agents can use OpenAI's Codex CLI for sandboxed code execution with streaming output.
- **Pinnable memories** — pin up to 10 memories per workspace so they are always included at session start.
- **Memory attachments for delegated tasks** — attach memory files to sub-tasks so agents inherit project conventions and knowledge.
- **Short model names** — toggle in the Models tab to use unpinned identifiers (e.g., `gpt-5.4` instead of `gpt-5.4-2026-03-05`), useful for proxies that don't accept dated names.
- **DashScope China region (Bailian)** — toggle in DashScope settings to switch between international and China endpoints.
- **Copy user messages** — copy-to-clipboard button on hover for user messages in the Progress Board.
- **Output diffs in multi-agent workflows** — changed files from completed sub-tasks are shown as diffs for quick review.
- **Project context in bash** — `$PROJECT_DIR` and `$PROJECT_NAME` environment variables available in agent bash sessions.
- **Selection descriptions** — agent and model selectors now show a brief description below the dropdowns.

### Bug Fixes

- Fixed latexdiff failing with files in subdirectories.
- Fixed Codex CLI errors on first use and during long sessions.
- Fixed history view showing empty file fields for tool-use sessions.
- Fixed editor tabs stealing focus when agents open files.
- Fixed retry logic misclassifying non-retryable Anthropic errors (e.g., `invalid_request_error`) as retryable.

### Improvements

- **Markdown in history and memories** — instructions and memory previews render as formatted markdown with syntax highlighting.
- **Overleaf Git token setup** — prompts and error messages now link to Overleaf's token documentation.
- **Session descriptions for all agents** — delegated agents now show auto-generated descriptions in their progress tabs.
- **Lower Anthropic costs** — Opus 4.6 and Sonnet 4.6 use native 1M context without a long-context premium. PDF limit raised to 600 pages.
- **Terminal respects your theme** — terminal output uses VS Code theme colors, fixing readability in light themes.
- **Agents stay on track in long sessions** — todo list and plan are preserved when the conversation is compacted.
- **Scrollable panels** — long plans, bash commands, and permission panels scroll instead of pushing buttons off screen. Panels auto-expand when new information arrives.
- Removed Wolfram provider key configuration (the WolframScript tool remains).
- Improved writing quality and consistency across agents.
- Updated dependencies (`@google/genai` 1.46.0, `llm-zoo` 1.1.4, `openai` 6.32.0).

## [0.36.6] - 2026-03-12

### Features

- **Background tasks panel** — a new collapsible panel in the Progress Board shows running background processes and subagents with real-time terminal output streaming, so you can monitor what's happening without switching tabs.
- **Office document attachments** — attach Word, Excel, PowerPoint, and other office documents directly in file attachments alongside images and PDFs.
- **WebSocket mode for OpenAI** — enable persistent WebSocket connections (`texra.model.useWebSocket`) for lower-latency streaming with OpenAI models, especially in multi-turn tool-use workflows.
- **Session descriptions in stream tabs** — each agent session now generates a short description from your instruction, shown in the stream tab for easier identification. Cancelled or errored sessions get descriptions too.
- **Multi-provider chat export** — chat export now works correctly with Google GenAI, OpenAI, and Anthropic conversations.

### Bug Fixes

- Fixed **pending approvals being dropped** when the editor panel closed and fell back to the sidebar.

### Improvements

- **Lower costs with Anthropic models** — prompt caching is now handled more efficiently, reducing token usage in long conversations.
- **Agents stay aware during long conversations** — after context is compacted in long sessions, agents now retain a summary of running subagents and background processes instead of losing track of them.
- Updated dependencies.

## [0.36.5] - 2026-03-08

### Features

- **GPT-5.4** — added OpenAI's GPT-5.4 (`gpt54`) and GPT-5.4 Pro (`gpt54pro`) to the default model list. GPT-5.4 is OpenAI's most capable model, with 1M token context, native computer-use, and improved professional-task performance. GPT-5.4 Pro offers maximum performance for complex workloads.
- GPT-5.2 and GPT-5.2 Pro have been removed from the default list (still usable if manually added). GPT-5.3 Codex remains as the recommended coding model.
- **Chat export** — export agent conversations to Markdown or LaTeX/PDF formats.
- **Approval indicators** — stream tabs now show a pulsing orange border when an approval is pending, and auto-focus to the requesting tab.

### Bug Fixes

- Bug fixes in diff view focus, custom endpoint resolution, approval toggle state, and Anthropic web tool handling.

### Improvements

- Updated dependencies.

## [0.36.4] - 2026-03-02

### Features

- **Reasoning level overrides** — configure the reasoning effort (Low / Medium / High) per model in the Models settings tab, overriding each provider's default.
- **GPT-5.3 Codex** — added OpenAI's GPT-5.3-Codex (`gpt53codex`) to the default model list.

### Bug Fixes

- Fixed **incomplete Anthropic responses** not being detected — truncated streams are now caught and retried automatically.
- Fixed **image uploads rejected** when the configured resize dimension exceeded 8000 px — the limit is now capped to stay within API bounds.
- Fixed **approval and instruction panels** disappearing or not appearing in the progress board — diff previews, subagent launches, and stream switches no longer dismiss pending approvals or drop instruction data.
- Fixed **Google GenAI retry multiplication** — the configured retry count is now respected instead of being silently multiplied.

### Improvements

- **Inline base64 fallback for tool attachments** — images and PDFs from tool results are now embedded inline when routed through providers (e.g., OpenRouter) that lack file-upload support, so the model can see visual content.
- **Clearer delegation feedback** — the orchestrator now receives more accurate status signals, rejection details, and approval metadata when delegating to subagents, improving multi-agent coordination.

## [0.36.3] - 2026-02-23

### Features

- **Resume agent tool** — the orchestrator can now send follow-up instructions to paused subagents, continuing where they left off without starting over.
- **LaTeX settings tab** — new Settings tab showing recommended LaTeX configuration with one-click apply, plus dependency status for LaTeX Workshop and latexdiff.
- **Gemini 3.1 Pro** — added as default Google model, replacing the deprecated Gemini 3 Pro.
- **Parallel tool call limits** — configure how many tools OpenAI models can call at once in Multi-Agent settings.
- **Orchestrator kill toggle** — control whether the orchestrator can terminate subagent runs from Multi-Agent settings.
- **Tool availability checks** — missing dependencies (Wolfram, Lean) are detected automatically with one-click install prompts instead of confusing errors.
- **leanBlueprint agent** — new Lean 4 agent for blueprint-driven formalization, available in the lean-project and mathematician presets.
- **Presenter bash support** — the presenter agent can now run bash commands for building and previewing slides.

### Bug Fixes

- Fixed user messages appearing out of order in tool-use conversations instead of interleaving chronologically with tool outputs.
- Fixed arXiv fetcher not reporting already-downloaded papers and incorrectly rejecting PDF-only papers.

### Improvements

- **Progress Board is noticeably faster** — streaming updates, tab switching, and large conversations all render more smoothly.
- **Keyboard accessibility** — added focus indicators, hover states on interactive elements, and a confirmation dialog before API key removal.
- **Better tool error messages** — clearer installation guides and actionable steps when external tools are missing.
- Updated dependencies.

## [0.36.2] - 2026-02-17

### Features

- **Agent management** — save/load/delete custom agent presets from the Multi-Agent tab, create agents via a guided wizard, and customize or delete them directly in Settings > Agents with per-source bulk toggles.
- **Tool Dashboard** — new settings tab showing which external tools (LaTeX, Git, Lean, Zotero, etc.) are installed and available on your system.
- **Live subagent visibility** — agent sessions are auto-summarized, and the orchestrator sees real-time cost, tool-call, and file-interaction updates from running subagents.
- **Orchestrator memory** — orchestrator agents record experience gathered during sessions, improving results across future runs.
- **New agents** — added leanSearch, leanSimplifier, and presenter for Lean 4 research, proof simplification, and interactive Beamer presentation building.
- **Terminal output rendering** — bash and shell output in the Progress Board now renders with full ANSI color and formatting support.
- **Beamer theme** — paper2slide now uses the modern metropolis theme.
- Added **Claude Sonnet 4.6** (`sonnet46`, `sonnet46T`) with server-side context compaction and 1M context window beta support.

### Bug Fixes

- Fixed **stream tab animations** not playing and **message updates being dropped** for grouped messages in multi-agent scenarios.
- Agents no longer crash when hitting the **PDF page limit** — instead they receive a helpful message suggesting compaction.
- **arXiv sources** are no longer re-downloaded when the files already exist locally.
- Fixed **context window detection** for OpenAI Responses API models.
- Fixed a crash in **environments without a home directory** (e.g., Docker containers).
- Fixed **LaTeX path detection** — auto-detects TeX installation paths across macOS, Linux, and Windows; non-workspace files now resolve project-local `.sty`, `.cls`, and `.bib` files correctly.
- Fixed several **Windows / WSL issues** — line-ending normalization and path handling now work correctly.
- Fixed agents **not stopping properly** — no longer run extra rounds after a failure or ignore the interrupted status.
- **Authentication errors** no longer trigger repeated retries; only transient network failures are retried.
- Fixed **keyboard shortcuts** sometimes being routed to the wrong panel.
- Fixed **model dropdown** not appearing for users with personal API keys but no TeXRA account.
- Fixed interrupted sessions losing their **conversation history** — previous messages are now preserved so you can review what happened.

### Improvements

- **Multi-agent UI is noticeably faster** — switching between agents and receiving updates stays responsive even with many concurrent streams.
- **Pack and Clean discoverability** — renamed commands to be more descriptive, added keyboard shortcuts (Ctrl+Alt+Shift+C/B), and made them accessible from editor title menus, context menus, and the getting-started walkthrough.
- **Memory tool safety** — agents must now view a memory file before deleting or renaming it.
- **Error messages from tools** are now clearer and suggest concrete next steps.
- Updated dependencies.

## [0.36.1] - 2026-02-13

### Bug Fixes

- Fixed model dropdown availability.

## [0.36.0] - 2026-02-12

### Features

- Added **review agent** for manuscript verification — checks mathematical correctness, derivation soundness, notation consistency, and code-manuscript consistency.
- Added **Super YOLO mode** for auto-approving agent proposals without user interaction, with per-stream toggle and settings in the Multi-Agent tab.
- **Subagent model inheritance** — delegated agents now default to the parent agent's model.
- Added **reliability settings** (compaction threshold, retry attempts, retry backoff) to the Multi-Agent tab.
- Added **parent agent breadcrumbs** on subagent stream tabs with clickable navigation back to the parent stream.
- Added **modification timestamps** and column headers to memory tool directory listings.
- Added **execution management** — orchestrator agents can now wait for, inspect, and terminate subagent runs.
- Added **active process badges** in the progress view.

### Bug Fixes

- Fixed **Kimi tool-use** causing API errors on parallel tool calls.
- Fixed **manual compaction** trigger not being honored.
- Fixed **gzip-only arXiv sources** not decompressing correctly for single-file downloads.
- Fixed **Overleaf/ShareLaTeX project URLs** — clone dialog now accepts standard project URLs; auth failures show a "Get Token" button.
- Fixed **Super YOLO toggle** not syncing state on stream switch or webview reload.
- Fixed **parent stream link** persistence across extension restarts.
- Fixed **stream-switch events** from parent breadcrumb links not working in split layout.
- Fixed **stream diagnostics** showing when no events were processed.

### Improvements

- Removed **deprecated models** (sonnet45, opus46, kimi25, qwen3max) from the default model list.
- Suppressed **file lineage** display for non-rewrite agents.
- Updated dependencies.

## [0.35.10] - 2026-02-10

### Features

- Added **agent browser** in settings view with split-panel layout, visibility config, and keyboard navigation.
- Added **context-aware "New Agent" button** matching the current agent category.
- Added **simplifier** and **presenter** tool-use agents for scientific code/LaTeX cleanup and Beamer presentations.
- **Main view agent/model buttons** now open settings view tabs directly.
- Added **model dropdown** and **sync/async mode badges** on agent proposals.
- Added **execution status** badges on orchestrator and runs tool.
- Added **live tool timers** with timeout display and **real-time bash output**.
- Added **reject-with-feedback** for bash command approvals.
- Added **manual conversation compaction** for tool-use agents.
- Added **memory tool display** in progress view.
- Added **subagent output capture** for orchestration.
- Added **remote agent tools** shown in agent proposals.
- Added **batched Lean loogle queries**.
- Added **accept_run_files tool** for orchestrator to accept workflow outputs.
- Added **PDF page limit handling** — agents receive guidance instead of errors.
- Added **structured fields** (title, author, year) to the `zotero_search` tool.
- Added **Terms of Service** and **Providers** pages to the documentation site.

### Bug Fixes

- Fixed **context window overflow** during long sessions.
- Fixed **cache invalidation** causing unnecessary re-sends.
- Fixed **thinking model token limits** being too low in tool-use mode.
- Fixed **compaction size** reporting inaccuracy.
- Fixed **auto-scroll** when switching stream tabs.
- Fixed **stream tab delete button** clipped at narrow widths.
- Fixed **agent proposals** racing with model options loading.
- Fixed **agent visibility** not handling new agents correctly.
- Fixed **bash processes** not cleaning up on timeout (Windows included).
- Fixed **background polling** reliability.
- Fixed **path traversal** and **workspace boundary** validation.
- Fixed **Windows path** normalization throughout.
- Fixed **Lean 4** file lookup and syntax highlighting.
- Fixed **agent status icon** not updating after successful retry.
- Fixed **LaTeX diff dropdowns** opening in the wrong direction.
- Fixed **Zotero search** results not displaying correctly.

### Improvements

- Added **tool timeouts** across all tools.
- Optimized **progress view** performance.
- **Migrated agent settings** to the Settings View.
- Removed **deprecated agents** (tex_linter_fix, xml_validator).
- **Restricted tool-use agents** from out-of-workspace filesystem access.
- Updated dependencies.

## [0.35.9] - 2026-02-06

### Features

- Added **Claude Opus 4.6** (`opus46`, `opus46T`).
- Added **model selection UI** in Models tab with provider grouping, deprecation toggles, and tier indicators.
- Added **polish model dropdown** in the model selection section.
- Added **inline provider API key management** in the Models tab.
- Added **unified Dashboard** consolidating history, memory, and profile views with a searchable, collapsible history list.
- Added **diff display** for edit tool in progress view with inline line numbers and file links.
- Added **live tool commands** in progress view, shown immediately before execution completes.
- Task Progress section now **collapsed by default** for a cleaner UI.
- Increased **default session retention** to 2 weeks.
- Added **server compaction** support with summaries shown in progress view.
- Migrated **streaming & endpoint settings** to the Settings View.
- Enabled **1M context window beta** for Claude Opus 4.6.

### Bug Fixes

- Fixed **sign-in timeout** when auth provider fails, and auth errors no longer block unrelated initialization.
- Fixed **agent output** leaking internal reasoning into files.
- Fixed `$` **in replacement strings** being interpreted during edit operations.
- Fixed **GPT-5 token counting** fallback when counting fails.
- Fixed **Windows compatibility** for paths and line endings in graphicspath parsing.
- Fixed **context overflow** in tool-use agents.
- Fixed **token counting accuracy** and inflated history after compaction.
- Fixed **LaTeX diff UI** regression.
- Fixed error message titles not being selectable/copyable.
- Fixed **duplicate media file listing** in progress view.

### Improvements

- More native VS Code look with codicon toolbar buttons across settings and progress views.
- Updated dependencies.

## [0.35.8] - 2026-02-02

### Features

- Added **Kimi K2.5 models** with thinking and temperature support, and **DeepSeek thinking parameter**.
- Added **accurate token counting** for OpenAI Response API.
- Added **syntax highlighting** in bash command approval prompts.

### Bug Fixes

- Fixed token usage stats not displaying for tool-use agents in progress view.
- Fixed display math `\[...\]` inline rendering rule.

### Improvements

- Internal refactoring for improved maintainability.
- Updated dependencies.

## [0.35.7] - 2026-01-24

### Features

- Added **Zotero integration** tools (`zotero_search`, `zotero_export`, `zotero_add`) for literature management.
- Added **ShareLaTeX git support** in the clone command for self-hosted Overleaf instances.
- Added **bib path setting** (`texra.defaultBibPath`) to configure the default bibliography file location.
- Added **apply agents** for implementing review suggestions, and **attach agent outputs** option in follow-up mode.
- Added **bash command approval system** with per-stream YOLO mode bypass. **YOLO mode** is now per-stream with a distinct visual indicator.
- Added **grep offset parameter** for paginating through large search results.
- Progress view improvements: **syntax highlighting** for tool output and bash commands, and **selectable tool use headers**.
- Agent and model dropdowns now **sync between progress view and main webview**.
- **User messages** can now be sent while tools are executing without ending the turn.
- Added **automatic token refresh** for improved session continuity.

### Bug Fixes

- Fixed tool display issues: edit tool not showing deletions, grep error handling for empty results, and Wolfram error messages missing details.
- Fixed progress view rendering: nested scrollbars in code blocks and math causing duplicate text.
- Fixed retry and auth handling: background response reliability and token refresh loops.
- Fixed session persistence: first user message disappearing and stale content when switching agents.
- Fixed diff naming producing incorrect labels when input file contains round numbers.
- Fixed merge agent not respecting multiple outputs setting.
- Fixed OpenAI Responses API not completing background responses.

### Improvements

- Improved tool error recovery suggestions.
- Optimized progress view performance.
- Updated dependencies.

## [0.35.6] - 2026-01-19

### Features

- Added **Orchestrator** tool-use agent for multi-agent workflow coordination with proposal review system.
- Added **Runs tool** for accessing agent execution history.
- Added **Workflow agent proposal** system with frontend UI for reviewing and approving delegated tasks.
- Added **Lean** agent to default tool-use agents with VS Code integration, real-time diagnostics, and dedicated tools.
- Added **LaTeXdiff changed pages only** option for tool edit proposals.
- Added **pasted arXiv URL support** in download source command.
- Added **New button with mode-specific clearing** for workflow/tool-use views.
- Added **always-visible YOLO mode toggle** button in the header.
- Added **literal matching option** to grep tool for fixed string searches.
- Added **reference-agents** folder with example agent definitions.

### Bug Fixes

- Fixed agent/model dropdowns to open upward for better visibility.
- Fixed extension activation error.
- Fixed progress view theming.
- Fixed LaTeX tool detection reliability.
- Fixed empty chat display and stale log content between tabs.
- Fixed chat resume validation to support flat message format.
- Fixed range parameter handling in read_file tool.
- Fixed context window updates during streaming.
- Fixed diff naming to prevent incorrect labels when comparing same-round files.

## [0.35.5] - 2026-01-15

### Features

- Added **Followup Task** feature for workflow continuation directly in the Progress View, with chat mode and support for multiple file merges.
- Added a **Lean Proof** tool-use agent for informal-to-formal Lean 4 verification workflows.
- Added a **Merge Multiple** agent for batch merge operations.
- Added **LaTeXdiff preview** button in tool edit approval dropdown for comparing proposed changes.
- Added expandable error details to retry dialog UI.
- Relay errors are now retryable with clearer error messaging.
- Added setting to control thinking block clearing (`texra.model.enableThinkingClearing`).
- VS Code GitHub login is now hidden behind a config flag.

### Bug Fixes

- Fixed duplicate workflow launches.
- Fixed agent cancellation responsiveness.
- Fixed multiple output filename handling.
- Fixed temp file cleanup.
- Fixed relay error recovery.
- Fixed tooltip and dropdown clipping issues.
- Fixed bash tool error messages to include stdout.
- Fixed queued follow-up messages not being combined.
- Fixed context state display accuracy.

## [0.35.4] - 2026-01-10

### Features

- Added **Memory View** for browsing and managing agent memory entries with delete controls.
- Added **context utilization display** showing percentage of context window used on each API call.
- Added automatic conversation compaction for long sessions.
- Added button to open progress view in a separate editor tab.
- Chat mode is now the default session type with a simplified UI.
- Memory tool is now enabled by default with a toolbar toggle.
- Added diff syntax highlighting in tool output display.
- Added cache token display (read and creation) in usage statistics.
- Token counts now format as millions (M) when >= 100K for readability.
- Model is now informed when users modify or reject suggested edits.

### Bug Fixes

- Fixed canceling rejection by pressing Escape on feedback input.
- Fixed memory list not refreshing after deletion failure.
- Fixed thinking block clearing not triggering properly.
- Fixed LaTeX math delimiters not rendering correctly in markdown output.
- Fixed conversation messages not syncing after tool-use cycles.
- Fixed log content clearing when falling back to default session kind.
- Fixed chat history clearing on follow-up after extension reload.
- Fixed memory checkbox not being clickable.
- Fixed thinking blocks clearing prematurely.
- Fixed agent dropdown not syncing with session toggle.
- Fixed cached tokens not being included in context measurement.

### Improvements

- Improved tool use display to distinguish user feedback from errors.
- Unified header styles across dashboard views.
- Simplified run selector dropdown to show only timestamp.
- Updated dependencies.

## [0.35.3] - 2026-01-05

### Features

- Added monthly spending limits for relay users.

### Bug Fixes

- Improved progress board layout with better log grouping and reduced whitespace.
- Fixed relay authentication expiring during long-running sessions.

## [0.35.2] - 2025-12-30

### Bug Fixes

- Fixed symlink handling in workspace path resolution and file dialogs.
- Fixed OAuth callback handling for web environments.
- Fixed status tooltip clipping.
- Fixed clean auxiliary files button icon.
- Added resuming status styling and changed stopped status to neutral gray.

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
- Fixed cloud icon sizing in agent dropdown.
- Fixed tool name handling in tool definitions.
- Fixed absolute path handling in file location creation.
- Fixed agent and model selection reverting to defaults.
- Fixed missing usage info in OpenAI Responses API streaming.
- Disabled automatic retries by default to give users explicit control.
- Added tooltips to toolbar buttons across all webviews.
- Clarified reference and auxiliary file selector tooltips.
- API Access toggle now visible for all authenticated users.

### Improvements

- Updated core dependencies.

## [0.35.0] - 2025-12-16

### Bug Fixes

- Fixed OpenAI streaming with web search results.
- Fixed Google model response handling.
- Fixed LaTeX replacement rules causing formatting issues.
- Fixed latexdiff output causing compilation errors.
- Fixed model dropdown resetting media selection when changed.
- Fixed stream list not auto-refreshing when status changes.
- API key banner now hides when the model no longer requires a key.

### Improvements

- Updated core dependencies.

## [0.34.10] - 2025-12-13

### Features

- Added **GPT-5.2** (`gpt52`, `gpt52pro`) to the default model list.
- Introduced **flexible user groups** with permission-based access control
  and tier levels (Max/Ultra) for remote agents.
- Added a **todo list UI** in the progress view for tool-use agents.
- Added **Research agent** for analytical derivations and scientific research.
- Added **Search agent** to the default tool-use agents for web search workflows.
- Profile view now displays a **multi-output support indicator**.

### Bug Fixes

- Resolved duplicate sign-in messages.
- Fixed profile view agent selection reliability when switching between remote agents.
- Fixed OpenAI streaming missing reasoning items with web search.
- Fixed agent selection when switching session types.

## [0.34.9] - 2025-12-10

### Features

- Added **native web search** support for Anthropic and OpenAI models, with
  real-time search results displayed in the progress view.
- Introduced a new **Web Search** tool-use agent optimized for research queries.
- Added **OpenAI deep research models** (`o3-deep-research`, `o4-mini-deep-research`).
- Updated **DeepSeek models to V3.2** with streaming reasoning support.
- Added **getting started guidance** that appears when opening an empty folder.

### Bug Fixes

- Fixed Windows path handling in progress view stream tabs.
- Agent selection now persists correctly when switching between sessions.
- Remote agents with multiple output variants now group correctly.
- Fixed Anthropic streaming with interleaved thinking and text blocks.
- Fixed figure path resolution for input files in subdirectories.
- Fixed `\input` path compatibility by normalizing leading `./` prefixes.
- User-cancelled requests no longer trigger automatic retries.
- Fixed banner display issues when refreshing the webview.

### Improvements

- Updated core dependencies.

## [0.34.8] - 2025-12-04

### Features

- Added **DeepSeek V3.2 Speciale** (`deepseekT+`) with 163k context.
- Enabled tool calling for DeepSeek thinking models.

### Bug Fixes

- Improved tool detection on Unix-like systems for `latexdiff` and related utilities.

### Improvements

- Updated core dependencies.

## [0.34.7] - 2025-11-30

### Bug Fixes

- Fixed packing and cleaning operations not working correctly.

## [0.34.6] - 2025-11-30

### Features

- Introduced **Remote Agents**, letting you browse and run cloud-hosted agents
  directly from the new Profile view.
- Added **manual retry controls** so you can retry failed API requests on demand.
- Display provider icons in the model dropdown.

### Improvements

- Added **Claude Opus 4.5** (`opus45`, `opus45T`) to the default model catalog.
- Widened agent and model dropdowns and added descriptive tooltips.
- Footer dropdowns now open upward to prevent clipping.
- Stream tab close buttons are always visible.
- File selection lists are now sorted alphabetically.
- History view displays the session kind (workflow vs tool use) for each entry.

### Bug Fixes

- Resolved duplicate agent names appearing in the dropdown.
- The API key banner displays reliably on initial webview load.
- arXiv search queries with multiple terms now return more relevant results.

## [0.34.5] - 2025-11-21

### Bug Fixes

- Fixed support for the Kimi 2 Thinking model so it streams reliably again.

## [0.34.4] - 2025-11-14

### Features

- Added a **Collect references** helper that gathers the BibTeX entries your project cites and calls out anything missing.
- Added **GPT-5.1** (`gpt51`) to the model catalog.

### Improvements

- The progress board now loads conversations faster and keeps stream updates responsive.
- Run reviews feel smoother with persistent run context, clearer timestamps, and a ready input box.
- Workspace cleanup is less disruptive: generated artifacts stick around, TeX files are detected more reliably, and `\input{}` paths stay intact.

### Bug Fixes

- Workflow controls once again behave as expected — resume, restart, and stop actions reliably reflect the state of your run.
- Progress board summaries stay in sync with agent defaults and usage totals.
- Tool calls are steadier across providers, avoiding duplicate uploads and missing workflow outputs.
- Bibliography parsing now handles complex citation files without crashing.

## [0.34.3] - 2025-11-07

### Features

- Added **Clone Overleaf Project** command to initialize a local workspace from an Overleaf project.
- Added **tool edit approvals** from the progress board with a pending approvals queue, unified diffs, and rejection-to-follow-up flow.
- Added **workflow output capture** so orchestrated workflows can reuse generated artifacts.
- Added dedicated **arXiv metadata/search** and **Crossref DOI lookup** tools.
- Added **Kimi K2** thinking variants to the model catalog.

### Improvements

- Expanded the progress board empty state with a shortcut to the Overleaf clone flow.
- Improved Overleaf initialization validation and error reporting.
- Updated Kimi K2 naming and pricing.

### Bug Fixes

- Fixed Google Gemini tool call reliability.
- Fixed arXiv metadata tools returning stale results.
- Fixed progress board errors when reviewing runs.
- Fixed duplicated LaTeX environment tags producing malformed output.
- Fixed tool-use cost tracking and edit approval sync.
- Fixed OpenAI file upload fallback on timeout.

## [0.34.2] - 2025-10-31

### Features

- Redesigned the **Progress Board** with a resizable split layout, persistent instruction panel, and inline follow-up controls.
- Streamlined the **main command view** with toolbar-based file pickers and a radio-group session selector.

### Improvements

- Improved `read_file` tool with line numbers and ranged reads up to 2,000 lines.
- Expanded LaTeX cleanup to handle more HTML entities and legacy equation macros.

### Bug Fixes

- PDFs and images from the `read_file` tool are now returned as proper attachments instead of corrupted text.

## [0.34.1] - 2025-10-24

### Bug Fixes

- Fixed toolbar controls and automatic log scrolling in progress view.
- Fixed Claude Haiku 4.5T thinking mode not working correctly.
- Fixed dropdown menus being cut off at container edges.

### Improvements

- Show inline progress display when polishing instructions.
- Cleaner progress board stream tabs.
- More compact model selection dropdown.
- Updated core dependencies.

## [0.34.0] - 2025-10-19

### Features

- Added an interactive VS Code **walkthrough** that guides first-time users through model setup, file selection, and the progress board.
- Added **Claude Haiku 4.5** (`haiku45T`, `haiku45`) to the model catalog.

### Improvements

- Streamlined custom agent prompt handling with automatic migration of older entries.
- Model picker now waits for options to load so newly enabled models appear reliably.
- Added Magic Polish and microphone recording controls to the progress view follow-up input.
- Updated CoT agent icon for clearer visual distinction.

### Bug Fixes

- Fixed scratchpad exports to reopen the named document when agents generate multiple files.
- Fixed tool-use session migration so saved runs load and resume without errors.
- Improved OpenAI thinking summaries with clearer spacing.
- Fixed workflow outputs disappearing from the progress board when no new files were written.
- Progress board timestamps now show in your local timezone instead of UTC.

## [0.33.10] - 2025-10-10

### Features

- Added **GPT-5 Pro** (`gpt5pro`) to the model catalog.
- Prompt for latexdiff math markup before each run.
- Added `extract_figures` and `extract_tikz_figures` tools for returning referenced images and compiled TikZ PDFs.
- Added ranged reads to `read_file` tool.

### Improvements

- Added one-click **Generate diff** controls with auto-selected comparison commit.
- Refreshed the **Progress Board** with copy buttons, native status styling, and a cleaner layout.
- Updated Progress Board empty state with quick links.

### Bug Fixes

- Fixed agent error logs detaching from the latest run in the Progress Board.
- Fixed background responses generating stray streaming updates.
- Fixed agent runs launching when initialization fails.
- Fixed workflow-only responses showing in the Progress Board.
- Improved LaTeX fenced-block parsing for inline math and `aligned` environments.
- Fixed default agent selection in new workspaces.
- Fixed arXiv downloads leaving files outside their staging folder.

## [0.33.9] - 2025-10-03

### Features

- Added `apply_path` and `download_arxiv_source` tools for patches and arXiv source fetching.
- Default workflow and tool-use pickers now use curated presets.
- Added **Open storage** button in the progress view for inspecting run outputs.
- Added between-round `latexdiff` controls and Texcount mode selection.
- Added **Claude Sonnet 4.5** (`sonnet45`, `sonnet45T`) to the model catalog.

### Bug Fixes

- Fixed Anthropic PDF uploads on follow-up requests.
- Fixed PDF filename handling for nested paths.
- Fixed tool-use session resume so follow-ups, execution state, and multi-output agents restore reliably.
- Respect `.gitignore` rules across `glob`, `grep`, and file listings.
- Fixed custom agent directory initialization and default agent visibility.
- Fixed Google model errors not surfacing clearly.

## [0.33.8] - 2025-09-30

### Features

- Split the agent picker into **workflow and tool-use sessions** with a toggle.
- Updated **Gemini 2.5 Flash** to the September 2025 release.
- Updated **Qwen-Max and Qwen Plus** with new pricing and thinking support.

### Bug Fixes

- Improved scratchpad markdown fallbacks when Pandoc is unavailable.
- Fixed prompt exports not resolving paths correctly.
- Fixed progress view state corruption.
- Fixed history entries not restoring correctly.
- Capped `read_file` tool responses at 400 lines to prevent oversized outputs.
- Redesigned agent selector footer with compact session toggle and per-session dropdowns.
- Trimmed default tool-use agent list to conversational presets.
- Fixed history view toggle state not persisting across versions.
- Fixed stale state resurfacing after failed initialization.
- Fixed model options not rendering reliably on successive updates.

## [0.33.7] - 2025-09-22

### Features

- Added install and re-check actions to the dependency banner.
- Separate tool-use streams in the Progress Board with All / Workflow / Tool Use filters.
- Show tool-use hints in the agent dropdown.
- Added a copy button to each model response entry.
- Persist tool-use sessions across restarts with a resume command.
- Added workspace-aware `glob`, `grep`, and `ls` tools to the default registry.
- Added a `web_fetch` tool for downloading and converting web pages to Markdown.
- Added `read_file`, `write_file`, and `edit_file` tools for workspace editing.
- Added a built-in read-only `ask` agent for safe project inspection.
- Show the active instruction at the top of the Progress Board.
- Allow DeepSeek chat models to call tools.

### Bug Fixes

- Fixed HTML entities in follow-up messages so languages like Chinese render correctly.
- Fixed legacy tool configuration keys breaking after cleanup.
- Fixed LaTeX replacements for beamer column layouts and special characters.
- Fixed empty model response logs showing in the Progress Board.
- Fixed workflow toolbar actions running on tool-use streams.
- Fixed empty user messages causing API errors.
- Fixed tool-use runs not visible when a workflow starts in another stream.
- Fixed agent errors not surfacing in the Progress Board timeline.
- Fixed `.gitignore_global` rules not honored in workspace listings.
- Fixed OpenAI Responses dropping parts of assistant replies.

### Improvements

- Summarize tool-use logs with clearer titles and expandable sections for long outputs.

## [0.33.6] - 2025-09-14

### Features

- Show a banner when required dependencies are missing and check tools before running.
- Added `kimi2` to the model list.
- Clarified output file controls in the webview.

### Bug Fixes

- Fixed Ghostscript detection on Windows and ImageMagick false positive.
- Fixed tool-use agents not appearing in the dropdown when enabled.
- Fixed model API key banner behavior and multi-file toggle labels.
- Fixed file selection notification showing for non-input files.
- Fixed empty thinking logs showing in model reasoning display.

### Improvements

- Updated AI SDK packages.
- Improved file dialog helpers for better cross-platform compatibility.

## [0.33.5] - 2025-09-07

### Features

- Replaced Qwen Max with **Qwen3 Max** for improved reasoning and 256k context.
- Updated **Qwen Plus** with hybrid reasoning and 1M context.
- Updated **Moonshot Kimi** models to K2 0905 preview and added turbo variant.
- Added setting to enable/disable GPT-5 reasoning summaries.
- Added configuration banner for missing agent files with quick setup actions.
- Added visual indicator for agents with multiple output support.
- Replaced "(no key)" with a cleaner symbol in model dropdown.

## [0.33.4] - 2025-09-03

### Features

- Support round-specific reflection prompts and iteration across multiple rounds.
- Highlight missing API keys with provider-specific banner and setup links.
- Added model metadata tooltips showing provider, context window, and cost.

### Bug Fixes

- Fixed output handling to work with any round count.
- Consolidated API key setup alerts into a single banner.
- Fixed unnecessary escape characters in LaTeX references.

## [0.33.3] - 2025-08-29

### Features

- Include `.bbl` files when searching for reference files.
- Guide new users through API key setup with links to provider pages.
- Show persistent "Set API Key" banner until a key is configured.

### Bug Fixes

- Restrict GPT OSS models to OpenRouter only.
- Improved API key detection to check environment variables.

## [0.33.2] - 2025-08-25

### Features

- Added sample project command to help new users get started with a complete example.
- Added chat tool-use agent for interactive document-based conversations.
- Stream model responses separately from reasoning for better visibility into agent thinking.
- Show helpful empty-state placeholder in progress view with quick links.
- Added interactive launch page to documentation site.

### Bug Fixes

- Fixed welcome dialog not displaying properly on first launch.
- Fixed pack and clean operations using wrong task output.
- Fixed placeholder visibility when clearing progress view logs.

## [0.33.1] - 2025-08-22

### Features

- Detect arXiv source file type and handle plain `.tex` downloads without extraction.
- Added descriptive tooltips for Input, Reference, Auxiliary and Media file selectors.
- Show onboarding tooltips on first use with a "Never remind again" option.
- Added real-time streaming display for model reasoning/thinking processes.

### Bug Fixes

- Restrict extension to single workspace folder to prevent initialization issues.
- Fixed welcome dialog flag set before dialog displays.

## [0.33.0] - 2025-08-19

### Features

- Show TeXRA task status in the VS Code status bar.
- Automatically resize large images (> 2000px) for better performance.
- Allow disabling LaTeX formatting and silencing missing `latexindent` warnings.
- Added `texra.maxImageDimension` setting to control the maximum image size.
- Added "New" button in main view to reset all fields.
- Prompt users to install LaTeX Workshop extension with "Never remind again" option.

### Bug Fixes

- Fixed status bar command registration and task cancellation handling.
- Fixed `latexdiff` not finding Perl on Windows with MSYS2.
- Fixed first task being marked as error when progress view loads.
- Fixed DeepSeek and Google model streaming issues.
- Fixed LaTeX Workshop configuration being overwritten.

### Improvements

- Improved streaming stability across model providers.
- Improved LaTeX extraction from agent responses.

## [0.32.10] - 2025-08-13

### Bug Fixes

- Prompt users to open a workspace folder when none is active.

## [0.32.9] - 2025-08-09

### Bug Fixes

- Fixed PDF uploads to OpenAI.

## [0.32.8] - 2025-08-09

### Features

- Enabled model streaming & response APIs by default.

## [0.32.7] - 2025-08-08

### Features

- Added **Claude Opus 4.1** (`opus41`, `opus41T`).
- Added **GPT OSS** 120B and 20B reasoning models (`gptoss`, `gptoss-`).
- Added **GPT-5** family models (`gpt5`, `gpt5-`, `gpt5--`).

### Bug Fixes

- Updated OpenAI, Anthropic, and Gemini SDKs.

## [0.32.6] - 2025-08-03

### Features

- **Follow-up Chat** — continue conversations with tool-use agents directly in the progress view with multi-line input support.
- **Code Syntax Highlighting** — code blocks in progress view now adapt to your VS Code theme.

## [0.32.5] - 2025-07-31

### Features

- Added syntax highlighting for code blocks in the progress view.
- Introduced tool-use agents with support for web search and code execution.
- Added stream sorting option in progress view settings.

### Bug Fixes

- Fixed duplicate agents appearing in the dropdown menu.
- Fixed theme switching for code highlighting.
- Fixed various issues with file list button interactions.

## [0.32.4] - 2025-07-25

### Features

- Right-click on YAML agent files in Explorer to quickly add them to your agent list.
- Improved agent configuration with better file type handling.

### Bug Fixes

- Fixed restoration of agent states when reopening sessions.

## [0.32.3] - 2025-07-20

### Features

- Improved statistics view UI with cleaner rendering.

## [0.32.2] - 2025-07-19

### Bug Fixes

- Fixed missing LaTeX diff message rendering in progress view.

## [0.32.1] - 2025-07-10

### Features

- Default model switched to **Gemini 2.5 Pro**.
- Added **Grok 4** model with extended context window support.

## [0.32.0] - 2025-07-07

### Features

- **Claude Sonnet 4T** (Thinking) model set as default.
- Added **Grok 4 Beta** model with 131k context window.

## [0.31.10] - 2025-07-04

### Features

- Progress view templates for consistent UI.
- Markdown rendering restored with KaTeX math support.
- Diff errors now displayed as helpful tooltips.

## [0.31.9] - 2025-07-01

### Features

- Improved file list display in progress view.
- Missing output files now highlighted with direct links.

## [0.31.8] - 2025-06-28

### Features

- Added diagnostics tool and validation agent.
- KaTeX math rendering in progress view.
- Smoother streaming updates in progress view.

## [0.31.7] - 2025-06-25

### Features

- Added bulk latexdiff-vc runner for comparing multiple file versions.
- New tool-use agent capabilities.

## [0.31.6] - 2025-06-25

### Features

- Live reasoning updates displayed in progress view.
- Improved markdown rendering with better styling.

## [0.31.5] - 2025-06-23

### Features

- Redesigned scratchpad and thinking sections.
- Microphone transcription with ElevenLabs support.

## [0.31.4] - 2025-06-17

### Features

- Settings and history buttons moved to editor title bar.
- Optional audio notification when agent rounds complete.
- Enhanced agent creator with better YAML template support.

## [0.31.3] - 2025-06-15

### Features

- Clipboard image pasting in instruction box with automatic cleanup.
- Added arXiv source processor for research papers.
- New deep research model support.

## [0.31.2] - 2025-06-08

### Features

- Collapsible LaTeX diff sections.
- Automatic detection of TeX tools on all platforms.
- Cleaner error messages throughout the extension.

## [0.31.1] - 2025-06-04

### Features

- Added GitHub Copilot model support.
- Smoother streaming output display.
- Diff view auto-refresh and quick access to compiled outputs.

## [0.31.0] - 2025-06-03

### Features

- Google AI thought summaries displayed in progress board.
- Improved diff editor with smart word wrap.
- Dynamic setting updates without restart.

## [0.30.9] - 2025-05-24

### Features

- Automatic cleanup of output files after housekeeping.
- Simplified log navigation with collapsible sections.
- Unified dropdown interface for tools and auto-extract options.

## [0.30.8] - 2025-05-22

### Features

- Clickable output filenames for quick file access.
- Improved history browser with better action buttons.
- Refined UI spacing and visual consistency.

## [0.30.7] - 2025-05-21

### Features

- File progress tracking and diff visualization in progress view.
- Updated API pricing information for all models.
- Round configuration now available in agent settings.

## [0.30.6] - 2025-05-19

### Features

- Updated SDKs for OpenAI, Anthropic, and Google models.
- Improved error messages and user feedback.

## [0.30.5] - 2025-05-13

### Features

- New command to apply LaTeX replacements to current file.
- Added Moonshot Kimi and Alibaba Qwen model support.
- Configurable LaTeX diff markup options.

## [0.30.2] - 2025-05-06

### Improvements

- Updated Gemini model naming for clarity.

## [0.30.1] - 2025-05-06

### Features

- Updated Gemini 2.5 Pro model configuration.
- Enhanced quick-start documentation.

## [0.30.0] - 2025-05-04

### Features

- Explorer now hides build directories by default.
- Enhanced DeepSeek model support.
- Improved PDF viewer with better tab management.

## [0.29.11] - 2025-05-04

### Features

- Added O4 models support.
- Improved DeepSeek integration with official API and OpenRouter.

## [0.29.10] - 2025-05-04

### Improvements

- Code formatting improvements and stability enhancements.

## [0.29.7] - 2025-05-02

### Bug Fixes

- Fixed progress view display issues.

## [0.29.2] - 2025-04-22

### Features

- Added Gemini-2.5-Flash model support.
- Enhanced Unicode character replacements.

## [0.29.0] - 2025-04-17

### Features

- First public release of TeXRA.
