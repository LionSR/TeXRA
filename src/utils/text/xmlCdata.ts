/**
 * CDATA section handling utilities.
 * Single source of truth for CDATA operations in XML content.
 */

// Local imports - common
import { toErrorMessage } from '@common/errors';

// Local imports - logger
import * as logger from '@logger/logUtils';

const CHANNEL = 'xmlCdata';
logger.initialize(CHANNEL);

/**
 * CDATA section pattern for removal.
 * Single source of truth for CDATA handling.
 */
const CDATA_PATTERN = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

/**
 * Remove CDATA sections from content.
 * Centralized function to eliminate duplicate CDATA removal patterns.
 *
 * @param content - Content potentially containing CDATA sections
 * @returns Content with CDATA wrappers removed
 */
export function removeCDATA(content: string): string {
  return content.replaceAll(CDATA_PATTERN, '$1');
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
    logger.error(CHANNEL, `Error adding CDATA to tags: ${toErrorMessage(err)}`);
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
