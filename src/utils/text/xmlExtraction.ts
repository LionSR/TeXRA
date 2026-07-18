/**
 * XML content extraction utilities.
 * Functions for extracting content from XML tags and documents.
 *
 * The extraction result shapes (ExtractionResult / MultipleExtractionResult)
 * are plain types: they describe internal return values, not a parsed or
 * validated boundary, so no Zod schema backs them.
 */

// Local imports - utils
import * as logger from '@logger/logUtils';
import { OUTPUT_DOCUMENT_TAG } from '@shared/constants/outputProtocol';
import { isObject } from '@utils/core';

// Local imports
import { removeCDATA } from './xmlCdata';
import { formatContent } from './xmlConversion';

const CHANNEL = 'xmlExtraction';

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
export const DOCUMENT_NAME_REGEX = new RegExp(
  `<${OUTPUT_DOCUMENT_TAG}[^>]*name="([^"]*)"[^>]*>`,
);

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
  tagName: string,
): string {
  // Find all matches and get the last one using matchAll
  const regex = new RegExp(`<${tagName}>(.*?)<\/${tagName}>`, 'gs');
  const matches = [...inputContent.matchAll(regex)];
  const lastContent = matches.at(-1)?.[1] ?? '';

  // Use centralized CDATA removal
  return removeCDATA(lastContent);
}

/**
 * Extract LaTeX content from a markdown fenced code block.
 * Internal helper for extractDocument cascade.
 */
function extractLatexFromMarkdown(content: string): string | null {
  const match = content.match(/```(?:latex|tex)\n([\s\S]*?)\n```/i);
  return match?.[1] ?? null;
}

/**
 * Extract LaTeX document starting at \documentclass and ending at \end{document}.
 * Internal helper for extractDocument cascade.
 */
function extractLatexBetweenDocumentClass(content: string): string | null {
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
    // Full extraction pattern - case-sensitive to match CDATA wrapping behavior
    const documentRegex = new RegExp(
      `<${OUTPUT_DOCUMENT_TAG}[^>]*name="([^"]*)"[^>]*>(.*?)<\/${OUTPUT_DOCUMENT_TAG}>`,
      'gs',
    );

    return [...content.matchAll(documentRegex)].map((match) => ({
      name: match[1] || 'unnamed',
      content: removeCDATA(match[2] ?? ''),
    }));
  };

  // If containerTag is provided, try to extract content from within that container
  if (containerTag) {
    const containerRegex = new RegExp(
      `<${containerTag}>(.*?)<\/${containerTag}>`,
      's',
    );
    const containerMatch = inputContent.match(containerRegex);

    if (containerMatch?.[1]) {
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
 * Extract content from XML document element for multiple document case
 * we should have a fall back to regex if this fails
 */
export function extractContentFromXMLbyTagMultiple(
  root: Record<string, unknown>,
  containerTag: string,
): Array<{ content: string; name: string }> | null {
  if (!isObject(root)) {
    logger.error(
      CHANNEL,
      `Invalid root object. Structure: ${getObjectStructure(root)}`,
    );
    return null;
  }

  if (containerTag in root) {
    const container = root[containerTag];
    if (isObject(container) && OUTPUT_DOCUMENT_TAG in container) {
      const documents = container[OUTPUT_DOCUMENT_TAG];
      if (Array.isArray(documents)) {
        return documents.map((doc) => {
          const entry = doc as Record<string, unknown>;
          return {
            content: entry.content?.toString().trim() ?? '',
            name: entry.name as string,
          };
        });
      }
      logger.error(
        CHANNEL,
        `Document property is not an array in multiple document case. Structure: ${getObjectStructure(container)}`,
      );
    }
  }

  logger.error(
    CHANNEL,
    `No ${containerTag} or document elements found in output file. Structure: ${getObjectStructure(root)}`,
  );
  return null;
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

// ============================================================================
// Extraction Result Schemas
// ============================================================================

interface ExtractionResult {
  content: string | null;
  method: 'simple' | 'markdown' | 'latex' | 'none';
}

export interface MultipleExtractionResult {
  documents: { content: string; name: string }[] | null;
  method: 'simple' | 'latex_document' | 'markdown' | 'latex' | 'none';
}

/**
 * Extract document content using a consolidated cascade of fallback methods.
 * Tries in order: simple tag -> markdown block -> latex document
 *
 * @param outputContent The raw output content to extract from
 * @param tagName The XML tag to look for
 * @returns Extraction result with content and method used
 */
function extractDocument(
  outputContent: string,
  tagName: string,
): ExtractionResult {
  // Try simple tag extraction
  const fallbackContent = extractTextFromTag(outputContent, tagName);
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
 * Extract multiple documents from XML content with fallback support.
 *
 * Primary path looks for <document name="..."> children inside the unified
 * <documents> container. When that finds nothing and a single-file recovery
 * hint is supplied, the extractor falls back through the legacy single-doc
 * shapes (<latex_document>, fenced ```latex block, bare \documentclass) and
 * synthesizes a one-document result named after the hint. Without a hint,
 * recovery is skipped because a synthesized document with no name has no
 * unambiguous destination.
 *
 * @param outputContent The raw output content to extract from
 * @param containerTag The container tag to look for documents within
 * @param preferredName Recovery hint — when set, treat single-doc legacy
 *   shapes as a one-document result named after the hint
 * @returns Extraction result with documents array and method used
 */
export function extractDocuments(
  outputContent: string,
  containerTag: string,
  preferredName?: string,
): MultipleExtractionResult {
  const documents = extractMultipleTextFromTag(outputContent, containerTag);
  if (documents && documents.length > 0) {
    return { documents, method: 'simple' };
  }

  if (preferredName) {
    const single = extractDocument(outputContent, 'latex_document');
    if (single.content && single.method !== 'none') {
      const method: MultipleExtractionResult['method'] =
        single.method === 'simple' ? 'latex_document' : single.method;
      return {
        documents: [{ content: single.content, name: preferredName }],
        method,
      };
    }
  }

  return { documents: null, method: 'none' };
}
