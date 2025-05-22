export const EXCLUDED_DIRS = new Set([
  'figs',
  'figures',
  'media',
  'medias',
  'build',
  'versions',
  'history',
  'notes',
  'diffs',
]);

export const PACK_EXTENSIONS = ['.pdf', '.tex', '.txt', '.text', '.xml', '.md'];

export const TEMP_EXTENSIONS = [
  '.bak',
  '.bak0',
  '.bak1',
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

// Auto-generated from ModelRegistry
import { MODEL_CONFIGS } from '../model/ModelRegistry';

export const MODELS = Object.keys(MODEL_CONFIGS);

export const HISTORY_DIR = 'History';
