/** Log channel shared by every housekeeping operation. */
export const CHANNEL = 'Housekeeping';

export const PACK_EXTENSIONS = ['.pdf', '.tex', '.txt', '.text', '.xml', '.md'];

export const TEMP_EXTENSIONS = [
  '.bak*',
  '.pdf',
  '.aux',
  '.bbl',
  '.blg',
  '.fdb_latexmk',
  '.fls',
  '.log',
  '.out',
  '.synctex.gz',
  '.bib',
  '.nav',
  '.run.xml',
  '.snm',
  '.toc',
  '-blx.bib',
  'Notes.bib',
];

export const HISTORY_DIR = 'History';

// Default maximum number of reflection rounds for housekeeping operations
export const DEFAULT_MAX_ROUNDS = 5;
