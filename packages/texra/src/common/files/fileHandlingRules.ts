/** The folder beside a document that TeXRA compiles it into. */
export const LATEX_BUILD_DIRECTORY = 'build';

/** The suffix a workspace diff carries after the edited file's stem. */
export const WORKSPACE_DIFF_SUFFIX = '_diff';

/**
 * Directories that never hold a source the user works on: build output,
 * package and environment trees. Every listing and every bulk operation
 * skips them, so each list below starts from this one. Lowercase; a
 * directory name is compared case-insensitively.
 */
const MANAGED_DIRECTORIES = Object.freeze([
  LATEX_BUILD_DIRECTORY,
  'node_modules',
  '__pycache__',
  'venv',
  'versions',
]);

/** Built-in file discovery rules. These are product behavior, not settings. */
export const FILE_HANDLING_RULES = Object.freeze({
  /** Extensions listed per document file type (`DocumentFileType`). */
  included: Object.freeze({
    media: Object.freeze([
      '.png',
      '.pdf',
      '.jpeg',
      '.jpg',
      '.gif',
      '.heic',
      '.heif',
      '.webp',
      '.wav',
      '.m4a',
      '.mp3',
      '.aiff',
      '.aac',
      '.opus',
      '.l16',
      '.alaw',
      '.mulaw',
      '.ogg',
      '.flac',
    ]),
    input: Object.freeze(['.txt', '.tex', '.md']),
    context: Object.freeze([
      '.txt',
      '.tex',
      '.md',
      '.bib',
      '.bbl',
      '.cls',
      '.sty',
    ]),
  }),
  ignored: Object.freeze({
    fileExtensions: Object.freeze([
      '.pdf',
      '.bst',
      '.json',
      '.py',
      '.ipynb',
      '.png',
      '.vsix',
      '.ts',
      '.js',
      '.yaml',
    ]),
    inputFiles: Object.freeze([
      'command.tex',
      'commands.tex',
      'preamble.tex',
      'yaml',
    ]),
    /** Skipped when listing the text files a run can take. */
    directories: Object.freeze([
      ...MANAGED_DIRECTORIES,
      'figures',
      'media',
      'figs',
      'stuff',
      'draft',
      'miscellaneous',
    ]),
    /** Skipped by the operations that walk a whole workspace (formatting,
     *  finding `build/` directories to clean): figures and notes are not
     *  LaTeX sources to rewrite. */
    bulkOperationDirectories: Object.freeze([
      ...MANAGED_DIRECTORIES,
      'figs',
      'figures',
      'media',
      'medias',
      'notes',
    ]),
    keywords: Object.freeze([
      'Makefile',
      'template',
      '_thinking',
      // A latexdiff output is never a source to list.
      WORKSPACE_DIFF_SUFFIX,
      'draw',
      'versions',
      'history',
      '.egg-info',
      'venv',
      'yaml',
    ]),
  }),
});
