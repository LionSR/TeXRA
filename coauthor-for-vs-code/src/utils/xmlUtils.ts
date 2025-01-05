// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { readFile } from './fileUtils';

const CHANNEL = 'Utils';
logger.initializeLogging(CHANNEL);

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
  try {
    return tags.reduce((result, tag) => {
      const pattern = new RegExp(
        `(<${tag}(?:\\s+[^>]*)?>)(.*?)(</${tag}>)`,
        'gs',
      );
      return result.replace(pattern, '$1<![CDATA[$2]]>$3');
    }, xmlData);
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error adding CDATA to tags with attributes: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

export function extractTextFromTag(
  inputContent: string,
  documentTag: string,
): string {
  const regex = new RegExp(`<${documentTag}>(.*?)<\/${documentTag}>`, 's');
  const match = inputContent.match(regex);
  return match ? match[1] : inputContent;
}

/**
 * Remove specified XML tags and their content from input string
 */
export function filterTagsFromText(
  content: string,
  tags: string | string[],
): string {
  try {
    const tagArray = typeof tags === 'string' ? [tags] : tags;
    return tagArray.reduce((result, tag) => {
      const pattern = new RegExp(`<${tag}>.*?</${tag}>\\s*`, 'gs');
      return result.replace(pattern, '');
    }, content);
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error filtering tags from text: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Extract content from XML document element for single document case
 */
export function extractContentFromTag(
  root: Record<string, any>,
  documentTag: string,
): string | null {
  try {
    logger.error(
      CHANNEL,
      `Extracting document content from root: ${JSON.stringify(root)}`,
    );

    if (!root || typeof root !== 'object') {
      logger.error(CHANNEL, `Invalid root object`);
      return null;
    }

    if (documentTag in root) {
      const content = root[documentTag];
      // For single document case, content should be a string
      if (typeof content === 'string') {
        return content.trim();
      }
      // If it's an array, that means it's a multiple document case
      if (Array.isArray(content)) {
        logger.error(
          CHANNEL,
          `Found array of documents, should use extractContentFromTagMultiple instead`,
        );
        return null;
      }
    }

    logger.error(CHANNEL, `No ${documentTag} found in output file`);
    return null;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error extracting content from tag: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Extract content from XML document element for multiple document case
 */
export function extractContentFromTagMultiple(
  root: Record<string, any>,
  documentTag: string,
): Array<{ content: string; name: string }> | null {
  try {
    logger.error(
      CHANNEL,
      `Extracting multiple document content from root: ${JSON.stringify(root)}`,
    );

    if (!root || typeof root !== 'object') {
      logger.error(CHANNEL, `Invalid root object`);
      return null;
    }

    if (documentTag in root) {
      const container = root[documentTag];
      if (container && typeof container === 'object') {
        const documents = container.document;
        if (Array.isArray(documents)) {
          return documents.map((doc) => ({
            content: doc.content?.trim() || '',
            name: doc.name,
          }));
        }
        // Handle single document case
        if (documents && typeof documents === 'object') {
          return [
            {
              content: documents.content?.trim() || '',
              name: documents.name,
            },
          ];
        }
      }
    }

    logger.error(
      CHANNEL,
      `No ${documentTag} or document elements found in output file`,
    );
    return null;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error extracting multiple content from tag: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
