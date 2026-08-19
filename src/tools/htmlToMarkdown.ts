// Third-party imports
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

/**
 * The one HTML→Markdown converter configuration for tools that feed fetched or
 * parsed HTML into the model's context.
 *
 * `.remove(['style', 'script'])` matters for correctness, not tidiness:
 * Turndown's default rules keep the *text* of `<style>` and `<script>`
 * elements, so without it every inline CSS rule and every line of inline
 * JavaScript on a page is handed to the model as prose. The GFM plugin is what
 * keeps a `<table>` a table instead of a run of orphan cells.
 *
 * Returns a fresh service per call rather than a shared singleton: `.remove()`
 * and `.addRule()` mutate the instance, so a shared one lets any consumer
 * silently reconfigure every other consumer.
 */
export function createHtmlToMarkdown(): TurndownService {
  return new TurndownService({
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    headingStyle: 'atx',
    strongDelimiter: '**',
  })
    .remove(['style', 'script'])
    .use(gfm);
}
