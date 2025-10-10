// Third-party imports
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import nodePandoc from 'node-pandoc';

// Local imports - log
import * as logger from '@logger/logUtils';
import { K_SLICE } from '@utils/config';
import { checkToolInstalled } from '@utils/system/toolUtils';

const CHANNEL = 'xmlUtils';
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
  pandocCheckPromise = checkToolInstalled('pandoc', false).then((result) => {
    pandocAvailable = result;
    pandocCheckPromise = null; // Clear the promise after completion
    return result;
  });

  return pandocCheckPromise;
}

export enum outputFormat {
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
  // const htmlRegex = /<[^>]+>/; // this is wrong, as we might have some xml tags to separte scratchpad
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
    // return text.trim();
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
    return result;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Pandoc conversion failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Get a string representation of an object's structure without its values
 */
function getObjectStructure(obj: any): string {
  if (Array.isArray(obj)) {
    return `Array(${obj.length})`;
  }
  if (obj && typeof obj === 'object') {
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
    logger.error(
      CHANNEL,
      `Error adding CDATA to tags: ${err instanceof Error ? err.message : String(err)}`,
    );
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
  // This will find all matches of the tag
  const regex = new RegExp(`<${documentTag}>(.*?)<\/${documentTag}>`, 'gs');

  // Variables to track the last match
  let lastContent = '';
  let match;

  // Find all matches and keep the last one
  while ((match = regex.exec(inputContent)) !== null) {
    lastContent = match[1];
  }

  // Remove CDATA sections if present
  lastContent = lastContent.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1');
  return lastContent;
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
  return match[0].replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1');
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
  const extractDocuments = (
    content: string,
  ): Array<{ content: string; name: string }> => {
    const results: Array<{ content: string; name: string }> = [];
    const documentRegex = /<document.*?name="(.*?)".*?>(.*?)<\/document>/gs;

    let documentMatch;
    while ((documentMatch = documentRegex.exec(content)) !== null) {
      const name = documentMatch[1] || 'unnamed';
      // Extract content and remove CDATA sections if present
      let docContent = documentMatch[2] || '';
      docContent = docContent.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1');
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
      const documents = extractDocuments(containerMatch[1]);
      if (documents.length > 0) {
        return documents;
      }
      // If no documents found in container, will fall through to the fallback
    }
  }

  // Fallback: extract documents directly from the input content
  return extractDocuments(inputContent);
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
  root: Record<string, any>,
  documentTag: string,
): string | null {
  if (!root || typeof root !== 'object') {
    logger.error(
      CHANNEL,
      `Invalid root object. Structure: ${getObjectStructure(root)}`,
    );
    return null;
  }

  if (documentTag in root) {
    const content = root[documentTag];
    if (typeof content === 'string') {
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
  root: Record<string, any>,
  documentTag: string,
): Array<{ content: string; name: string }> | null {
  try {
    if (!root || typeof root !== 'object') {
      logger.error(
        CHANNEL,
        `Invalid root object. Structure: ${getObjectStructure(root)}`,
      );
      return null;
    }

    if (documentTag in root) {
      const container = root[documentTag];
      if (
        container &&
        typeof container === 'object' &&
        'document' in container
      ) {
        const documents = container.document;
        if (Array.isArray(documents)) {
          return documents.map((doc) => ({
            content: doc.content?.trim() || '',
            name: doc.name,
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
      `Error extracting multiple content from tag: ${err instanceof Error ? err.message : String(err)}. Structure: ${getObjectStructure(root)}`,
    );
    throw err;
  }
}

/**
 * Formats and logs special content (scratchpad or thinking) with standardized formatting
 *
 * @param content The raw content to format
 * @param logger The logger instance to use
 * @param contentType The type of content (e.g., 'Scratchpad', 'Thinking')
 * @param groupId Optional group ID for logging
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

export const xmlUtils = {
  addCdataToTags,
  addCdataToTagsMultiple,
  extractTextFromTag,
  extractLatexFromMarkdown,
  extractLatexBetweenDocumentClass,
  extractMultipleTextFromTag,
  filterTagsFromText,
  extractContentFromXMLbyTag,
  extractContentFromXMLbyTagMultiple,
  formatContent,
  extractScratchpad,
};

export default xmlUtils;
