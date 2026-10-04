/**
 * XML content extraction utilities.
 * Functions for extracting content from XML tags and documents.
 *
 * The extraction result shape (MultipleExtractionResult) is a plain type: it
 * describes an internal return value, not a parsed or validated boundary, so
 * no Zod schema backs it.
 */

// Local imports - utils
import { OUTPUT_DOCUMENT_TAG } from '@shared/schemas';

// Local imports
import { createHtmlToMarkdown } from './htmlToMarkdown';
import { removeCDATA } from './xmlCdata';

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
function extractNamedDocuments(content: string): NamedDocument[] {
  const documentRegex = new RegExp(
    `${DOCUMENT_OPEN_TAG_WITH_NAME}(.*?)<\/${OUTPUT_DOCUMENT_TAG}>`,
    'gs',
  );

  return [...content.matchAll(documentRegex)].map((match) => ({
    name: (match[1] ?? match[2]) || 'unnamed',
    content: removeCDATA(match[3] ?? ''),
  }));
}

const HTML_PATTERN = /<(?:br|p|div|strong|em|code|pre|h[1-6]|ul|ol|li)\b[^>]*>/;
const LATEX_PATTERN = /\\(?:begin|end|section|subsection|textbf|textit|item)\{/;

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
 * Extract scratchpad content from the given output and format it for
 * display.
 *
 * Deterministic and dependency-free: an HTML scratchpad goes through
 * Turndown, a LaTeX one through {@link LATEX_REPLACEMENTS}, and Markdown —
 * what models write into the scratchpad in practice — is returned trimmed and
 * otherwise unchanged. Every machine renders the same text, with no external
 * converter to install and no `pandoc --version` probe per workflow round.
 *
 * @param outputContent The content to extract scratchpad from
 * @param thinkingTag The XML tag name used for the scratchpad content
 */
export function extractScratchpad(
  outputContent: string,
  thinkingTag: string,
): string | null {
  const extractedContent = extractTextFromTag(outputContent, thinkingTag);
  if (!extractedContent) return null;
  let result = extractedContent.trim();
  if (HTML_PATTERN.test(result)) {
    result = createHtmlToMarkdown().turndown(result);
  }
  if (LATEX_PATTERN.test(result)) {
    result = LATEX_REPLACEMENTS.reduce(
      (content, [pattern, replacement]) =>
        content.replace(pattern, replacement),
      result,
    );
  }
  return result;
}

export interface MultipleExtractionResult {
  documents: NamedDocument[] | null;
  method: 'simple' | 'latex' | 'none';
}

/**
 * Extract multiple documents from XML content with fallback support.
 *
 * Primary path looks for <document name="..."> children inside the unified
 * <documents> container. When that finds nothing and a single-file recovery
 * hint is supplied, the extractor falls back to the legacy single-doc shape
 * (a bare \documentclass block) and synthesizes a one-document result named
 * after the hint. Without a hint, recovery is skipped because a synthesized
 * document with no name has no unambiguous destination.
 *
 * Fenced ```latex/```tex blocks are deliberately NOT recovered here: this
 * function reads the whole response including the model's thinking tag, so a
 * fence inside the scratchpad would win over the real answer. Fence recovery
 * belongs to `collectLatexFencedBlocks`, which strips the thinking tag first
 * and parses fences per CommonMark. `XmlOutputManager` runs that tier ahead of
 * this one.
 *
 * @param outputContent The raw output content to extract from
 * @param containerTag The container tag to look for documents within
 * @param preferredName Recovery hint — when set, treat the single-doc legacy
 *   shape as a one-document result named after the hint
 * @returns Extraction result with documents array and method used
 */
export function extractDocuments(
  outputContent: string,
  containerTag: string,
  preferredName?: string,
): MultipleExtractionResult {
  // Primary tier: `<document name="...">` children inside the container tag,
  // falling back to a whole-response scan when the container is absent or
  // holds none of them.
  const container = outputContent.match(
    new RegExp(`<${containerTag}>(.*?)<\/${containerTag}>`, 's'),
  )?.[1];
  const inContainer = container ? extractNamedDocuments(container) : [];
  const documents =
    inContainer.length > 0 ? inContainer : extractNamedDocuments(outputContent);
  if (documents.length > 0) {
    return { documents, method: 'simple' };
  }

  if (preferredName) {
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
