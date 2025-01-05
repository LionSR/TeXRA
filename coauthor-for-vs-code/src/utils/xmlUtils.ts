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
 * Extract content from XML document element
 */
export function extractContentFromTag(
  root: any[],
  documentTag: string,
): string | null {
  try {
    logger.debug(
      CHANNEL,
      `Extracting document content from root: ${JSON.stringify(root)}`,
    );
    // Find the object containing the documentTag
    const docObj = root.find(
      (item: { [key: string]: any }) => item[documentTag],
    );
    if (docObj && docObj[documentTag]) {
      const content = docObj[documentTag][0]?.content;
      if (content) {
        return content.trim();
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
