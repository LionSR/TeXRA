/**
 * Scratchpad formatting: HTML through Turndown, LaTeX through a replacement
 * table, Markdown untouched.
 */

// Local imports - common
import { createHtmlToMarkdown } from '@utils/text/htmlToMarkdown';

const HTML_PATTERN = /<(?:br|p|div|strong|em|code|pre|h[1-6]|ul|ol|li)\b[^>]*>/;
const LATEX_PATTERN = /\\(?:begin|end|section|subsection|textbf|textit|item)\{/;

const LATEX_REPLACEMENTS: Array<[RegExp, string]> = [
  // Drop list-environment markers; the inner \item lines become bullets below.
  [/\\begin\{itemize\}/g, ''],
  [/\\end\{itemize\}/g, ''],
  [/\\begin\{enumerate\}/g, ''],
  [/\\end\{enumerate\}/g, ''],
  [/\\section\{([^}]+)\}/g, '## $1\n\n'],
  [/\\subsection\{([^}]+)\}/g, '### $1\n\n'],
  [/\\textbf\{([^}]+)\}/g, '**$1**'],
  [/\\textit\{([^}]+)\}/g, '*$1*'],
  [/\\emph\{([^}]+)\}/g, '*$1*'],
  [/\\item\s+/g, '\n- '],
];

/**
 * Convert LaTeX content to Markdown (simple regex-based conversion).
 * Internal helper for formatContent.
 */
function convertLatexToMarkdown(latex: string): string {
  return LATEX_REPLACEMENTS.reduce(
    (content, [pattern, replacement]) => content.replace(pattern, replacement),
    latex,
  );
}

/**
 * Format special content (scratchpad or thinking) for display.
 *
 * Deterministic and dependency-free: an HTML scratchpad goes through
 * Turndown, a LaTeX one through {@link LATEX_REPLACEMENTS}, and Markdown —
 * what models write into the scratchpad in practice — is returned trimmed and
 * otherwise unchanged. Every machine renders the same text, with no external
 * converter to install and no `pandoc --version` probe per reflection round.
 *
 * @param content The raw content to format
 */
export function formatContent(content: string): string {
  if (!content) return '';

  let result = content.trim();
  if (HTML_PATTERN.test(result)) {
    result = createHtmlToMarkdown().turndown(result);
  }
  if (LATEX_PATTERN.test(result)) result = convertLatexToMarkdown(result);
  return result;
}
