/**
 * Format conversion utilities for LaTeX, HTML, and Markdown.
 * Supports Pandoc (when available) and fallback Turndown conversion.
 */

// Third-party imports
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import nodePandoc from 'node-pandoc';

// Local imports - common
import { toErrorMessage } from '@common/errors';

// Local imports - utils
import * as logger from '@logger/logUtils';
import { checkToolInstalled } from '@utils/system/toolUtils';

// ─────────────────────────────────────────────────────────────────────────────
// Format Detection (inlined from xmlFormatDetection.ts - only used here)
// ─────────────────────────────────────────────────────────────────────────────

export enum OutputFormat {
  HTML = 'html',
  LaTeX = 'latex',
  MARKDOWN = 'markdown',
}

const HTML_PATTERN = /<(?:br|p|div|strong|em|code|pre|h[1-6]|ul|ol|li)\b[^>]*>/;
const LATEX_PATTERN = /\\(?:begin|end|section|subsection|textbf|textit|item)\{/;

function detectInputFormat(text: string): OutputFormat {
  if (LATEX_PATTERN.test(text)) {
    return OutputFormat.LaTeX;
  }
  if (HTML_PATTERN.test(text)) {
    return OutputFormat.HTML;
  }
  return OutputFormat.MARKDOWN;
}

function containsHtml(text: string): boolean {
  return HTML_PATTERN.test(text);
}

function containsLatex(text: string): boolean {
  return LATEX_PATTERN.test(text);
}

const CHANNEL = 'xmlConversion';
logger.initialize(CHANNEL);

/**
 * Cached pandoc availability check.
 * Caches positive results permanently, but clears on failure to allow retry
 * (e.g., if user installs pandoc mid-session).
 */
let pandocCheckPromise: Promise<boolean> | null = null;

async function isPandocAvailable(): Promise<boolean> {
  if (pandocCheckPromise === null) {
    pandocCheckPromise = checkToolInstalled('pandoc', false).then((result) => {
      // Clear cache on negative result to allow retry next time
      if (!result) {
        pandocCheckPromise = null;
      }
      return result;
    });
  }
  return pandocCheckPromise;
}

const LATEX_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\\section\{([^}]+)\}/g, '## $1\n\n'],
  [/\\subsection\{([^}]+)\}/g, '### $1\n\n'],
  [/\\textbf\{([^}]+)\}/g, '**$1**'],
  [/\\textit\{([^}]+)\}/g, '*$1*'],
  [/\\emph\{([^}]+)\}/g, '*$1*'],
  [/\\item\s+/g, '\n- '],
];

const LATEX_ENVIRONMENT_MARKERS: RegExp[] = [
  /\\begin\{itemize\}/g,
  /\\end\{itemize\}/g,
  /\\begin\{enumerate\}/g,
  /\\end\{enumerate\}/g,
];

/**
 * Convert LaTeX content to Markdown (simple regex-based conversion).
 * Internal helper for formatContent fallback.
 */
function convertLatexToMarkdown(latex: string): string {
  const withoutEnvironments = LATEX_ENVIRONMENT_MARKERS.reduce(
    (content, pattern) => content.replace(pattern, ''),
    latex,
  );

  return LATEX_REPLACEMENTS.reduce(
    (content, [pattern, replacement]) => content.replace(pattern, replacement),
    withoutEnvironments,
  );
}

/**
 * Convert HTML content to Markdown using Turndown.
 * Internal helper for formatContent fallback.
 */
function convertHtmlToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    headingStyle: 'atx',
    strongDelimiter: '**',
  });
  turndownService.use(gfm);

  return turndownService.turndown(html);
}

/**
 * Reference type patterns for Pandoc normalization.
 * Each entry maps reference type to the LaTeX command.
 */
const REFERENCE_PATTERNS: Array<{ type: string; command: string }> = [
  { type: 'ref', command: 'ref' },
  { type: 'eqref', command: 'eqref' },
  { type: '[Cc]ref', command: 'cref' },
];

/**
 * Normalize Pandoc reference syntax to canonical LaTeX format.
 * Pandoc outputs references in formats like:
 * - [label]{reference-type="ref" reference="label"}
 * - [\[label\]](#anchor){reference-type="ref" reference="label"}
 * These are converted to standard \ref{label}, \cref{label}, \eqref{label}
 */
function normalizePandocReferences(text: string): string {
  for (const { type, command } of REFERENCE_PATTERNS) {
    // Handle markdown-link format: [\[label\]](#anchor){reference-type="ref" reference="label"}
    text = text.replaceAll(
      new RegExp(
        `\\[\\\\?\\[([^\\]]+)\\\\?\\]\\]\\(#[^)]*\\)\\{reference-type="${type}"\\s+reference="([^"]+)"\\}`,
        'g',
      ),
      `\\${command}{$2}`,
    );

    // Handle plain markdown-link format: [label](#anchor){reference-type="ref" reference="label"}
    text = text.replaceAll(
      new RegExp(
        `\\[([^\\[\\]]+)\\]\\(#[^)]*\\)\\{reference-type="${type}"\\s+reference="([^"]+)"\\}`,
        'g',
      ),
      `\\${command}{$2}`,
    );

    // Handle simple Pandoc format: [label]{reference-type="ref" reference="label"}
    text = text.replaceAll(
      new RegExp(
        `\\[([^\\]]+)\\]\\{reference-type="${type}"\\s+reference="([^"]+)"\\}`,
        'g',
      ),
      `\\${command}{$2}`,
    );
  }

  return text;
}

/**
 * Convert content using Pandoc (if available).
 * Internal helper for formatContent.
 * @returns Converted content, or null if Pandoc is unavailable or conversion fails
 */
async function convertWithPandoc(text: string): Promise<string | null> {
  if (!(await isPandocAvailable())) {
    return null;
  }
  const format = detectInputFormat(text);

  // If already markdown, return as-is
  if (format === OutputFormat.MARKDOWN) {
    return text;
  }

  try {
    const result = await new Promise<string>((resolve, reject) => {
      nodePandoc(
        text,
        ['-f', format, '-t', 'markdown'],
        (err: Error | null, res: string) => {
          if (err) {
            reject(err);
          } else {
            resolve(res);
          }
        },
      );
    });
    // Normalize Pandoc reference syntax to canonical LaTeX format
    return normalizePandocReferences(result);
  } catch (err) {
    logger.error(CHANNEL, `Pandoc conversion failed: ${toErrorMessage(err)}`);
    return null;
  }
}

/**
 * Formats special content (scratchpad or thinking) with standardized formatting.
 * Uses Pandoc if available, otherwise falls back to Turndown/regex conversion.
 *
 * @param content The raw content to format
 */
export async function formatContent(content: string): Promise<string> {
  if (!content) {
    return '';
  }

  // Format the content for improved rendering
  let formattedContent = content.trim();

  const pandocResult = await convertWithPandoc(formattedContent);

  if (pandocResult !== null) {
    formattedContent = pandocResult;
  } else {
    if (containsHtml(formattedContent)) {
      formattedContent = convertHtmlToMarkdown(formattedContent);
    }

    if (containsLatex(formattedContent)) {
      formattedContent = convertLatexToMarkdown(formattedContent);
    }
  }
  return formattedContent;
}
