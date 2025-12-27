/**
 * Format detection utilities for XML, LaTeX, HTML, and Markdown content.
 */

export enum OutputFormat {
  HTML = 'html',
  LaTeX = 'latex',
  MARKDOWN = 'markdown',
}

const HTML_PATTERN = /<(?:br|p|div|strong|em|code|pre|h[1-6]|ul|ol|li)\b[^>]*>/;

const LATEX_PATTERN = /\\(?:begin|end|section|subsection|textbf|textit|item)\{/;

/**
 * Detect the format of input text (HTML, LaTeX, or Markdown).
 */
export function detectInputFormat(text: string): OutputFormat {
  if (LATEX_PATTERN.test(text)) {
    return OutputFormat.LaTeX;
  } else if (HTML_PATTERN.test(text)) {
    return OutputFormat.HTML;
  } else {
    return OutputFormat.MARKDOWN;
  }
}

/**
 * Check if text contains HTML markup.
 */
export function containsHtml(text: string): boolean {
  return HTML_PATTERN.test(text);
}

/**
 * Check if text contains LaTeX commands.
 */
export function containsLatex(text: string): boolean {
  return LATEX_PATTERN.test(text);
}
