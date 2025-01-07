// Local imports - log
import * as logger from '../logger/logUtils';

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
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error extracting content from tag: ${err instanceof Error ? err.message : String(err)}. Structure: ${getObjectStructure(root)}`,
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
