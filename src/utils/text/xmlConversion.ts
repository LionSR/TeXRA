/**
 * Format conversion utilities for LaTeX, HTML, and Markdown.
 * Supports Pandoc (when available) and fallback Turndown conversion.
 */

// Third-party imports
import { Duration, Effect, Exit } from 'effect';
import { execa } from 'execa';

// Local imports - common
import { createLog } from '@logger/logUtils';
import { createHtmlToMarkdown } from '@utils/text/htmlToMarkdown';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

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
 * Cached pandoc availability.
 *
 * The TTL is read off the probe's own exit: a positive answer is kept
 * indefinitely, a negative one expires at once, so a user who installs pandoc
 * mid-session is picked up on the next conversion. Concurrent conversions
 * racing a cold miss share the one pending `pandoc --version` rather than
 * each spawning their own, which is what a batch of documents converting at
 * once does on a cold start.
 *
 * The cache is built on first use and held, because building it is what
 * allocates the state the sharing lives in — a fresh one per call would
 * share nothing.
 */
let pandocProbe: Effect.Effect<boolean> | undefined;

const isPandocAvailable: Effect.Effect<boolean> = Effect.suspend(
  () =>
    pandocProbe ??
    Effect.flatMap(
      Effect.cachedWithTTL(checkToolInstalled('pandoc', false), (exit) =>
        Exit.isSuccess(exit) && exit.value ? Duration.infinity : 0,
      ),
      (probe) => (pandocProbe = probe),
    ),
);

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
const convertWithPandoc = Effect.fn('xml.convertWithPandoc')(function* (
  text: string,
): Effect.fn.Return<string | null> {
  if (!(yield* isPandocAvailable)) {
    return null;
  }
  const format = detectInputFormat(text);

  // If already markdown, return as-is
  if (format === OutputFormat.MARKDOWN) {
    return text;
  }

  return yield* Effect.tryPromise({
    try: () =>
      execa('pandoc', ['-f', format, '-t', 'markdown'], {
        input: text,
        stripFinalNewline: false,
        env: { ...process.env, PATH: extendEnvPath() },
      }),
    catch: ensureError,
  }).pipe(
    Effect.map(({ stdout }) => normalizePandocReferences(stdout)),
    Effect.catch((err) =>
      Effect.sync(() => {
        log.error(`Pandoc conversion failed: ${toErrorMessage(err)}`);
        return null;
      }),
    ),
  );
});

/**
 * Formats special content (scratchpad or thinking) with standardized formatting.
 * Uses Pandoc if available, otherwise falls back to Turndown/regex conversion.
 *
 * @param content The raw content to format
 */
export const formatContent = Effect.fn('xml.formatContent')(function* (
  content: string,
): Effect.fn.Return<string> {
  if (!content) return '';

  const trimmed = content.trim();
  const pandocResult = yield* convertWithPandoc(trimmed);
  if (pandocResult !== null) return pandocResult;

  let result = trimmed;
  if (HTML_PATTERN.test(result)) {
    result = createHtmlToMarkdown().turndown(result);
  }
  if (LATEX_PATTERN.test(result)) result = convertLatexToMarkdown(result);
  return result;
});
