/**
 * HTML chat export — renders an execution's conversation into a self-contained
 * webpage that uses the same markdown-it + KaTeX + highlight.js pipeline as
 * the in-app webview, so what you share matches what you see.
 *
 * The pipeline:
 *   1. normalizeMessages → ExportNode[]            (shared IR)
 *   2. pre-render each node's body with markdown-it → string of HTML
 *   3. wrap each into a PreparedNode (custom-element name + attrs + bodyHtml)
 *   4. build the page as a Lit *server-only* template
 *   5. render to string via @lit-labs/ssr — emits Declarative Shadow DOM
 *      so the bubble styling stays scoped without any client-side JS.
 *
 * The output references `./assets/{chat,katex.min,...}.css`; the asset
 * folder is staged alongside the file by the calling handler
 * (see SettingsViewMessageHandler.handleExportChat).
 */

import katex from 'katex';

import { katexMacros } from '@progressView/frontend/katexMacros';
import {
  createMarkdownProcessor,
  createMarkdownRenderer,
  type MarkdownProcessor,
} from '@shared/markdown';
import { highlightCode } from '@shared/highlighting/highlightCode';
import { createTexmathPlugin } from '@shared/markdown/texmathPlugin';
import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';
import {
  buildExportTemplate,
  type PreparedNode,
} from '@shared/htmlExport/buildExportTemplate';
import { renderTemplateToHtml } from '@shared/htmlExport/ssrRender';

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

function md(text: string): string {
  return getProcessor()(text);
}

/**
 * Wrap the rendered markdown / preformatted content in a `<div class="md">`
 * so the chat.css document-level rules (margins, list spacing, table style)
 * still target it. Components slot this div into shadow DOM via `<slot>`,
 * but the slotted node itself lives in light DOM where global CSS reaches.
 */
function wrapMd(html: string): string {
  return `<div class="md">${html}</div>`;
}

const ATTACHMENT_LABELS: Record<string, string> = {
  image: 'Image attachment',
  document: 'Document attachment',
};

function nodeToPrepared(node: ExportNode): PreparedNode {
  switch (node.kind) {
    case 'user-message': {
      const body = node.parts
        .map((p) => {
          if (p.type === 'text') return md(p.text);
          return `<p><span class="attachment-chip">${escapeText(
            ATTACHMENT_LABELS[p.attachmentType],
          )}</span></p>`;
        })
        .join('\n');
      return {
        tag: 'chat-message',
        role: 'user',
        bodyHtml: wrapMd(body),
      };
    }
    case 'assistant-text':
      return {
        tag: 'chat-message',
        role: 'assistant',
        bodyHtml: wrapMd(md(node.text)),
      };
    case 'tool-call':
      return {
        tag: 'chat-tool-block',
        kind: 'call',
        name: node.name,
        bodyHtml: wrapMd(md('```json\n' + node.input + '\n```')),
      };
    case 'tool-result':
      return {
        tag: 'chat-tool-block',
        kind: 'result',
        bodyHtml: wrapMd(md('```\n' + node.text + '\n```')),
      };
    case 'web-search':
      return {
        tag: 'chat-tool-block',
        kind: 'web-search',
        bodyHtml: wrapMd(
          `<p><strong>Query:</strong> ${escapeText(node.query)}</p>`,
        ),
      };
    case 'web-search-results': {
      const items = node.results
        .map(
          (r) =>
            `<li><a href="${escapeAttr(r.url)}" rel="noopener noreferrer">${escapeText(
              r.title,
            )}</a></li>`,
        )
        .join('\n');
      return {
        tag: 'chat-tool-block',
        kind: 'result',
        bodyHtml: `<ul class="web-search-results">${items}</ul>`,
      };
    }
    case 'web-fetch': {
      const parts: string[] = [];
      if (node.url) {
        parts.push(
          `<p><strong>URL:</strong> <a href="${escapeAttr(node.url)}" rel="noopener noreferrer">${escapeText(node.url)}</a></p>`,
        );
      }
      if (node.title) {
        parts.push(`<p><strong>Title:</strong> ${escapeText(node.title)}</p>`);
      }
      if (node.content) {
        parts.push(md('```\n' + node.content + '\n```'));
      }
      return {
        tag: 'chat-tool-block',
        kind: 'web-fetch',
        bodyHtml: wrapMd(parts.join('\n')),
      };
    }
  }
}

function headerRows(meta: DocumentMeta): Array<[string, string]> {
  const rows: Array<[string, string]> = [['Date', meta.date]];
  if (meta.agent) rows.push(['Agent', meta.agent]);
  if (meta.model) rows.push(['Model', meta.model]);
  return rows;
}

export interface HtmlExportOptions {
  /** Path the document uses to reach the assets folder. Defaults to `./assets`. */
  readonly assetsHref?: string;
  /** Document `<title>`. Defaults to the export description or "TeXRA Chat Export". */
  readonly title?: string;
}

export function formatChatAsHtml(
  input: ChatExportInput,
  options: HtmlExportOptions = {},
): string {
  const meta = extractMeta(input);
  const nodes = normalizeMessages(input.messages).map(nodeToPrepared);
  const title =
    options.title ?? input.description ?? meta.agent ?? 'TeXRA Chat Export';

  const template = buildExportTemplate({
    title,
    assetsHref: options.assetsHref ?? './assets',
    header: {
      title,
      // Suppress the subtitle when it would echo the title verbatim.
      subtitle:
        meta.description && meta.description !== title
          ? meta.description
          : undefined,
      rows: headerRows(meta),
      instruction: meta.instruction,
      files: meta.files,
    },
    nodes,
  });

  return renderTemplateToHtml(template);
}
