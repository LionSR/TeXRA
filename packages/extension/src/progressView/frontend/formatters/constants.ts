/**
 * Constants and configuration for progress view formatters.
 */

// Local imports
import type { LogLevel } from '@shared/schemas';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { getBasename } from '@utils/core';

/**
 * Font Awesome icon name per log level, rendered via `waIcon`. Replaces
 * the former emoji map so log levels use the same icon set as the rest of the
 * UI; per-level color is applied through the `log-level-icon--{level}` classes
 * in logEntryStyles.
 */
export const ICON_BY_LEVEL: Record<LogLevel, TeXRAIconName> = {
  error: 'circle-exclamation',
  warn: 'triangle-exclamation',
  info: 'circle-info',
  debug: 'magnifying-glass',
};

// ============================================================================
// Tool Categories for Specialized Formatting
// ============================================================================
//
// The edit/read/write display-kind classification (which tools show an
// old/new diff, a file link, or a file link + content) lives in
// `@shared/tools/toolKind` — the single source of truth shared with the CLI chat
// TUI's `toolRenderers.tsx` (see issue #7120). Use `toolDisplayKind()` from
// that module instead of adding tool-name lists here. Friendly header labels
// live next to it in `@shared/tools/toolDisplayName`.

/**
 * Tools whose input AND output are code that benefits from syntax highlighting.
 * Maps tool name to default language hint for output.
 * Use 'bash' for shell commands, 'plaintext' for tools with variable output.
 */
export const TOOL_OUTPUT_LANGUAGES = new Map<string, string>([
  ['bash', 'bash'],
  ['execute', 'plaintext'], // Could be any language - don't guess
  ['run', 'plaintext'], // Could be any language - don't guess
]);

/**
 * Tools whose input contains a code field that should be syntax highlighted.
 * Maps tool name to highlight.js language for the code field.
 * Supports 'code' field (wolfram) and 'command' field (bash).
 */
export const TOOL_CODE_LANGUAGES = new Map<string, string>([
  ['bash', 'bash'],
  ['wolfram', 'mathematica'],
]);

/**
 * Map file extensions that don't match highlight.js language names.
 * Focused on LaTeX research context. Unknown extensions try the extension directly.
 */
const EXTENSION_ALIASES = new Map<string, string>([
  // LaTeX ecosystem
  ['tex', 'latex'],
  ['sty', 'latex'],
  ['cls', 'latex'],
  ['dtx', 'latex'],
  ['tikz', 'latex'],
  ['bib', 'bibtex'],
  ['bst', 'latex'],
  // Scientific computing
  ['py', 'python'],
  ['jl', 'julia'],
  ['wl', 'mathematica'],
  ['m', 'mathematica'],
  ['f90', 'fortran'],
  ['f95', 'fortran'],
  ['ipynb', 'json'],
  // Config/docs
  ['yml', 'yaml'],
  ['md', 'markdown'],
  ['sh', 'bash'],
]);

/** Get highlight.js language from file path based on extension. Uses alias map for non-standard extensions, otherwise tries the extension directly. */
export function getLanguageFromPath(filePath: string): string {
  if (!filePath) return 'plaintext';
  const fileName = getBasename(filePath) || filePath;
  const lowerFileName = fileName.toLowerCase();
  if (lowerFileName === 'dockerfile') return 'dockerfile';
  if (lowerFileName === 'makefile') return 'makefile';
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot === -1 || lastDot === fileName.length - 1) return 'plaintext';
  const extension = fileName.slice(lastDot + 1).toLowerCase();
  return EXTENSION_ALIASES.get(extension) ?? extension;
}

// Threshold constants for diff detection heuristics
export const DIFF_DETECTION_LINE_LIMIT = 20;
export const DIFF_MARKER_THRESHOLD = 2;

/**
 * Upper bound on the inline word diff, which runs synchronously inside Lit's
 * render on the webview's main thread over LLM-authored edit text.
 *
 * Deliberately far below `unifiedDiff`'s 5s Node-side bound rather than shared
 * with it: this budget is the frame the user is waiting on, so the two are
 * different policies for different threads, not one value written twice.
 */
export const INLINE_DIFF_TIMEOUT_MS = 250;

/**
 * Tool icon mapping for different tool types.
 * Maps tool names to wa-icon names (codicon-style aliases supported via the
 * shared TeXRA icon library).
 */
export const TOOL_ICON_MAP: Record<string, TeXRAIconName> = {
  // File operations
  read_file: 'file',
  write_file: 'file-circle-plus',
  edit_file: 'pencil',

  // Search/find
  glob: 'magnifying-glass',
  grep: 'magnifying-glass',
  // These tools are no longer registered, but persisted progress entries from
  // past runs still reference them — keep their icons so historical runs
  // render with the right glyphs instead of the generic fallback.
  // `str_replace_editor` is also Anthropic's native text-editor tool name, so
  // a delegated sub-agent can still report it live.
  str_replace_editor: 'pencil',
  apply_path: 'code-compare',
  crossref_doi: 'link',
  ls: 'folder-open',

  // Shell
  bash: 'terminal',
  wolfram: 'cube',

  // Web/research
  web_fetch: 'globe',
  web_search: 'globe',
  arxiv_search: 'book',
  arxiv_metadata: 'book',
  download_arxiv_source: 'cloud-arrow-down',
  crossref_search: 'link',

  // LaTeX
  texcount: 'hashtag',
  extract_figures: 'image',
  extract_tikz_figures: 'image',
  extract_bib_entries: 'book',

  // Diagnostics
  diagnostics: 'list-check',

  // Task management
  todo_write: 'list-check',

  // Memory
  memory: 'database',

  // Zotero
  zotero_add: 'book',
  zotero_search: 'book',
  zotero_export: 'book',

  // Lean 4
  lean_diagnostics: 'triangle-exclamation',
  lean_file: 'file-code',
  lean_project: 'folder-tree',
  lean_inspect: 'magnifying-glass-chart',
  lean_loogle: 'magnifying-glass',

  // Workflow/delegation
  delegate_workflow: 'list-ul',
  delegate_multi_agents: 'list-ul',
  delegate_agent: 'circle-user',

  // Execution history
  executions: 'clock-rotate-left',
  runs: 'clock-rotate-left',
  accept_run_files: 'check',

  // External agents
  codex: 'robot',
  codex_patch: 'code-compare',
  codex_thread: 'comments',
  codex_todo: 'list-check',
  codex_turn: 'check-double',
};
