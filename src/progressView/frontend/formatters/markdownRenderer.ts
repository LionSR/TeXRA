// Third-party imports
import MarkdownIt from 'markdown-it';
import highlight from 'markdown-it-highlightjs';
import texmath from 'markdown-it-texmath';
import katex from 'katex';

// Local imports
import { katexMacros } from './katexMacros';

type MarkdownRenderer = ReturnType<typeof MarkdownIt>;

let markdownRenderer: MarkdownRenderer | undefined;

const CACHE_MAX_SIZE = 500;
const markdownCache = new Map<string, string>();

export const getMarkdownRenderer = (): MarkdownRenderer => {
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

export const createLatexReferenceHtml = (refType: string, label: string) =>
  `<span class="latex-ref clickable-link" data-label="${label}">\\${refType}{${label}}</span>`;

export const protectLatexReferences = (content: string): string =>
  content
    .replace(/\\ref\{([^}]+)\}/g, '@@LATEX-REF:$1@@')
    .replace(/\\cref\{([^}]+)\}/g, '@@LATEX-CREF:$1@@')
    .replace(/\\eqref\{([^}]+)\}/g, '@@LATEX-EQREF:$1@@');

export const restoreLatexReferences = (content: string): string =>
  content
    .replace(/@@LATEX-REF:([^@]+)@@/g, (_, label) =>
      createLatexReferenceHtml('ref', label),
    )
    .replace(/@@LATEX-CREF:([^@]+)@@/g, (_, label) =>
      createLatexReferenceHtml('cref', label),
    )
    .replace(/@@LATEX-EQREF:([^@]+)@@/g, (_, label) =>
      createLatexReferenceHtml('eqref', label),
    );

const hashContent = (str: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash.toString(36);
};

export const processMarkdownContent = (
  content: string,
  renderer?: MarkdownRenderer,
): string => {
  const useCache = !renderer;
  const cacheKey = useCache ? hashContent(content) : null;

  if (useCache && cacheKey && markdownCache.has(cacheKey)) {
    const cached = markdownCache.get(cacheKey);
    if (cached) {
      markdownCache.delete(cacheKey);
      markdownCache.set(cacheKey, cached);
      return cached;
    }
  }

  const protectedContent = protectLatexReferences(content);
  const formattedContent = protectedContent.replace(/\.(\*\*[A-Z])/g, '.\n$1');

  const md = renderer || getMarkdownRenderer();
  const parsedMarkdown = md.render(formattedContent);
  const result = restoreLatexReferences(parsedMarkdown);

  if (useCache && cacheKey) {
    if (markdownCache.size >= CACHE_MAX_SIZE) {
      const firstKey = markdownCache.keys().next().value;
      if (firstKey) {
        markdownCache.delete(firstKey);
      }
    }
    markdownCache.set(cacheKey, result);
  }

  return result;
};

export const clearMarkdownCache = () => {
  markdownCache.clear();
};
