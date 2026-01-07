/**
 * Markdown rendering utilities with LaTeX reference support.
 */

import MarkdownIt from 'markdown-it';
import highlight from 'markdown-it-highlightjs';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import { katexMacros } from '../katexMacros.js';

let markdownRenderer;

/**
 * Get the shared markdown renderer instance
 * @returns {MarkdownIt} Configured markdown renderer
 */
export const getMarkdownRenderer = () => {
  if (!markdownRenderer) {
    markdownRenderer = new MarkdownIt({
      breaks: false,
      linkify: true,
      html: false,
    })
      .use(texmath, {
        engine: katex,
        delimiters: ['dollars', 'brackets'],
        katexOptions: {
          throwOnError: false,
          errorColor: '#cc0000',
          macros: katexMacros,
        },
      })
      .use(highlight);
  }

  return markdownRenderer;
};

/**
 * Create LaTeX reference HTML element
 * @param {string} refType - The reference type (ref, cref, eqref)
 * @param {string} label - The label value
 * @returns {string} HTML for the clickable reference
 */
export const createLatexReferenceHtml = (refType, label) => {
  return `<span class="latex-ref clickable-link" data-label="${label}">\\${refType}{${label}}</span>`;
};

/**
 * Protect LaTeX references from markdown parsing
 * @param {string} content - Content with LaTeX references
 * @returns {string} Content with placeholder references
 */
export const protectLatexReferences = (content) => {
  content = content.replace(/\\ref\{([^}]+)\}/g, '@@LATEX-REF:$1@@');
  content = content.replace(/\\cref\{([^}]+)\}/g, '@@LATEX-CREF:$1@@');
  content = content.replace(/\\eqref\{([^}]+)\}/g, '@@LATEX-EQREF:$1@@');
  return content;
};

/**
 * Restore LaTeX references from placeholders to clickable elements
 * @param {string} content - Content with placeholder references
 * @returns {string} Content with clickable LaTeX references
 */
export const restoreLatexReferences = (content) => {
  return content
    .replace(/@@LATEX-REF:([^@]+)@@/g, (_, label) =>
      createLatexReferenceHtml('ref', label),
    )
    .replace(/@@LATEX-CREF:([^@]+)@@/g, (_, label) =>
      createLatexReferenceHtml('cref', label),
    )
    .replace(/@@LATEX-EQREF:([^@]+)@@/g, (_, label) =>
      createLatexReferenceHtml('eqref', label),
    );
};

/**
 * Process markdown content with LaTeX reference protection
 * @param {string} content - Raw content to process
 * @param {MarkdownIt} [renderer] - Optional custom renderer
 * @returns {string} Processed markdown HTML
 */
export const processMarkdownContent = (content, renderer) => {
  // Pre-process LaTeX references to protect them from markdown parsing
  // Note: Pandoc reference formats are normalized to LaTeX at the source (xmlUtils.ts)
  const protectedContent = protectLatexReferences(content);

  const md = renderer || getMarkdownRenderer();

  // Process content as markdown
  let parsedMarkdown = md.render(protectedContent);

  // Post-process to restore and style LaTeX references
  return restoreLatexReferences(parsedMarkdown);
};
