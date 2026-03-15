/**
 * Shared lightweight markdown renderer (no LaTeX/KaTeX).
 * Used by settings-view components that need simple markdown rendering
 * with code highlighting.
 */

import MarkdownIt from 'markdown-it';

import { highlightCode } from './highlightCode';

let md: MarkdownIt | null = null;

/** Returns a shared, lazily-initialized MarkdownIt instance. */
export const getLightweightMd = (): MarkdownIt => {
  if (!md) {
    md = new MarkdownIt({
      breaks: false,
      linkify: true,
      html: false,
      highlight: highlightCode,
    });
  }
  return md;
};
