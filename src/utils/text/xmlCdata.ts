/**
 * CDATA section handling utilities.
 * Single source of truth for CDATA operations in XML content.
 */

/**
 * CDATA section pattern for removal.
 * Single source of truth for CDATA handling.
 */
const CDATA_PATTERN = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

function isCdataWrapped(content: string): boolean {
  return (
    content.trimStart().startsWith('<![CDATA[') &&
    content.trimEnd().endsWith(']]>')
  );
}

/**
 * Remove CDATA sections from content.
 * Centralized function to eliminate duplicate CDATA removal patterns.
 *
 * @param content - Content potentially containing CDATA sections
 * @returns Content with CDATA wrappers removed
 */
export function removeCDATA(content: string): string {
  let current = content;
  while (true) {
    const cleaned = current.replaceAll(CDATA_PATTERN, '$1');
    if (cleaned === current) return cleaned;
    current = cleaned;
  }
}

/**
 * Wrap the content of each tag with a CDATA section, tolerating attributes on
 * the open tag.
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
    return result.replace(pattern, (_, openTag, body, closeTag) =>
      isCdataWrapped(body)
        ? `${openTag}${body}${closeTag}`
        : `${openTag}<![CDATA[${body}]]>${closeTag}`,
    );
  }, xmlData);
}
