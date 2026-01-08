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
 * Tool icon mapping for different tool types.
 * Maps tool names to VS Code codicon classes.
 */
export const TOOL_ICON_MAP = {
  // File operations
  read_file: 'codicon-file',
  write_file: 'codicon-new-file',
  edit_file: 'codicon-edit',
  file_op: 'codicon-file-code',
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
};
