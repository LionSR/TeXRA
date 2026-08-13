/**
 * Shared lightweight markdown renderer (no LaTeX/KaTeX).
 * Used by settings-view components that need simple markdown rendering
 * with code highlighting.
 */

import {
  createMarkdownRenderer,
  type MarkdownItInstance,
} from '@shared/markdown/createMarkdownRenderer';

import { highlightCode } from './highlightCode';

let md: MarkdownItInstance | null = null;

/** Returns a shared, lazily-initialized MarkdownIt instance. */
export function getLightweightMd(): MarkdownItInstance {
  md ??= createMarkdownRenderer({ highlight: highlightCode });
  return md;
}
