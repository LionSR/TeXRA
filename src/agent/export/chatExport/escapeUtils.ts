/**
 * LaTeX escaping helpers for chat export.
 *
 * A character-level replacement map (pandoc/pylatex pattern) avoids ordering
 * bugs — every special character is handled exactly once in a single pass.
 */

const LATEX_ESCAPE_MAP: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '#': '\\#',
  $: '\\$',
  '%': '\\%',
  '&': '\\&',
  _: '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
};

const LATEX_ESCAPE_RE = /[\\#$%&_{}~^]/g;

export function escapeLatex(text: string): string {
  return text.replaceAll(LATEX_ESCAPE_RE, (ch) => LATEX_ESCAPE_MAP[ch]);
}

/** Escape special characters in URLs for \\href and \\url commands. */
const LATEX_URL_ESCAPE_RE = /[\\%#{}]/g;
const LATEX_URL_ESCAPE_MAP: Record<string, string> = {
  '\\': '\\%5C',
  '%': '\\%',
  '#': '\\#',
  '{': '\\%7B',
  '}': '\\%7D',
};

export function escapeLatexUrl(url: string): string {
  return url.replaceAll(LATEX_URL_ESCAPE_RE, (ch) => LATEX_URL_ESCAPE_MAP[ch]);
}

/** Wrap text in lstlisting, handling nested end markers. */
export function latexListing(text: string): string {
  const safeText = text.replaceAll('\\end{lstlisting}', '\\end {lstlisting}');
  return `\\begin{lstlisting}\n${safeText}\n\\end{lstlisting}`;
}
