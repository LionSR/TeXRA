/**
 * The one file-extension -> language table, read by both code renderers:
 * Monaco (the desktop editor and diff view) and highlight.js (the progress
 * view's file sections). Each renderer names a few languages its own way; those
 * renames sit beside the table instead of in a second table.
 *
 * Imports nothing from `monaco-editor` or `highlight.js`. Vite emits a worker
 * bundle for every `import('...?worker')` it sees at transform time, before
 * tree-shaking, so a language lookup reached through `@ui/monaco/monacoLoader`
 * once wrote every Monaco worker (~12MB) into the extension build.
 */

// Local imports
import { getBasename } from '@texra-ai/harness/schemas';

const EXTENSION_LANGUAGE: Readonly<Record<string, string>> = {
  // LaTeX ecosystem
  tex: 'latex',
  sty: 'latex',
  cls: 'latex',
  bbl: 'latex',
  dtx: 'latex',
  tikz: 'latex',
  bst: 'latex',
  bib: 'bibtex',
  // Scientific computing
  py: 'python',
  jl: 'julia',
  wl: 'mathematica',
  m: 'mathematica',
  f90: 'fortran',
  f95: 'fortran',
  lean: 'lean',
  ipynb: 'json',
  // Docs and config
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'mdx',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  // Programming languages
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  sql: 'sql',
  rs: 'rust',
  go: 'go',
  java: 'java',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
};

const FILE_NAME_LANGUAGE: Readonly<Record<string, string>> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
};

/** Monaco has no TOML grammar; its `ini` reads the same key = value shape. */
const MONACO_RENAMES: Readonly<Record<string, string>> = { toml: 'ini' };

/** highlight.js registers the shell grammar as `bash`. */
const HIGHLIGHT_RENAMES: Readonly<Record<string, string>> = { shell: 'bash' };

interface PathLanguage {
  /** The table's language, when the name or extension is in it. */
  readonly language: string | undefined;
  /** The lowercased extension, `''` when the name has none. */
  readonly extension: string;
}

function pathLanguage(filePath: string): PathLanguage {
  const name = getBasename(filePath).toLowerCase();
  const byName = FILE_NAME_LANGUAGE[name];
  if (byName) return { language: byName, extension: '' };
  const dotIndex = name.lastIndexOf('.');
  const extension = dotIndex === -1 ? '' : name.slice(dotIndex + 1);
  return {
    language: Object.hasOwn(EXTENSION_LANGUAGE, extension)
      ? EXTENSION_LANGUAGE[extension]
      : undefined,
    extension,
  };
}

/** Monaco language id for a file path; `plaintext` when the table lacks it. */
export function monacoLanguageForPath(filePath: string): string {
  const { language } = pathLanguage(filePath);
  if (!language) return 'plaintext';
  return MONACO_RENAMES[language] ?? language;
}

/**
 * highlight.js language for a file path. An extension the table lacks is
 * passed through, since highlight.js resolves its own aliases (`ps1`, `r`);
 * a name with no extension is `plaintext`.
 */
export function highlightLanguageForPath(filePath: string): string {
  const { language, extension } = pathLanguage(filePath);
  if (!language) return extension || 'plaintext';
  return HIGHLIGHT_RENAMES[language] ?? language;
}
