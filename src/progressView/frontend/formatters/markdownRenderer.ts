/**
 * Markdown rendering utilities with LaTeX reference support.
 */

// Third-party imports
import MarkdownIt from 'markdown-it';
import texmath from 'markdown-it-texmath';
import katex from 'katex';

// Local imports - optimized highlight.js with only TeXRA-relevant languages
import hljs from '@shared/highlighting/hljs';

// Local imports - progress view helpers
import { katexMacros } from '../katexMacros';

let markdownRenderer: MarkdownIt | null = null;

// LRU cache for rendered markdown (content hash → HTML)
const CACHE_MAX_SIZE = 500;
const markdownCache = new Map<string, string>();

/**
 * Custom highlight function for markdown-it using optimized hljs.
 * Falls back to plain text if language is not registered.
 */
const highlightCode = (code: string, lang: string): string => {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      // Fall through to plain text
    }
  }
  // Return escaped code for unknown/missing language
  return '';
};

/** Get the shared markdown renderer instance. */
export const getMarkdownRenderer = (): MarkdownIt => {
  if (!markdownRenderer) {
    markdownRenderer = new MarkdownIt({
      breaks: false,
      linkify: true,
      html: false,
      highlight: highlightCode,
    }).use(texmath, {
      engine: katex,
      // Include beg_end to catch \begin{...}...\end{...} environments directly
      delimiters: ['dollars', 'brackets', 'beg_end'],
      katexOptions: {
        throwOnError: false,
        errorColor: '#cc0000',
        macros: katexMacros,
      },
    });
  }

  return markdownRenderer;
};

/** Create LaTeX reference HTML element. */
const createLatexReferenceHtml = (refType: string, label: string): string => {
  return `<span class="latex-ref clickable-link" data-label="${label}">\\${refType}{${label}}</span>`;
};

/** Protect LaTeX references from markdown parsing. */
const protectLatexReferences = (content: string): string => {
  content = content.replaceAll(/\\ref\{([^}]+)\}/g, '@@LATEX-REF:$1@@');
  content = content.replaceAll(/\\cref\{([^}]+)\}/g, '@@LATEX-CREF:$1@@');
  content = content.replaceAll(/\\eqref\{([^}]+)\}/g, '@@LATEX-EQREF:$1@@');
  return content;
};

/** Restore LaTeX references from placeholders to clickable elements. */
const restoreLatexReferences = (content: string): string => {
  return content
    .replaceAll(/@@LATEX-REF:([^@]+)@@/g, (_, label) =>
      createLatexReferenceHtml('ref', label),
    )
    .replaceAll(/@@LATEX-CREF:([^@]+)@@/g, (_, label) =>
      createLatexReferenceHtml('cref', label),
    )
    .replaceAll(/@@LATEX-EQREF:([^@]+)@@/g, (_, label) =>
      createLatexReferenceHtml('eqref', label),
    );
};

/** Simple hash function for cache keys (FNV-1a variant). */
const hashContent = (str: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash.toString(36);
};

/** Process markdown content with LaTeX reference protection. */
export const processMarkdownContent = (
  content: string,
  renderer?: MarkdownIt,
): string => {
  // Check cache first (only for default renderer)
  const useCache = !renderer;
  const cacheKey = useCache ? hashContent(content) : null;

  if (useCache && cacheKey && markdownCache.has(cacheKey)) {
    // Move to end for LRU behavior
    const cached = markdownCache.get(cacheKey);
    if (!cached) {
      return '';
    }
    markdownCache.delete(cacheKey);
    markdownCache.set(cacheKey, cached);
    return cached;
  }

  // Pre-process LaTeX references to protect them from markdown parsing
  // Note: Pandoc reference formats are normalized to LaTeX at the source (xmlUtils.ts)
  const protectedContent = protectLatexReferences(content);

  // Add line break before bold text starting a new sentence (capital letter after period)
  // This fixes OpenAI reasoning summary output which omits line breaks before bold headers
  const formattedContent = protectedContent.replaceAll(
    /\.(\*\*[A-Z])/g,
    '.\n$1',
  );

  const md = renderer || getMarkdownRenderer();

  // Process content as markdown
  const parsedMarkdown = md.render(formattedContent);

  // Post-process to restore and style LaTeX references
  const result = restoreLatexReferences(parsedMarkdown);

  // Store in cache with LRU eviction
  if (useCache && cacheKey) {
    if (markdownCache.size >= CACHE_MAX_SIZE) {
      // Delete oldest entry (first key)
      const firstKey = markdownCache.keys().next().value;
      if (firstKey) {
        markdownCache.delete(firstKey);
      }
    }
    markdownCache.set(cacheKey, result);
  }

  return result;
};
