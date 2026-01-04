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

// Local imports
import {
  OutputFormat,
  detectInputFormat,
  containsHtml,
  containsLatex,
} from './xmlFormatDetection';

const CHANNEL = 'xmlConversion';
logger.initialize(CHANNEL);

// Cache pandoc availability check
let pandocAvailable: boolean | null = null;
let pandocCheckPromise: Promise<boolean> | null = null;

async function isPandocAvailable(): Promise<boolean> {
  if (pandocAvailable !== null) {
    return pandocAvailable;
  }

  // If a check is already in progress, wait for it
  if (pandocCheckPromise !== null) {
    return pandocCheckPromise;
  }

  // Start new check and store the promise
  pandocCheckPromise = checkToolInstalled('pandoc', false)
    .then((result) => {
      pandocAvailable = result;
      return result;
    })
    .catch(() => {
      // Cache negative result on error to prevent infinite retries
      pandocAvailable = false;
      return false;
    })
    .finally(() => {
      pandocCheckPromise = null;
    });

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
 */
export function convertLatexToMarkdown(latex: string): string {
  const withoutEnvironments = LATEX_ENVIRONMENT_MARKERS.reduce(
    (content, pattern) => content.replace(pattern, ''),
    latex,
  );

  const converted = LATEX_REPLACEMENTS.reduce(
    (content, [pattern, replacement]) => content.replace(pattern, replacement),
    withoutEnvironments,
  );

  return converted;
}

/**
 * Convert HTML content to Markdown using Turndown.
 */
export function convertHtmlToMarkdown(html: string): string {
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
 * Normalize Pandoc reference syntax to canonical LaTeX format.
 * Pandoc outputs references in formats like:
 * - [label]{reference-type="ref" reference="label"}
 * - [\[label\]](#anchor){reference-type="ref" reference="label"}
 * These are converted to standard \ref{label}, \cref{label}, \eqref{label}
 */
function normalizePandocReferences(text: string): string {
  // Handle markdown-link format: [\[label\]](#anchor){reference-type="ref" reference="label"}
  text = text.replaceAll(
    /\[\\?\[([^\]]+)\\?\]\]\(#[^)]*\)\{reference-type="ref"\s+reference="([^"]+)"\}/g,
    '\\ref{$2}',
  );
  text = text.replaceAll(
    /\[\\?\[([^\]]+)\\?\]\]\(#[^)]*\)\{reference-type="eqref"\s+reference="([^"]+)"\}/g,
    '\\eqref{$2}',
  );
  text = text.replaceAll(
    /\[\\?\[([^\]]+)\\?\]\]\(#[^)]*\)\{reference-type="[Cc]ref"\s+reference="([^"]+)"\}/g,
    '\\cref{$2}',
  );

  // Handle plain markdown-link format: [label](#anchor){reference-type="ref" reference="label"}
  text = text.replaceAll(
    /\[([^\[\]]+)\]\(#[^)]*\)\{reference-type="ref"\s+reference="([^"]+)"\}/g,
    '\\ref{$2}',
  );
  text = text.replaceAll(
    /\[([^\[\]]+)\]\(#[^)]*\)\{reference-type="eqref"\s+reference="([^"]+)"\}/g,
    '\\eqref{$2}',
  );
  text = text.replaceAll(
    /\[([^\[\]]+)\]\(#[^)]*\)\{reference-type="[Cc]ref"\s+reference="([^"]+)"\}/g,
    '\\cref{$2}',
  );

  // Handle simple Pandoc format: [label]{reference-type="ref" reference="label"}
  text = text.replaceAll(
    /\[([^\]]+)\]\{reference-type="ref"\s+reference="([^"]+)"\}/g,
    '\\ref{$2}',
  );
  text = text.replaceAll(
    /\[([^\]]+)\]\{reference-type="eqref"\s+reference="([^"]+)"\}/g,
    '\\eqref{$2}',
  );
  text = text.replaceAll(
    /\[([^\]]+)\]\{reference-type="[Cc]ref"\s+reference="([^"]+)"\}/g,
    '\\cref{$2}',
  );

  return text;
}

/**
 * Convert content using Pandoc (if available).
 * @returns Converted content, or null if Pandoc is unavailable or conversion fails
 */
export async function convertWithPandoc(text: string): Promise<string | null> {
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
