/**
 * Format conversion utilities for LaTeX, HTML, and Markdown.
 * Supports Pandoc (when available) and fallback Turndown conversion.
 */

// Third-party imports
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { execa } from 'execa';

// Local imports - common
import * as logger from '@logger/logUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local imports - utils
import { checkToolInstalled } from '@utils/system/toolUtils';
import { extendEnvPath } from '@utils/system/platformPaths';

// ─────────────────────────────────────────────────────────────────────────────
// Format Detection (inlined from xmlFormatDetection.ts - only used here)
// ─────────────────────────────────────────────────────────────────────────────

enum OutputFormat {
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

const CHANNEL = 'xmlConversion';

/**
 * Cached pandoc availability check.
 * Caches positive results permanently, but clears on failure to allow retry
 * (e.g., if user installs pandoc mid-session).
 */
let pandocCheckPromise: Promise<boolean> | null = null;

async function isPandocAvailable(): Promise<boolean> {
  return (pandocCheckPromise ??= checkToolInstalled('pandoc', false).then(
    (result) => {
      // Clear cache on negative result to allow retry next time
      if (!result) pandocCheckPromise = null;
      return result;
    },
  ));
}

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
 * Internal helper for formatContent fallback.
 */
function convertLatexToMarkdown(latex: string): string {
  return LATEX_REPLACEMENTS.reduce(
    (content, [pattern, replacement]) => content.replace(pattern, replacement),
    latex,
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
    const { stdout } = await execa('pandoc', ['-f', format, '-t', 'markdown'], {
      input: text,
      stripFinalNewline: false,
      env: { ...process.env, PATH: extendEnvPath() },
    });
    return normalizePandocReferences(stdout);
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
  if (!content) return '';

  const trimmed = content.trim();
  const pandocResult = await convertWithPandoc(trimmed);
  if (pandocResult !== null) return pandocResult;

  let result = trimmed;
  if (HTML_PATTERN.test(result)) result = convertHtmlToMarkdown(result);
  if (LATEX_PATTERN.test(result)) result = convertLatexToMarkdown(result);
  return result;
}
