// Third-party imports
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import nodePandoc from 'node-pandoc';

// Local imports - common
import { toErrorMessage } from '@common/errors';

// Local imports - utils
import * as logger from '@logger/logUtils';
import { isString, isObject } from '@utils/core';
import { checkToolInstalled } from '@utils/system/toolUtils';

const CHANNEL = 'xmlUtils';
logger.initialize(CHANNEL);

/**
 * CDATA section pattern for removal.
 * Single source of truth for CDATA handling.
 */
const CDATA_PATTERN = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

/**
 * Remove CDATA sections from content.
 * Centralized function to eliminate duplicate CDATA removal patterns.
 *
 * @param content - Content potentially containing CDATA sections
 * @returns Content with CDATA wrappers removed
 */
export function removeCDATA(content: string): string {
  return content.replace(CDATA_PATTERN, '$1');
}

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
  pandocCheckPromise = checkToolInstalled('pandoc', false).then((result) => {
    pandocAvailable = result;
    pandocCheckPromise = null; // Clear the promise after completion
    return result;
  });

  return pandocCheckPromise;
}

enum outputFormat {
  HTML = 'html',
  LaTeX = 'latex',
  MARKDOWN = 'markdown',
}

const LATEX_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\\section\{([^}]+)\}/g, '## $1\n\n'],
  [/\\subsection\{([^}]+)\}/g, '### $1\n\n'],
  [/\\textbf\{([^}]+)\}/g, '**$1**'],
  [/\\textit\{([^}]+)\}/g, '*$1*'],
  [/\\emph\{([^}]+)\}/g, '*$1*'],
  [/\\item\s+/g, '\n- '],
];

const HTML_PATTERN = /<(?:br|p|div|strong|em|code|pre|h[1-6]|ul|ol|li)\b[^>]*>/;

const LATEX_PATTERN = /\\(?:begin|end|section|subsection|textbf|textit|item)\{/;

const LATEX_ENVIRONMENT_MARKERS: RegExp[] = [
  /\\begin\{itemize\}/g,
  /\\end\{itemize\}/g,
  /\\begin\{enumerate\}/g,
  /\\end\{enumerate\}/g,
];

function convertLatexToMarkdown(latex: string): string {
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

function detectInputFormat(text: string): outputFormat {
  if (LATEX_PATTERN.test(text)) {
    return outputFormat.LaTeX;
  } else if (HTML_PATTERN.test(text)) {
    return outputFormat.HTML;
  } else {
    return outputFormat.MARKDOWN;
  }
}

function containsHtml(text: string): boolean {
  return HTML_PATTERN.test(text);
}

function containsLatex(text: string): boolean {
  return LATEX_PATTERN.test(text);
}

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

async function convertWithPandoc(text: string): Promise<string | null> {
  if (!(await isPandocAvailable())) {
    return null;
  }
  const format = detectInputFormat(text);

  // If already markdown, return as-is
  if (format === outputFormat.MARKDOWN) {
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
 * Normalize Pandoc reference syntax to canonical LaTeX format.
 * Pandoc outputs references in formats like:
 * - [label]{reference-type="ref" reference="label"}
 * - [\[label\]](#anchor){reference-type="ref" reference="label"}
 * These are converted to standard \ref{label}, \cref{label}, \eqref{label}
 */
function normalizePandocReferences(text: string): string {
  // Handle markdown-link format: [\[label\]](#anchor){reference-type="ref" reference="label"}
  text = text.replace(
    /\[\\?\[([^\]]+)\\?\]\]\(#[^)]*\)\{reference-type="ref"\s+reference="([^"]+)"\}/g,
    '\\ref{$2}',
  );
  text = text.replace(
    /\[\\?\[([^\]]+)\\?\]\]\(#[^)]*\)\{reference-type="eqref"\s+reference="([^"]+)"\}/g,
    '\\eqref{$2}',
  );
  text = text.replace(
    /\[\\?\[([^\]]+)\\?\]\]\(#[^)]*\)\{reference-type="[Cc]ref"\s+reference="([^"]+)"\}/g,
    '\\cref{$2}',
  );

  // Handle plain markdown-link format: [label](#anchor){reference-type="ref" reference="label"}
  text = text.replace(
    /\[([^\[\]]+)\]\(#[^)]*\)\{reference-type="ref"\s+reference="([^"]+)"\}/g,
    '\\ref{$2}',
  );
  text = text.replace(
    /\[([^\[\]]+)\]\(#[^)]*\)\{reference-type="eqref"\s+reference="([^"]+)"\}/g,
    '\\eqref{$2}',
  );
  text = text.replace(
    /\[([^\[\]]+)\]\(#[^)]*\)\{reference-type="[Cc]ref"\s+reference="([^"]+)"\}/g,
    '\\cref{$2}',
  );

  // Handle simple Pandoc format: [label]{reference-type="ref" reference="label"}
  text = text.replace(
    /\[([^\]]+)\]\{reference-type="ref"\s+reference="([^"]+)"\}/g,
    '\\ref{$2}',
  );
  text = text.replace(
    /\[([^\]]+)\]\{reference-type="eqref"\s+reference="([^"]+)"\}/g,
    '\\eqref{$2}',
  );
  text = text.replace(
    /\[([^\]]+)\]\{reference-type="[Cc]ref"\s+reference="([^"]+)"\}/g,
    '\\cref{$2}',
  );

  return text;
}

/**
 * Get a string representation of an object's structure without its values.
 * Uses centralized type guards for cleaner type checking.
 */
function getObjectStructure(obj: unknown): string {
  if (Array.isArray(obj)) {
    return `Array(${obj.length})`;
  }
  if (isObject(obj)) {
    const keys = Object.keys(obj);
    const structure = keys.map((key) => {
      const value = obj[key];
      return `${key}: ${getObjectStructure(value)}`;
    });
    return `{${structure.join(', ')}}`;
  }
  return typeof obj;
}

/**
 * Wrap content of specified tags with CDATA sections
 */
export function addCdataToTags(xmlData: string, tags: string[]): string {
  try {
    return tags.reduce((result, tag) => {
      const pattern = new RegExp(`(<${tag}>)(.*?)(</${tag}>)`, 'gs');
      return result.replace(pattern, '$1<![CDATA[$2]]>$3');
    }, xmlData);
  } catch (err) {
    logger.error(CHANNEL, `Error adding CDATA to tags: ${toErrorMessage(err)}`);
    throw err;
  }
}

/**
 * Wrap content of specified tags with CDATA sections, handling attributes
 */
export function addCdataToTagsMultiple(
  xmlData: string,
  tags: string[],
): string {
  return tags.reduce((result, tag) => {
    const pattern = new RegExp(
      `(<${tag}(?:\\s+[^>]*)?>)(.*?)(</${tag}>)`,
      'gs',
    );
    return result.replace(pattern, '$1<![CDATA[$2]]>$3');
  }, xmlData);
}

export function extractTextFromTag(
  inputContent: string,
  documentTag: string,
): string {
  // Find all matches and get the last one using matchAll
  const regex = new RegExp(`<${documentTag}>(.*?)<\/${documentTag}>`, 'gs');
  const matches = Array.from(inputContent.matchAll(regex));
  const lastContent = matches.at(-1)?.[1] ?? '';

  // Use centralized CDATA removal
  return removeCDATA(lastContent);
}

/**
 * Extract LaTeX content from a markdown fenced code block
 */
export function extractLatexFromMarkdown(content: string): string | null {
  const match = content.match(/```(?:latex|tex)\n([\s\S]*?)\n```/i);
  return match ? match[1] : null;
}

/**
 * Extract LaTeX document starting at \documentclass and ending at \end{document}
 */
export function extractLatexBetweenDocumentClass(
  content: string,
): string | null {
  const match = content.match(/\\documentclass[\s\S]*?\\end{document}/);
  if (!match) {
    return null;
  }
  // Use centralized CDATA removal
  return removeCDATA(match[0]);
}

/**
 * Regex pattern for matching document opening tags with name attributes.
 * Single source of truth for document name extraction.
 * Group 1: name attribute value
 *
 * Note: Case-sensitive to match XML spec and primary extraction path
 * (addCdataToTagsMultiple + XMLParser). The fallback regex extraction
 * is case-insensitive as a safety net but counter should reflect
 * what primary path can extract.
 */
export const DOCUMENT_NAME_REGEX = /<document[^>]*name="([^"]*)"[^>]*>/;

/**
 * Extract multiple document elements from an XML container tag
 * Used as a fallback for extracting documents when XML parsing fails
 */
export function extractMultipleTextFromTag(
  inputContent: string,
  containerTag?: string,
): Array<{ content: string; name: string }> {
  // Define function to extract documents from any content string
  const extractNamedDocuments = (
    content: string,
  ): Array<{ content: string; name: string }> => {
    const results: Array<{ content: string; name: string }> = [];
    // Full extraction pattern - case-sensitive to match CDATA wrapping behavior
    const documentRegex =
      /<document[^>]*name="([^"]*)"[^>]*>(.*?)<\/document>/gs;

    let documentMatch;
    while ((documentMatch = documentRegex.exec(content)) !== null) {
      const name = documentMatch[1] || 'unnamed';
      // Use centralized CDATA removal
      const docContent = removeCDATA(documentMatch[2] || '');
      results.push({ name, content: docContent });
    }

    return results;
  };

  // If containerTag is provided, try to extract content from within that container
  if (containerTag) {
    const containerRegex = new RegExp(
      `<${containerTag}>(.*?)<\/${containerTag}>`,
      's',
    );
    const containerMatch = inputContent.match(containerRegex);

    if (containerMatch && containerMatch[1]) {
      const documents = extractNamedDocuments(containerMatch[1]);
      if (documents.length > 0) {
        return documents;
      }
      // If no documents found in container, will fall through to the fallback
    }
  }

  // Fallback: extract documents directly from the input content
  return extractNamedDocuments(inputContent);
}

/**
 * Extract content from XML document element for single document case
 * We should have a fall back to regex if this fails
 */
export function extractContentFromXMLbyTag(
  root: Record<string, unknown>,
  documentTag: string,
): string | null {
  if (!isObject(root)) {
    logger.error(
      CHANNEL,
      `Invalid root object. Structure: ${getObjectStructure(root)}`,
    );
    return null;
  }

  if (documentTag in root) {
    const content = root[documentTag];
    if (isString(content)) {
      return content.trim();
    }
    logger.error(
      CHANNEL,
      `Content is not a string in single document case. Structure: ${getObjectStructure(root[documentTag])}`,
    );
  }

  logger.error(
    CHANNEL,
    `No ${documentTag} found in output file. Structure: ${getObjectStructure(root)}`,
  );
  return null;
}

/**
 * Extract content from XML document element for multiple document case
 * we should have a fall back to regex if this fails
 */
export function extractContentFromXMLbyTagMultiple(
  root: Record<string, unknown>,
  documentTag: string,
): Array<{ content: string; name: string }> | null {
  try {
    if (!isObject(root)) {
      logger.error(
        CHANNEL,
        `Invalid root object. Structure: ${getObjectStructure(root)}`,
      );
      return null;
    }

    if (documentTag in root) {
      const container = root[documentTag];
      if (isObject(container) && 'document' in container) {
        const documents = container.document;
        if (Array.isArray(documents)) {
          return documents.map((doc) => ({
            content:
              (doc as Record<string, unknown>).content?.toString().trim() ?? '',
            name: (doc as Record<string, unknown>).name as string,
          }));
        }
        logger.error(
          CHANNEL,
          `Document property is not an array in multiple document case. Structure: ${getObjectStructure(container)}`,
        );
      }
    }

    logger.error(
      CHANNEL,
      `No ${documentTag} or document elements found in output file. Structure: ${getObjectStructure(root)}`,
    );
    return null;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error extracting multiple content from tag: ${toErrorMessage(err)}. Structure: ${getObjectStructure(root)}`,
    );
    throw err;
  }
}

/**
 * Formats special content (scratchpad or thinking) with standardized formatting
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

/**
 * Extract scratchpad content from the given output and format it.
 *
 * @param outputContent The content to extract scratchpad from
 * @param thinkingTag The XML tag name used for the scratchpad content
 */
export async function extractScratchpad(
  outputContent: string,
  thinkingTag: string = 'scratchpad',
): Promise<string | null> {
  const extractedContent = extractTextFromTag(outputContent, thinkingTag);
  return extractedContent ? await formatContent(extractedContent) : null;
}

/**
 * Result of single document extraction with method indicator
 */
export interface ExtractionResult {
  content: string | null;
  method: 'named' | 'simple' | 'markdown' | 'latex' | 'none';
}

/**
 * Result of multiple document extraction with method indicator
 */
export interface MultipleExtractionResult {
  documents: Array<{ content: string; name: string }> | null;
  method: 'simple' | 'none';
}

/**
 * Extract document content using a consolidated cascade of fallback methods.
 * Tries in order: named document -> simple tag -> markdown block -> latex document
 *
 * @param outputContent The raw output content to extract from
 * @param documentTag The XML tag to look for
 * @param preferredName Optional filename to match against named documents. When provided,
 * the extractor prioritizes named document matches before other fallbacks.
 * @returns Extraction result with content and method used
 */
export function extractDocument(
  outputContent: string,
  documentTag: string,
  preferredName?: string,
): ExtractionResult {
  // Try named document extraction first (if preferredName provided)
  if (preferredName) {
    const documents = extractMultipleTextFromTag(outputContent);
    if (documents && documents.length > 0) {
      const match = documents.find((doc) => doc.name === preferredName);
      if (match && match.content) {
        return { content: match.content, method: 'named' };
      }
    }
  }

  // Try simple tag extraction
  const fallbackContent = extractTextFromTag(outputContent, documentTag);
  if (fallbackContent) {
    return { content: fallbackContent, method: 'simple' };
  }

  // Try markdown code block
  const markdownFallback = extractLatexFromMarkdown(outputContent);
  if (markdownFallback) {
    return { content: markdownFallback, method: 'markdown' };
  }

  // Try LaTeX document class extraction
  const latexFallback = extractLatexBetweenDocumentClass(outputContent);
  if (latexFallback) {
    return { content: latexFallback, method: 'latex' };
  }

  return { content: null, method: 'none' };
}

/**
 * Extract multiple documents from XML content with fallback support
 *
 * @param outputContent The raw output content to extract from
 * @param documentTag The container tag to look for documents within
 * @returns Extraction result with documents array and method used
 */
export function extractDocuments(
  outputContent: string,
  documentTag: string,
): MultipleExtractionResult {
  const documents = extractMultipleTextFromTag(outputContent, documentTag);
  if (documents && documents.length > 0) {
    return { documents, method: 'simple' };
  }
  return { documents: null, method: 'none' };
}

export const xmlUtils = {
  removeCDATA,
  addCdataToTags,
  addCdataToTagsMultiple,
  extractTextFromTag,
  extractLatexFromMarkdown,
  extractLatexBetweenDocumentClass,
  extractMultipleTextFromTag,
  extractContentFromXMLbyTag,
  extractContentFromXMLbyTagMultiple,
  formatContent,
  extractScratchpad,
  extractDocument,
  extractDocuments,
};

export default xmlUtils;
