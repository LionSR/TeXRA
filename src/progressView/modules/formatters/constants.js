/**
 * Constants and configuration for progress view formatters.
 */

// Re-export icon constants for single import source
export {
  CHEVRON_RIGHT_CLASS,
  CHEVRON_DOWN_CLASS,
} from '@common/iconConstants.js';

// Constants
export const BULLET_MARKUP =
  '<i class="codicon codicon-circle-small-filled group-bullet"></i>';

/** Maximum length for query preview in web search headers */
export const QUERY_PREVIEW_MAX_LENGTH = 40;

export const EMOJI_BY_LEVEL = {
  error: '🔴',
  warn: '🟡',
  info: '🟢',
  debug: '🔍',
};

// DateTimeFormat options for consistent timestamp formatting
export const DATETIME_FORMAT_OPTIONS = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
};

export const TIME_FORMAT_OPTIONS = {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
};

/**
 * Tool-specific icons for better visual distinction.
 * Maps tool names to VS Code codicon classes.
 */
export const TOOL_ICONS = {
  // File operations
  read: 'codicon-file',
  write: 'codicon-new-file',
  edit: 'codicon-edit',
  // Search operations
  grep: 'codicon-search',
  glob: 'codicon-file-directory',
  ls: 'codicon-list-tree',
  // Shell operations
  bash: 'codicon-terminal',
  // Web operations
  web_search: 'codicon-globe',
  web_fetch: 'codicon-cloud-download',
  // LaTeX tools
  extract_bibliography: 'codicon-book',
  extract_figures: 'codicon-file-media',
  extract_tikz_figures: 'codicon-symbol-misc',
  format_latex: 'codicon-symbol-file',
  compile_latex: 'codicon-play',
  // Research tools
  arxiv_search: 'codicon-library',
  arxiv_metadata: 'codicon-info',
  crossref_search: 'codicon-references',
  crossref_doi: 'codicon-link-external',
  // Diagnostics
  diagnostics: 'codicon-debug-console',
  // Default
  default: 'codicon-wrench',
};

/** Maximum output length before truncation (characters) */
export const OUTPUT_TRUNCATE_LENGTH = 1500;

/** Maximum input display length before compacting */
export const INPUT_COMPACT_THRESHOLD = 200;

/** Maximum entries before falling back to YAML for compact input */
export const INPUT_COMPACT_ENTRIES_THRESHOLD = 3;

/** Maximum value length in compact input display */
export const COMPACT_VALUE_MAX_LENGTH = 50;
