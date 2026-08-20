/**
 * Format conversion utilities for LaTeX, HTML, and Markdown.
 * Supports Pandoc (when available) and fallback Turndown conversion.
 */

// Third-party imports
import { execa } from 'execa';

// Local imports - common
import { createLog } from '@logger/logUtils';
import { createHtmlToMarkdown } from '@tools/htmlToMarkdown';
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

const log = createLog('xmlConversion');

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
  return createHtmlToMarkdown().turndown(html);
}

/**
 * Pandoc reference rewrites, compiled once at module load.
 *
 * Pandoc emits references in three shapes, each carrying the same
 * `{reference-type="..." reference="label"}` suffix:
 * - `[\[label\]](#anchor){...}`: markdown link with escaped brackets
 * - `[label](#anchor){...}`: plain markdown link
 * - `[label]{...}`: bare
 * All three become the canonical `\ref{label}` / `\eqref{label}` /
 * `\cref{label}`.
 */
const PANDOC_REFERENCE_REWRITES: ReadonlyArray<readonly [RegExp, string]> = (
  [
    { type: 'ref', command: 'ref' },
    { type: 'eqref', command: 'eqref' },
    { type: '[Cc]ref', command: 'cref' },
  ] as const
).flatMap(({ type, command }) => {
  const suffix = `\\{reference-type="${type}"\\s+reference="([^"]+)"\\}`;
  const replacement = `\\${command}{$2}`;
  return [
    [
      new RegExp(`\\[\\\\?\\[([^\\]]+)\\\\?\\]\\]\\(#[^)]*\\)${suffix}`, 'g'),
      replacement,
    ],
    [new RegExp(`\\[([^\\[\\]]+)\\]\\(#[^)]*\\)${suffix}`, 'g'), replacement],
    [new RegExp(`\\[([^\\]]+)\\]${suffix}`, 'g'), replacement],
  ] as const;
});

/** Normalize Pandoc reference syntax to canonical LaTeX commands. */
function normalizePandocReferences(text: string): string {
  return PANDOC_REFERENCE_REWRITES.reduce(
    (result, [pattern, replacement]) => result.replaceAll(pattern, replacement),
    text,
  );
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
    log.error(`Pandoc conversion failed: ${toErrorMessage(err)}`);
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
