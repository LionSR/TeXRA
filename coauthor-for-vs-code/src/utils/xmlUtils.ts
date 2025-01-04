// Local imports - core
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { readFile } from './fileUtils';

const CHANNEL = 'Utils';
logger.initializeLogging(CHANNEL);

/**
 * Get XML formatted string from a single file
 * @param file Path to the file
 * @returns XML formatted string containing file content
 */
export async function getXmlFormatFromFile(file: string): Promise<string> {
  try {
    const content = await readFile(file);
    return `<document name="${file}">\n${content}\n</document>`;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error formatting file as XML: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Get XML formatted string from multiple files
 * @param files List of file paths
 * @returns XML formatted string containing all file contents, or null if no files
 */
export async function getXmlFormatFromFiles(
  files: string[],
): Promise<string | null> {
  try {
    if (!files || files.length === 0) {
      return null;
    }

    const xmlPromises = files.map((file) => getXmlFormatFromFile(file));
    const xmlContents = await Promise.all(xmlPromises);
    return xmlContents.join('\n');
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error formatting files as XML: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
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

export function extractTextFromTags(
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
