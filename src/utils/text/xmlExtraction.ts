/**
 * XML content extraction utilities.
 * Functions for extracting content from XML tags and documents.
 */

// Local imports - common
import { toErrorMessage } from '@common/errors';

// Local imports - utils
import * as logger from '@logger/logUtils';
import { isString, isObject } from '@utils/core';

// Local imports
import { removeCDATA } from './xmlCdata';
import { formatContent } from './xmlConversion';

const CHANNEL = 'xmlExtraction';
logger.initialize(CHANNEL);

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
 * Extract text content from within a specific XML tag.
 * Returns the content of the last matching tag found.
 */
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
 * Remove specified XML tags and their content from input string
 */
export function filterTagsFromText(
  content: string,
  tags: string | string[],
): string {
  const tagArray = typeof tags === 'string' ? [tags] : tags;
  return tagArray.reduce((result, tag) => {
    const pattern = new RegExp(`<${tag}>.*?</${tag}>\\s*`, 'gs');
    return result.replace(pattern, '');
  }, content);
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
