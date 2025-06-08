// Local imports - log
import * as logger from '../logger/logUtils';
import { AgentLogger } from '../logger/AgentLogger';
import { K_SLICE } from './constants';

const CHANNEL = 'xmlUtils';
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
export function formatAndLogContent(
  content: string,
  agentLogger: AgentLogger,
  contentType: string = 'Scratchpad',
  groupId?: string,
): void {
  if (!content) {
    return;
  }

  // Log original content for debugging
  agentLogger.debug(
    `Original ${contentType.toLowerCase()} content before formatting: ${content.substring(0, K_SLICE)}${content.length > K_SLICE ? '...' : ''}`,
    groupId,
  );

  // Format the content for improved rendering
  let formattedContent = content.trim();

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
    // Standardize bullet lists starting with asterisk while avoiding emphasis markers
    .replace(/(^|\n)(\s*)\*\s+(?=\S)/g, '$1$2- ')
    .replace(/\\textbf\{([^}]+)\}/g, '**$1**')
    .replace(/\\textit\{([^}]+)\}/g, '*$1*')
    .replace(/\\emph\{([^}]+)\}/g, '*$1*')
    // Convert common HTML tags to markdown before generic XML handling
    .replace(/<br\s*\/?>/gi, '\n')
    // Handle p and div tags more carefully to avoid excessive newlines
    .replace(/<(?:p|div)\b[^>]*>/gi, '')
    .replace(/<\/(?:p|div)>/gi, '\n')
    .replace(/<(strong|b)>(.*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)>(.*?)<\/\1>/gi, '*$2*')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<pre>([\s\S]*?)<\/pre>/gi, '```\n$1\n```')
    .replace(/<h1>(.*?)<\/h1>/gi, '# $1\n')
    .replace(/<h2>(.*?)<\/h2>/gi, '## $1\n')
    .replace(/<h3>(.*?)<\/h3>/gi, '### $1\n')
    .replace(/<h4>(.*?)<\/h4>/gi, '#### $1\n')
    .replace(/<h5>(.*?)<\/h5>/gi, '##### $1\n')
    .replace(/<h6>(.*?)<\/h6>/gi, '###### $1\n')
    // Handle lists - simple approach
    // For XML tags containing lists (ol/ul), just remove the wrapper tag
    .replace(/<([\w-]{6,})>\s*(<[ou]l\b[\s\S]*?<\/[ou]l>)\s*<\/\1>/g, '$2')
    // Convert XML tags to markdown headings - only for semantic tags with 6+ characters that don't contain lists
    .replace(/<([\w-]{6,})>\s*([^<]*?)\s*<\/\1>/g, '## $1\n$2')
    // Remove ul and ol tags
    .replace(/<[ou]l>/gi, '')
    .replace(/<\/[ou]l>/gi, '')
    // Replace <li> with bullet point and remove </li> tags
    .replace(/<li>/gi, '- ')
    .replace(/<\/li>/gi, '')
    // Escape LaTeX references but preserve the content
    .replace(/~\\ref\{/g, ' \\ref{')
    .replace(/\\ref\{([^}]+)\}/g, '\\\\ref{$1}')
    // Remove multiple empty lines before list items, preserving indentation
    .replace(/\n(\s*)\n(\s*)\n(\s*)- /g, '\n$3- ')
    .replace(/\n(\s*)\n(\s*)- /g, '\n$2- ')
    // Clean up excessive whitespace and normalize line breaks
    .replace(/\n{4,}/g, '\n\n') // Replace 4+ newlines with 2

    .replace(/    /gm, '  '); // Replace 4 spaces with 2 spaces
  // .replace(/ +$/gm, ''); // Remove trailing spaces only

  agentLogger.info(formattedContent, groupId);

  // Log the formatted content
  agentLogger.info(`${contentType} content: ${formattedContent}`, groupId);
}

/**
 * Extracts scratchpad content from the given output and logs it after formatting.
 * Converts LaTeX and XML notation to more readable markdown format.
 *
 * @param outputContent The content to extract scratchpad from
 * @param logger The logger instance to use for logging the formatted content
 * @param thinkingTag The XML tag name used for the scratchpad content
 * @param groupId Optional group ID for logging
 */
export function extractAndLogScratchpad(
  outputContent: string,
  agentLogger: AgentLogger,
  thinkingTag: string = 'scratchpad',
  groupId?: string,
): void {
  const extractedContent = extractTextFromTag(outputContent, thinkingTag);
  if (extractedContent) {
    // Always log using the canonical "Scratchpad" label so that the progress
    // view recognises the message. The thinkingTag is still used for
    // extraction so alternative tag names continue to work.
    formatAndLogContent(extractedContent, agentLogger, 'Scratchpad', groupId);
  }
}
