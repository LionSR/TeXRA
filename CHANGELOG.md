# Changelog

All notable changes to this project will be documented in this file.

## 0.32.1 - 2025-07-10

- Default model switched to **Gemini 2.5 Pro**.
- Added Grok 4 model with token limit adjustments.
- Extended support for Grok via dedicated handler and SDK updates.

## 0.32.2 - 2025-07-12

- Added "Add Agent to Config" context menu option in the TeX Agents view.

## 0.32.0 - 2025-07-07

- Default model fix

## 0.31.10 - 2025-07-04

- Progress view templates for consistent UI.
- Markdown rendering restored using markdown-it with KaTeX.
- Display diff errors as tooltips.
- Consolidated command constants across webviews.

## 0.31.9 - 2025-07-01

- Major progress view refactor with modular architecture.
- Improved file list display and structured logging.
- Missing output files now highlighted with direct links.

## 0.31.8 - 2025-06-28

- Added diagnostics tool and validation agent.
- KaTeX math rendering in progress view.
- Introduced progress event bus for smoother streaming.

## 0.31.7 - 2025-06-25

- Added bulk latexdiff-vc runner.
- Introduced base tool‑use agent framework.
- Automated version bump workflow improvements.

## 0.31.6 - 2025-06-25

- Stream reasoning updates live in progress view.
- Markdown rendering switched to marked with improved styles.
- New state management for progress logs.

## 0.31.5 - 2025-06-23

- Scratchpad and thinking sections redesigned.
- Microphone transcription with ElevenLabs support.
- Centralized file system operations via managers.

## 0.31.4 - 2025-06-17

- Settings and history buttons moved to editor title bar.
- Optional beep when a round finishes.
- Agent creator templates enhanced with YAML parsing.

## 0.31.3 - 2025-06-15

- Clipboard image pasting in instruction box with cleanup.
- New root path aliases and improved utils organization.
- Added arXiv source processor and deep research models.

## 0.31.2 - 2025-06-08

- Collapsible LaTeXdiff sections and improved log hierarchy.
- Automatic search for TeX tools on all platforms.
- Cleaner error messages and tool configuration.

## 0.31.1 - 2025-06-04

- Added GitHub Copilot model support.
- Streaming chunks accumulated for smoother output.
- Diff view auto-refresh and open compiled outputs.

## 0.31.0 - 2025-06-03

- Google thought summaries displayed in progress board.
- Diff editor improvements with smart word wrap.
- Watch configuration helper for dynamic setting reloads.

## 0.30.9 - 2025-05-24

- Output files cleared after housekeeping to reduce clutter.
- Simplified log toggles using `<details>` elements.
- Auto-extract and tool dropdowns unified.

## 0.30.8 - 2025-05-22

- Clickable output filenames and improved history actions.
- Unified CSS variables and refined UI spacing.
- Webview state handling centralized for consistency.

## 0.30.7 - 2025-05-21

- File progress and diff features added to progress view.
- API pricing info updated for Anthropic and Google models.
- Round configuration moved to agent settings.

## 0.30.6 - 2025-05-19

- Model registry split by provider for easier updates.
- New SDK versions for OpenAI, Anthropic, and Google.
- Various UI refactors and error feedback improvements.

## 0.30.5 - 2025-05-13

- Command to apply LaTeX replacements to the current file.
- Added Moonshot Kimi and Alibaba Qwen model support.
- Configurable latexdiff markup and improved formatting rules.

## 0.30.0 - 2025-05-04

- Explorer configured to hide build directory and disable auto reveal.
- DeepSeek model handler enhanced with message preprocessing.
- Improved PDF viewer tabs and reflection UI.
