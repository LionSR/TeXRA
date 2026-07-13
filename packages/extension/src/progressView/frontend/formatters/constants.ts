/**
 * Constants and configuration for progress view formatters.
 */

// Local imports - progress view helpers
import {
  languageForPath,
  SPECIAL_BASENAME_LANGUAGES,
} from '@progressView/frontend/languageForPath';

// Local imports - shared schemas
import type { LogLevel } from '@shared/schemas';

// Local imports - shared utilities
import type { TeXRAIconName } from '@shared/wa/webAwesomeIcons';

/**
 * Font Awesome icon name per log level, rendered via `waIcon`. Replaces
 * the former emoji map so log levels use the same icon set as the rest of the
 * UI; per-level color is applied through the `log-level-icon--{level}` classes
 * in logEntryStyles.
 */
export const ICON_BY_LEVEL: Record<LogLevel, TeXRAIconName> = {
  error: 'error',
  warn: 'warning',
  info: 'info',
  debug: 'search',
};

// DateTimeFormat options for consistent timestamp formatting
export const DATETIME_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
};

export const TIME_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
};

// ============================================================================
// Tool Categories for Specialized Formatting
// ============================================================================
//
// The edit/read/write display-kind classification (which tools show an
// old/new diff, a file link, or a file link + content) lives in
// `@shared/tools/toolKind` — the single source of truth shared with the CLI chat
// TUI's `toolRenderers.tsx` (see issue #7120). Use `toolDisplayKind()` from
// that module instead of adding tool-name lists here.

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
  return languageForPath(filePath, {
    basenameLanguages: SPECIAL_BASENAME_LANGUAGES,
    extensionLanguages: EXTENSION_ALIASES,
    fallbackLanguage: 'plaintext',
    unknownExtensionLanguage: (extension) => extension,
  });
}

// Threshold constants for diff detection heuristics
export const DIFF_DETECTION_LINE_LIMIT = 20;
export const DIFF_MARKER_THRESHOLD = 2;

// Tool output patterns for filtering trivial responses
export const TRIVIAL_WRITE_OUTPUT = 'written';

/**
 * Friendly display labels for tool names that shouldn't be shown verbatim.
 */
export const TOOL_LABEL_MAP: Record<string, string> = {
  codex_patch: 'Codex Files',
  codex_thread: 'Codex Thread',
  codex_todo: 'Codex Plan',
  codex_turn: 'Codex Turn',
};

/**
 * Tool icon mapping for different tool types.
 * Maps tool names to wa-icon names (codicon-style aliases supported via the
 * shared TeXRA icon library).
 */
export const TOOL_ICON_MAP: Record<string, string> = {
  // File operations
  read_file: 'file',
  write_file: 'new-file',
  edit_file: 'edit',
  str_replace_editor: 'edit',
  apply_path: 'diff',

  // Search/find
  glob: 'search',
  grep: 'search',
  // `ls` is no longer a registered tool, but persisted progress entries from
  // past runs still reference it — keep the icon so historical runs render
  // with the right glyph instead of the generic fallback.
  ls: 'folder-opened',

  // Shell
  bash: 'terminal',
  wolfram: 'symbol-operator',

  // Web/research
  web_fetch: 'globe',
  web_search: 'globe',
  arxiv_search: 'book',
  arxiv_metadata: 'book',
  download_arxiv_source: 'cloud-download',
  crossref_search: 'references',
  crossref_doi: 'references',

  // LaTeX
  texcount: 'symbol-numeric',
  extract_figures: 'file-media',
  extract_tikz_figures: 'file-media',
  extract_bib_entries: 'library',

  // Diagnostics
  diagnostics: 'checklist',

  // Task management
  todo_write: 'tasklist',

  // Memory
  memory: 'database',

  // Zotero
  zotero_add: 'library',
  zotero_search: 'library',
  zotero_export: 'library',

  // Lean 4
  lean_diagnostics: 'warning',
  lean_file: 'file-code',
  lean_project: 'folder-library',
  lean_inspect: 'inspect',
  lean_loogle: 'search',

  // Workflow/delegation (includes legacy names for historical log entries)
  delegate_workflow: 'list-tree',
  delegate_agent: 'account',
  propose_workflow: 'list-tree',
  propose_agent: 'account',

  // Execution history
  executions: 'history',
  runs: 'history',
  accept_run_files: 'check',

  // External agents
  codex: 'robot',
  codex_patch: 'diff',
  codex_thread: 'comment-discussion',
  codex_todo: 'checklist',
  codex_turn: 'check-all',
};
