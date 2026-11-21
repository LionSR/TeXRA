// A file path's language id, for both editors that color code: Monaco (the
// desktop editor and diff panes) and highlight.js (code sections in the
// progress view). It imports neither, so a panel that only labels a file
// pulls in no editor and no language worker.

import { getBasename } from '@texra-ai/harness/schemas';

/** Files whose whole name, not an extension, says what they are. */
const LANGUAGE_BY_NAME = new Map<string, string>([
  ['dockerfile', 'dockerfile'],
  ['makefile', 'makefile'],
]);

/**
 * Extensions whose language id is not the extension itself. The ids are
 * Monaco's; highlight.js registers the same names (or an alias of them,
 * `@ui/highlighting/hljs`) for the languages it bundles.
 */
const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  // LaTeX
  ['tex', 'latex'],
  ['sty', 'latex'],
  ['cls', 'latex'],
  ['dtx', 'latex'],
  ['bbl', 'latex'],
  ['tikz', 'latex'],
  ['bst', 'latex'],
  ['bib', 'bibtex'],
  // Scientific computing
  ['py', 'python'],
  ['jl', 'julia'],
  ['wl', 'mathematica'],
  ['m', 'mathematica'],
  ['f90', 'fortran'],
  ['f95', 'fortran'],
  ['ipynb', 'json'],
  // Documents and configuration
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['jsonc', 'json'],
  ['yml', 'yaml'],
  ['toml', 'ini'],
  ['htm', 'html'],
  // Shells
  ['sh', 'shell'],
  ['bash', 'shell'],
  ['zsh', 'shell'],
  // Programming languages
  ['ts', 'typescript'],
  ['mts', 'typescript'],
  ['cts', 'typescript'],
  ['tsx', 'typescript'],
  ['js', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['jsx', 'javascript'],
  ['rs', 'rust'],
  ['cs', 'csharp'],
  ['rb', 'ruby'],
  ['h', 'c'],
  ['cc', 'cpp'],
  ['cxx', 'cpp'],
  ['hpp', 'cpp'],
]);

/**
 * The language id for a file path: its name's or its extension's entry,
 * else the extension itself (`lean`, `css`, `r`), `plaintext` with none.
 * An id an editor has not registered renders as plain text there.
 */
export function languageForPath(filePath: string): string {
  const name = getBasename(filePath).toLowerCase();
  const byName = LANGUAGE_BY_NAME.get(name);
  if (byName !== undefined) return byName;
  const dot = name.lastIndexOf('.');
  const extension = dot === -1 ? '' : name.slice(dot + 1);
  if (extension === '') return 'plaintext';
  return LANGUAGE_BY_EXTENSION.get(extension) ?? extension;
}
