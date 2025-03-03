// Local imports - log
import * as logger from '../logger/logUtils';
import { AgentLogger } from '../logger/AgentLogger';

const CHANNEL = 'Utils';
logger.initialize(CHANNEL);

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
  const regex = new RegExp(`<${documentTag}>(.*?)<\/${documentTag}>`, 's');
  const match = inputContent.match(regex);
  return match ? match[1] : '';
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
 */
export function extractContentFromTag(
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
 */
export function extractContentFromTagMultiple(
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
 * Extracts scratchpad content from the given output and logs it after formatting.
 * Converts LaTeX and XML notation to more readable markdown format.
 *
 * @param outputContent The content to extract scratchpad from
 * @param logger The logger instance to use for logging the formatted content
 * @param thinkingTag The XML tag name used for the scratchpad content
 */
export function extractAndLogScratchpad(
  outputContent: string,
  logger: AgentLogger,
  thinkingTag: string = 'scratchpad',
): void {
  const scratchpadContent = extractTextFromTag(outputContent, thinkingTag);
  if (scratchpadContent) {
    // Log original content for debugging
    console.log(
      'Original scratchpad content before formatting:',
      scratchpadContent,
    );

    // Format the content for improved rendering
    let formattedContent = scratchpadContent.trim();

    // Replace LaTeX notation with markdown-friendly equivalents
    formattedContent = formattedContent
      .replace(/\\section\{([^}]+)\}/g, '## $1')
      .replace(/\\subsection\{([^}]+)\}/g, '### $1')
      .replace(/\\begin\{itemize\}/g, '')
      .replace(/\\end\{itemize\}/g, '')
      // Also handle enumerate environments like itemize
      .replace(/\\begin\{enumerate\}/g, '')
      .replace(/\\end\{enumerate\}/g, '')
      .replace(/\\item\s+/g, '- ')
      .replace(/\\textbf\{([^}]+)\}/g, '**$1**')
      .replace(/\\textit\{([^}]+)\}/g, '*$1*')
      .replace(/\\emph\{([^}]+)\}/g, '*$1*')
      // Convert XML tags to markdown headings - general approach
      .replace(/<(\w+)>\s*([^<]*?)\s*<\/\1>/g, '## $1\n\n$2')
      // Convert opening tags without closing tags to markdown headings
      .replace(/<(\w+)>/g, '## $1\n\n')
      .replace(/<\/\w+>/g, '')
      // Escape LaTeX references but preserve the content
      .replace(/\\ref\{([^}]+)\}/g, '\\\\ref{$1}');

    // Log the formatted content
    logger.info(`Scratchpad content:\n${formattedContent}`);
  }
}
