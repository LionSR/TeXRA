/** Markdown format spec for chat export. */

import type { DocumentMeta, ExportAttachmentType } from '@agent/export/schemas';
import { sanitizeLiveLinkUrl } from '@shared/utils/liveLinkUrl';
import { filterNotNullish } from '@utils/core';

import {
  HEADER_FIELDS,
  type FormatSpec,
  type NodeRenderers,
} from './formatSpec';

/**
 * Wrap raw body text in a fenced code block whose delimiter is longer than the
 * longest backtick run inside the body. Tool output and fetched pages routinely
 * contain ``` lines; a fixed three-backtick fence would let them break out and
 * corrupt the document. CommonMark closes a fence only on a backtick run at
 * least as long as the opening one, so an over-long fence is breakout-proof.
 */
function fencedBlock(body: string, info = ''): string {
  const longestRun = Math.max(
    0,
    ...[...body.matchAll(/`+/g)].map((m) => m[0].length),
  );
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${info}\n${body}\n${fence}`;
}

function markdownHeader(meta: DocumentMeta): string {
  const fields = HEADER_FIELDS.filter((f) => meta[f.key])
    .map((f) => `**${f.label}:** ${meta[f.key]}  `)
    .join('\n');

  const instruction = meta.instruction
    ? `**Instruction:** ${meta.instruction}\n`
    : '';

  const fileList = meta.files.length
    ? [
        '**Files:**',
        ...meta.files.map(([l, v]) => `- ${l}: \`${v}\``),
        '',
      ].join('\n')
    : '';

  return [
    fields,
    '',
    instruction,
    fileList,
    '---',
    '',
    '## Conversation',
    '',
  ].join('\n');
}

const ATTACHMENT_LABELS = {
  image: 'Image attachment',
  document: 'Document attachment',
} as const satisfies Record<ExportAttachmentType, string>;

// Backtick/*/_/# added on top of the link-syntax-breaking set: a
// tool-controlled title containing them can trigger incidental code-span,
// emphasis, or heading formatting even though it can't inject a live link.
const MARKDOWN_TEXT_ESCAPE_RE = /[\\[\]()<>!`*_#]/g;
// No `[`/`]` here (unlike MARKDOWN_TEXT_ESCAPE_RE above): CommonMark's
// bare-form link destination grammar restricts only unescaped/unbalanced
// parentheses, ASCII space, and control characters — square brackets have
// no special meaning inside `(...)`. Percent-encoding them anyway breaks
// legitimate IPv6 literal hosts like `http://[::1]/`, whose brackets are
// required syntax, not markdown syntax.
const MARKDOWN_URL_DESTINATION_ESCAPE_RE = /[\\()<> \t\r\n]/g;

function escapeMarkdownText(text: string): string {
  return text.replaceAll(MARKDOWN_TEXT_ESCAPE_RE, (ch) => `\\${ch}`);
}

function escapeMarkdownUrlDestination(url: string): string {
  return url.replaceAll(
    MARKDOWN_URL_DESTINATION_ESCAPE_RE,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

function markdownLinkOrText(url: string, title: string): string {
  const safeUrl = sanitizeLiveLinkUrl(url);
  const safeTitle = escapeMarkdownText(title);
  return safeUrl
    ? `[${safeTitle}](${escapeMarkdownUrlDestination(safeUrl)})`
    : safeTitle;
}

const MD_NODES: NodeRenderers = {
  'user-message': ({ parts }) => {
    const body = parts
      .map((p) =>
        p.type === 'text'
          ? p.text
          : `*[${ATTACHMENT_LABELS[p.attachmentType]}]*`,
      )
      .join('\n\n');
    return `### User\n\n${body}\n`;
  },

  'assistant-text': ({ text }) => `### Assistant\n\n${text}\n`,

  'tool-call': ({ name, input }) =>
    `#### Tool: \`${name}\`\n\n${fencedBlock(input, 'json')}\n`,

  'tool-result': ({ text }) => `#### Tool Result\n\n${fencedBlock(text)}\n`,

  'web-search': ({ query }) => `#### Web Search\n\n**Query:** ${query}\n`,

  'web-search-results': ({ results }) =>
    results.map((r) => `- ${markdownLinkOrText(r.url, r.title)}`).join('\n') +
    '\n',

  'web-fetch': ({ url, title, content }) => {
    const safeUrl = url ? sanitizeLiveLinkUrl(url) : undefined;
    return [
      '#### Web Fetch',
      '',
      safeUrl ? `**URL:** ${escapeMarkdownText(safeUrl)}` : undefined,
      title ? `**Title:** ${escapeMarkdownText(title)}` : undefined,
      content ? `\n${fencedBlock(content)}` : undefined,
      '',
    ]
      .filter(filterNotNullish)
      .join('\n');
  },
};

export const markdownSpec: FormatSpec = {
  header: (meta) => `# TeXRA Chat Export\n\n${markdownHeader(meta)}`,
  footer: '',
  nodes: MD_NODES,
};
