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
 *
 * `unclosed` names a tag the model may leave open inside a container (a
 * `<document>` whose `</document>` it never wrote). Its body then ends before
 * the next opening of the same tag, before the container's closing tag, or at
 * the end of the text, and the missing close tag is written back. Without
 * this the body stays unwrapped and the XML parser reads a LaTeX overlay spec
 * such as `\begin{frame}<beamer>` as an element, cutting the document there.
 */
export function addCdataToTagsMultiple(
  xmlData: string,
  tags: readonly string[],
  unclosed?: { readonly tag: string; readonly container: string },
): string {
  return tags.reduce((result, tag) => {
    const end =
      tag === unclosed?.tag
        ? `(?:</${tag}>|(?=<${tag}[\\s>]|</${unclosed.container}>|$))`
        : `</${tag}>`;
    const pattern = new RegExp(`(<${tag}(?:\\s+[^>]*)?>)(.*?)${end}`, 'gs');
    return result.replace(pattern, (_, openTag: string, body: string) =>
      isCdataWrapped(body)
        ? `${openTag}${body}</${tag}>`
        : `${openTag}<![CDATA[${body}]]></${tag}>`,
    );
  }, xmlData);
}
