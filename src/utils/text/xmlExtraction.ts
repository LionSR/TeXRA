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
import { OUTPUT_DOCUMENT_TAG } from '@shared/schemas/output';
import { isObject } from '@utils/core';

// Local imports
import { removeCDATA } from './xmlCdata';
import { formatContent } from './xmlConversion';

const CHANNEL = 'xmlExtraction';

/**
 * Opening `<document … name="…">` tag fragment; group 1 is the name attribute
 * value. Case-sensitive to match the XML spec and the primary extraction path
 * (addCdataToTagsMultiple + XMLParser), while the fallback regex extraction is
 * case-insensitive as a safety net (the counter should reflect what the
 * primary path can extract). Shared between {@link DOCUMENT_NAME_REGEX} and
 * `extractNamedDocuments` so the name-attribute capture cannot drift apart.
 */
const DOCUMENT_OPEN_TAG_WITH_NAME = `<${OUTPUT_DOCUMENT_TAG}[^>]*name="([^"]*)"[^>]*>`;

/**
 * Regex pattern for matching document opening tags with name attributes.
 * Single source of truth for document name extraction.
 * Group 1: name attribute value
 */
export const DOCUMENT_NAME_REGEX = new RegExp(DOCUMENT_OPEN_TAG_WITH_NAME);

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
 * Extract `<document name="...">` children from any content string.
 * Case-sensitive to match CDATA wrapping behavior.
 */
function extractNamedDocuments(
  content: string,
): Array<{ content: string; name: string }> {
  const documentRegex = new RegExp(
    `${DOCUMENT_OPEN_TAG_WITH_NAME}(.*?)<\/${OUTPUT_DOCUMENT_TAG}>`,
    'gs',
  );

  return [...content.matchAll(documentRegex)].map((match) => ({
    name: match[1] || 'unnamed',
    content: removeCDATA(match[2] ?? ''),
  }));
}

/**
 * Extract multiple document elements from an XML container tag
 * Used as a fallback for extracting documents when XML parsing fails
 */
export function extractMultipleTextFromTag(
  inputContent: string,
  containerTag?: string,
): Array<{ content: string; name: string }> {
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
            // Same missing-name contract as the regex tier (extractNamedDocuments):
            // a document without a usable `name` attribute is named 'unnamed'
            // rather than admitting `undefined` into downstream naming logic.
            name: (entry.name as string | undefined) ?? 'unnamed',
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

export interface MultipleExtractionResult {
  documents: { content: string; name: string }[] | null;
  method: 'simple' | 'latex_document' | 'markdown' | 'latex' | 'none';
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
  if (documents.length > 0) {
    return { documents, method: 'simple' };
  }

  if (preferredName) {
    const tagged = extractTextFromTag(outputContent, 'latex_document');
    if (tagged) {
      return {
        documents: [{ content: tagged, name: preferredName }],
        method: 'latex_document',
      };
    }

    const fenced = outputContent.match(/```(?:latex|tex)\n([\s\S]*?)\n```/i);
    if (fenced?.[1]) {
      return {
        documents: [{ content: fenced[1], name: preferredName }],
        method: 'markdown',
      };
    }

    const bare = outputContent.match(/\\documentclass[\s\S]*?\\end{document}/);
    if (bare) {
      return {
        documents: [{ content: removeCDATA(bare[0]), name: preferredName }],
        method: 'latex',
      };
    }
  }

  return { documents: null, method: 'none' };
}
