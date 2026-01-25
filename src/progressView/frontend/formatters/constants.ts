/**
 * Constants and configuration for progress view formatters.
 */

// Local imports - shared schemas
import type { LogLevel } from '@shared/schemas';

// Local imports - shared utilities
import { getBasename } from '@shared/utils/path';

// Re-export icon constants for single import source
export { CHEVRON_RIGHT_CLASS, CHEVRON_DOWN_CLASS } from '@shared/utils/icons';

export const EMOJI_BY_LEVEL: Record<LogLevel, string> = {
  error: '🔴',
  warn: '🟡',
  info: '🟢',
  debug: '🔍',
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

/**
 * Tools that show old/new diff display for their input.
 * Output is human-readable status, NOT code (don't syntax highlight output).
 */
export const TOOLS_WITH_DIFF_INPUT = new Set(['edit_file']);

/**
 * Tools that read files and should show file link instead of content.
 */
export const TOOLS_WITH_FILE_LINK = new Set(['read_file']);

/**
 * Tools that write files and should show file link + syntax-highlighted content.
 */
export const TOOLS_WITH_FILE_CONTENT = new Set(['write_file']);

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
  if (!filePath || typeof filePath !== 'string') {
    return 'plaintext';
  }

  const fileName = getBasename(filePath) || filePath;
  const lowerFileName = fileName.toLowerCase();

  // Handle special filenames
  if (lowerFileName === 'dockerfile') return 'dockerfile';
  if (lowerFileName === 'makefile') return 'makefile';

  const lastDot = fileName.lastIndexOf('.');
  if (lastDot === -1 || lastDot === fileName.length - 1) {
    return 'plaintext';
  }

  const ext = fileName.slice(lastDot + 1).toLowerCase();

  // Check alias map first, then use extension directly
  return EXTENSION_ALIASES.get(ext) || ext;
}

// Threshold constants for diff detection heuristics
export const DIFF_DETECTION_LINE_LIMIT = 20;
export const DIFF_MARKER_THRESHOLD = 2;

// Tool output patterns for filtering trivial responses
export const TRIVIAL_WRITE_OUTPUT = 'written';

/**
 * Tool icon mapping for different tool types.
 * Maps tool names to VS Code codicon classes.
 */
export const TOOL_ICON_MAP: Record<string, string> = {
  // File operations
  read_file: 'codicon-file',
  write_file: 'codicon-new-file',
  edit_file: 'codicon-edit',
  str_replace_editor: 'codicon-edit',
  apply_path: 'codicon-diff',

  // Search/find
  glob: 'codicon-search',
  grep: 'codicon-search',
  ls: 'codicon-folder-opened',

  // Shell
  bash: 'codicon-terminal',
  wolfram: 'codicon-symbol-operator',

  // Web/research
  web_fetch: 'codicon-globe',
  web_search: 'codicon-globe',
  arxiv_search: 'codicon-book',
  arxiv_metadata: 'codicon-book',
  download_arxiv_source: 'codicon-cloud-download',
  crossref_search: 'codicon-references',
  crossref_doi: 'codicon-references',

  // LaTeX
  texcount: 'codicon-symbol-numeric',
  extract_figures: 'codicon-file-media',
  extract_tikz_figures: 'codicon-file-media',
  extract_bib_entries: 'codicon-library',

  // Diagnostics
  diagnostics: 'codicon-checklist',

  // Task management
  todo_write: 'codicon-tasklist',

  // Memory
  memory: 'codicon-database',

  // Zotero
  zotero_add: 'codicon-library',
  zotero_search: 'codicon-library',
  zotero_export: 'codicon-library',

  // Lean 4
  lean_diagnostics: 'codicon-warning',
  lean_file: 'codicon-file-code',
  lean_project: 'codicon-folder-library',
  lean_inspect: 'codicon-inspect',
  lean_loogle: 'codicon-search',

  // Workflow/delegation
  propose_workflow: 'codicon-list-tree',
  propose_agent: 'codicon-account',

  // History
  runs: 'codicon-history',
};
