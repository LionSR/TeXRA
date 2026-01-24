export const CHEVRON_UP_CLASS = 'codicon codicon-chevron-up';
export const CHEVRON_DOWN_CLASS = 'codicon codicon-chevron-down';
export const CHEVRON_RIGHT_CLASS = 'codicon codicon-chevron-right';

export const BULLET_MARKUP =
  '<i class="codicon codicon-circle-small-filled group-bullet"></i>';

export const EMOJI_BY_LEVEL: Record<string, string> = {
  error: '🔴',
  warn: '🟡',
  info: '🟢',
  debug: '🔍',
};

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

export const TOOLS_WITH_DIFF_INPUT = new Set(['edit_file']);
export const TOOLS_WITH_FILE_LINK = new Set(['read_file']);
export const TOOLS_WITH_FILE_CONTENT = new Set(['write_file']);

export const TOOL_OUTPUT_LANGUAGES = new Map([
  ['bash', 'bash'],
  ['execute', 'plaintext'],
  ['run', 'plaintext'],
]);

export const TOOL_CODE_LANGUAGES = new Map([
  ['bash', 'bash'],
  ['wolfram', 'mathematica'],
]);

const EXTENSION_ALIASES = new Map([
  ['tex', 'latex'],
  ['sty', 'latex'],
  ['cls', 'latex'],
  ['dtx', 'latex'],
  ['tikz', 'latex'],
  ['bib', 'bibtex'],
  ['bst', 'latex'],
  ['py', 'python'],
  ['jl', 'julia'],
  ['wl', 'mathematica'],
  ['m', 'mathematica'],
  ['f90', 'fortran'],
  ['f95', 'fortran'],
  ['ipynb', 'json'],
  ['yml', 'yaml'],
  ['md', 'markdown'],
  ['sh', 'bash'],
]);

export const getLanguageFromPath = (filePath: string): string => {
  if (!filePath) {
    return 'plaintext';
  }

  const fileName = filePath.split('/').pop() || filePath;
  const lowerFileName = fileName.toLowerCase();

  if (lowerFileName === 'dockerfile') return 'dockerfile';
  if (lowerFileName === 'makefile') return 'makefile';

  const lastDot = fileName.lastIndexOf('.');
  if (lastDot === -1 || lastDot === fileName.length - 1) {
    return 'plaintext';
  }

  const ext = fileName.slice(lastDot + 1).toLowerCase();
  return EXTENSION_ALIASES.get(ext) || ext;
};

export const DIFF_DETECTION_LINE_LIMIT = 20;
export const DIFF_MARKER_THRESHOLD = 2;

export const TOOL_ICON_MAP: Record<string, string> = {
  read_file: 'codicon-file',
  write_file: 'codicon-new-file',
  edit_file: 'codicon-edit',
  str_replace_editor: 'codicon-edit',
  apply_path: 'codicon-diff',
  glob: 'codicon-search',
  grep: 'codicon-search',
  ls: 'codicon-folder-opened',
  bash: 'codicon-terminal',
  wolfram: 'codicon-symbol-operator',
  web_fetch: 'codicon-globe',
  web_search: 'codicon-globe',
  arxiv_search: 'codicon-book',
  arxiv_metadata: 'codicon-book',
  download_arxiv_source: 'codicon-cloud-download',
  crossref_search: 'codicon-references',
  crossref_doi: 'codicon-references',
  texcount: 'codicon-symbol-numeric',
  extract_figures: 'codicon-file-media',
  extract_tikz_figures: 'codicon-file-media',
  extract_bib_entries: 'codicon-library',
  diagnostics: 'codicon-checklist',
  todo_write: 'codicon-tasklist',
  memory: 'codicon-database',
  zotero_add: 'codicon-library',
  zotero_search: 'codicon-library',
  zotero_export: 'codicon-library',
  lean_diagnostics: 'codicon-warning',
  lean_file: 'codicon-file-code',
  lean_project: 'codicon-folder-library',
  lean_inspect: 'codicon-inspect',
  lean_loogle: 'codicon-search',
  propose_workflow: 'codicon-list-tree',
  propose_agent: 'codicon-account',
};
