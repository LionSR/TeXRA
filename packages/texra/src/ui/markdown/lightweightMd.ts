/**
 * Shared lightweight markdown renderer (no LaTeX/KaTeX).
 * Used by settings-view components that need simple markdown rendering
 * with code highlighting.
 */

import { highlightCode } from '@texra/shared/highlighting/highlightCode';
import {
  createMarkdownRenderer,
  type MarkdownItInstance,
} from './createMarkdownRenderer';


let md: MarkdownItInstance | null = null;

/** Returns a shared, lazily-initialized MarkdownIt instance. */
export function getLightweightMd(): MarkdownItInstance {
  md ??= createMarkdownRenderer({ highlight: highlightCode });
  return md;
}
