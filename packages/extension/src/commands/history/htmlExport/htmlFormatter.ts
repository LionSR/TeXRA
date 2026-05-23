/**
 * HTML chat export — renders an execution's conversation into a self-contained
 * webpage that uses the same markdown-it + KaTeX + highlight.js pipeline as
 * the in-app webview, so what you share matches what you see.
 *
 * Output is a string of HTML that references `./assets/{chat,katex.min,...}.css`
 * — the asset folder itself is staged alongside the file by the calling
 * handler (see SettingsViewMessageHandler.handleExportChat).
 *
 * The renderer is built lazily — markdown-it + KaTeX are heavy and we don't
 * want them in the cold path for callers who only ever export Markdown.
 */

import katex from 'katex';

import { katexMacros } from '@progressView/frontend/katexMacros';
import {
  createMarkdownProcessor,
  createMarkdownRenderer,
  type MarkdownProcessor,
} from '@shared/markdown';
import { createTexmathPlugin } from '@shared/markdown/texmathPlugin';
import { highlightCode } from '@shared/highlighting/highlightCode';
import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';

import {
  extractMeta,
  normalizeMessages,
  type ChatExportInput,
  type DocumentMeta,
  type ExportNode,
} from '../chatExportFormatter';

let cachedProcessor: MarkdownProcessor | null = null;

function getProcessor(): MarkdownProcessor {
  if (!cachedProcessor) {
    const renderer = createMarkdownRenderer({
      highlight: highlightCode,
      usePlugin: createTexmathPlugin({
        engine: katex,
        engineOptions: {
          throwOnError: false,
          // Export targets a generic browser, not the VS Code webview, so use
          // a literal colour instead of a CSS custom property.
          errorColor: '#cc0000',
          macros: katexMacros,
        },
      }),
    });
    cachedProcessor = createMarkdownProcessor({
      renderer,
      // Webview renders LaTeX refs as clickable scroll targets; in a static
      // export they're decorative, so emit plain styled text.
      formatLatexReference: (refType, label) =>
        `<span class="latex-ref">\\${refType}{${escapeText(label)}}</span>`,
    });
  }
  return cachedProcessor;
}

function renderMarkdown(text: string): string {
  return getProcessor()(text);
}

const ATTACHMENT_LABELS: Record<string, string> = {
  image: 'Image attachment',
  document: 'Document attachment',
};

const HTML_NODES: { [K in ExportNode['kind']]: (
  node: Extract<ExportNode, { kind: K }>,
) => string } = {
  'user-message': ({ parts }) => {
    const body = parts
      .map((p) => {
        if (p.type === 'text') return renderMarkdown(p.text);
        return `<span class="attachment-chip">${escapeText(
          ATTACHMENT_LABELS[p.attachmentType],
        )}</span>`;
      })
      .join('\n');
    return `<section class="message user">
  <div class="message-role">User</div>
  <div class="md">${body}</div>
</section>`;
  },

  'assistant-text': ({ text }) => `<section class="message assistant">
  <div class="message-role">Assistant</div>
  <div class="md">${renderMarkdown(text)}</div>
</section>`,

  'tool-call': ({ name, input }) => {
    const fenced = '```json\n' + input + '\n```';
    return `<section class="message tool">
  <div class="message-role">Tool call</div>
  <div class="tool-meta">tool <span class="tool-name">${escapeText(name)}</span></div>
  <div class="md">${renderMarkdown(fenced)}</div>
</section>`;
  },

  'tool-result': ({ text }) => {
    const fenced = '```\n' + text + '\n```';
    return `<section class="message tool-result">
  <div class="message-role">Tool result</div>
  <div class="md">${renderMarkdown(fenced)}</div>
</section>`;
  },

  'web-search': ({ query }) => `<section class="message tool">
  <div class="message-role">Web search</div>
  <div class="md"><p><strong>Query:</strong> ${escapeText(query)}</p></div>
</section>`,

  'web-search-results': ({ results }) => {
    const items = results
      .map(
        (r) =>
          `<li><a href="${escapeAttr(r.url)}" rel="noopener noreferrer">${escapeText(
            r.title,
          )}</a></li>`,
      )
      .join('\n');
    return `<section class="message tool-result">
  <div class="message-role">Web results</div>
  <ul class="web-search-results">${items}</ul>
</section>`;
  },

  'web-fetch': ({ url, title, content }) => {
    const parts: string[] = [];
    if (url) {
      parts.push(
        `<p><strong>URL:</strong> <a href="${escapeAttr(url)}" rel="noopener noreferrer">${escapeText(url)}</a></p>`,
      );
    }
    if (title) {
      parts.push(`<p><strong>Title:</strong> ${escapeText(title)}</p>`);
    }
    if (content) {
      parts.push(renderMarkdown('```\n' + content + '\n```'));
    }
    return `<section class="message tool-result">
  <div class="message-role">Web fetch</div>
  <div class="md">${parts.join('\n')}</div>
</section>`;
  },
};

function renderNode(node: ExportNode): string {
  return (
    HTML_NODES as Record<string, (n: ExportNode) => string>
  )[node.kind](node);
}

function renderHeader(meta: DocumentMeta, title: string): string {
  const rows: string[] = [];
  rows.push(`<dt>Date</dt><dd>${escapeText(meta.date)}</dd>`);
  if (meta.agent) {
    rows.push(`<dt>Agent</dt><dd>${escapeText(meta.agent)}</dd>`);
  }
  if (meta.model) {
    rows.push(`<dt>Model</dt><dd>${escapeText(meta.model)}</dd>`);
  }

  // Suppress the subtitle when it would echo the title verbatim.
  const subtitle =
    meta.description && meta.description !== title
      ? `<p class="export-subtitle">${escapeText(meta.description)}</p>`
      : '';

  const instruction = meta.instruction
    ? `<div class="instruction-block"><strong>Instruction:</strong>\n${escapeText(
        meta.instruction,
      )}</div>`
    : '';

  const files = meta.files.length
    ? `<div class="meta-files">
  <p class="meta-files-title">Files</p>
  <ul>${meta.files
    .map(
      ([label, value]) =>
        `<li>${escapeText(label)}: <code>${escapeText(value)}</code></li>`,
    )
    .join('\n')}</ul>
</div>`
    : '';

  return `<header class="export-header">
  <h1 class="export-title">${escapeText(title)}</h1>
  ${subtitle}
  <dl class="meta-grid">${rows.join('\n')}</dl>
  ${instruction}
  ${files}
</header>`;
}

export interface HtmlExportOptions {
  /** Path the document uses to reach the assets folder. Defaults to `./assets`. */
  readonly assetsHref?: string;
  /** Document <title>. Defaults to the export description or "TeXRA Chat Export". */
  readonly title?: string;
}

export function formatChatAsHtml(
  input: ChatExportInput,
  options: HtmlExportOptions = {},
): string {
  const meta = extractMeta(input);
  const nodes = normalizeMessages(input.messages);
  const assets = options.assetsHref ?? './assets';
  const title =
    options.title ?? input.description ?? meta.agent ?? 'TeXRA Chat Export';

  // Pick a hljs theme by listening to the user's OS preference; both stylesheets
  // are inert until the matching media query matches.
  const head = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="generator" content="TeXRA chat export" />
  <title>${escapeText(title)}</title>
  <link rel="stylesheet" href="${escapeAttr(assets)}/katex.min.css" />
  <link rel="stylesheet" href="${escapeAttr(assets)}/texmath.css" />
  <link
    rel="stylesheet"
    href="${escapeAttr(assets)}/hljs-light.css"
    media="(prefers-color-scheme: light)"
  />
  <link
    rel="stylesheet"
    href="${escapeAttr(assets)}/hljs-dark.css"
    media="(prefers-color-scheme: dark)"
  />
  <link rel="stylesheet" href="${escapeAttr(assets)}/chat.css" />
</head>`;

  const body = `<body>
  <main class="page">
    ${renderHeader(meta, title)}
    <div class="conversation">
      ${nodes.map(renderNode).join('\n      ')}
    </div>
    <footer class="export-footer">
      Generated by TeXRA — see the original conversation in the TeXRA history pane.
    </footer>
  </main>
</body>
</html>`;

  return `${head}\n${body}\n`;
}
