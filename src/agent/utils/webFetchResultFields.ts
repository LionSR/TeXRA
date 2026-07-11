// Local imports
import { isObject } from '@utils/core';

/** Fields shared by conversation formatting and structured chat export. */
interface WebFetchResultFields {
  readonly url?: string;
  readonly title?: string;
  readonly content?: string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Read a web-fetch result from either Anthropic's live nested block or the
 * flat block reconstructed by the completed-run archive.
 */
export function extractWebFetchResultFields(
  block: unknown,
): WebFetchResultFields | undefined {
  if (!isObject(block)) return undefined;

  const liveResult = block.content;
  let fields: WebFetchResultFields;
  if (isObject(liveResult) && liveResult.type === 'web_fetch_result') {
    const document = isObject(liveResult.content)
      ? liveResult.content
      : undefined;
    const source =
      document && isObject(document.source) ? document.source : undefined;
    fields = {
      url: optionalString(liveResult.url),
      title: optionalString(document?.title),
      content:
        source?.type === 'text' ? optionalString(source.data) : undefined,
    };
  } else {
    fields = {
      url: optionalString(block.url),
      title: optionalString(block.title),
      content: optionalString(block.page_content),
    };
  }

  return fields.url !== undefined ||
    fields.title !== undefined ||
    fields.content !== undefined
    ? fields
    : undefined;
}
