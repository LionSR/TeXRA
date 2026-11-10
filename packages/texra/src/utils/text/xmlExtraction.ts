/**
 * XML content extraction utilities.
 * Functions for extracting content from XML tags and documents.
 *
 * The extraction result shape (MultipleExtractionResult) is a plain type: it
 * describes an internal return value, not a parsed or validated boundary, so
 * no schema backs it.
 */

// Local imports - utils

// Local imports
import { OUTPUT_DOCUMENT_TAG } from '@texra/shared/plugins/documentOutputs';
import { removeCDATA } from '@texra/utils/text/xmlCdata';

/** A single extracted document: its LaTeX/text content and its `name` attribute. */
export interface NamedDocument {
  content: string;
  name: string;
}

/**
 * Opening `<document … name="…">` tag fragment (either quote style); group 1 is
 * the double-quoted value or group 2 the single-quoted one, so an apostrophe
 * inside a double-quoted name survives. Case-sensitive, like the CDATA wrapping that
 * precedes extraction. Shared between {@link DOCUMENT_NAME_REGEX} and
 * `extractNamedDocuments` so the name-attribute capture cannot drift apart.
 */
const DOCUMENT_OPEN_TAG_WITH_NAME = `<${OUTPUT_DOCUMENT_TAG}[^>]*name\\s*=\\s*(?:"([^"]*)"|'([^']*)')[^>]*>`;

/**
 * Regex pattern for matching document opening tags with name attributes.
 * Single source of truth for document name extraction.
 * Group 1 (double-quoted) or group 2 (single-quoted): name attribute value
 */
export const DOCUMENT_NAME_REGEX = new RegExp(DOCUMENT_OPEN_TAG_WITH_NAME);

/**
 * Extract text content from within a specific XML tag.
 * Returns the content of the last matching tag found.
 */
export function extractTextFromTag(
  inputContent: string,
  tagName: string,
): string {
  // Find all matches and get the last one using matchAll
  const regex = new RegExp(`<${tagName}>(.*?)</${tagName}>`, 'gs');
  const matches = [...inputContent.matchAll(regex)];
  const lastContent = matches.at(-1)?.[1] ?? '';

  // Use centralized CDATA removal
  return removeCDATA(lastContent);
}

/**
 * Extract `<document name="...">` children from any content string.
 * Case-sensitive to match CDATA wrapping behavior.
 */
function extractNamedDocuments(content: string): NamedDocument[] {
  const documentRegex = new RegExp(
    `${DOCUMENT_OPEN_TAG_WITH_NAME}(.*?)</${OUTPUT_DOCUMENT_TAG}>`,
    'gs',
  );

  return [...content.matchAll(documentRegex)].map((match) => ({
    name: (match[1] ?? match[2]) || 'unnamed',
    content: removeCDATA(match[3] ?? ''),
  }));
}

/**
 * The `<document name="...">` children inside the `containerTag` container
 * of a reply, or, when the container is absent or holds none, of the whole
 * reply; `null` when there are none.
 *
 * Fenced ```latex/```tex blocks are deliberately NOT recovered here: this
 * function reads the whole response including the model's thinking tag, so a
 * fence inside the scratchpad would win over the real answer. Fence recovery
 * belongs to `collectLatexFencedBlocks`, which strips the thinking tag first
 * and parses fences per CommonMark. `extractReplyDocuments` runs that tier ahead of
 * this one.
 */
export function extractDocuments(
  outputContent: string,
  containerTag: string,
): NamedDocument[] | null {
  const container = outputContent.match(
    new RegExp(`<${containerTag}>(.*?)</${containerTag}>`, 's'),
  )?.[1];
  const inContainer = container ? extractNamedDocuments(container) : [];
  const documents =
    inContainer.length > 0 ? inContainer : extractNamedDocuments(outputContent);
  return documents.length > 0 ? documents : null;
}

/**
 * A reply that holds its one document bare, as a `\documentclass` block with
 * no document tag, read as that one document named `name`: a synthesized
 * document has no name of its own, so the caller supplies the one
 * destination it can have. `undefined` when the reply holds no such block.
 */
export function bareLatexDocument(
  outputContent: string,
  name: string,
): NamedDocument | undefined {
  const bare = outputContent.match(/\\documentclass[\s\S]*?\\end{document}/);
  return bare ? { content: removeCDATA(bare[0]), name } : undefined;
}
