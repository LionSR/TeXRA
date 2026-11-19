import { WORKSPACE_DIFF_SUFFIX } from '@latex/latexdiff/diffFileNameManager';

/** The folder beside a document that TeXRA compiles it into. */
export const LATEX_BUILD_DIRECTORY = 'build';

/** The folder a packed run's files are copied into. */
export const PACKED_RUNS_DIRECTORY = 'History';

/** The folder beside an input that a latexdiff-vc pack moves its diffs into. */
export const PACKED_DIFFS_DIRECTORY = 'Diffs';

/**
 * Directories that never hold a source the user works on: build output,
 * package and environment trees, and the folders TeXRA writes its own
 * versions, history and diffs into. Every listing and every bulk operation
 * skips them, so each list below starts from this one. Lowercase; a
 * directory name is compared case-insensitively.
 */
const MANAGED_DIRECTORIES = Object.freeze([
  LATEX_BUILD_DIRECTORY,
  'node_modules',
  '__pycache__',
  'venv',
  'versions',
  PACKED_RUNS_DIRECTORY.toLowerCase(),
  PACKED_DIFFS_DIRECTORY.toLowerCase(),
]);

/** Built-in file discovery rules. These are product behavior, not settings. */
export const FILE_HANDLING_RULES = Object.freeze({
  /** Extensions listed per extension category (`ExtensionCategory`). */
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
    edited: Object.freeze(['.txt', '.tex']),
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
    mediaDirectories: MANAGED_DIRECTORIES,
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
