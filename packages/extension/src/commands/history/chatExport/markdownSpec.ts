/** Markdown format spec for chat export. */

import { filterNotNullish } from '@utils/core';

import {
  HEADER_FIELDS,
  type FormatSpec,
  type NodeRenderers,
} from './formatSpec';
import type { DocumentMeta } from './schemas';

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

const ATTACHMENT_LABELS: Record<string, string> = {
  image: 'Image attachment',
  document: 'Document attachment',
};

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
    `#### Tool: \`${name}\`\n\n\`\`\`json\n${input}\n\`\`\`\n`,

  'tool-result': ({ text }) => `#### Tool Result\n\n\`\`\`\n${text}\n\`\`\`\n`,

  'web-search': ({ query }) => `#### Web Search\n\n**Query:** ${query}\n`,

  'web-search-results': ({ results }) =>
    results.map((r) => `- [${r.title}](${r.url})`).join('\n') + '\n',

  'web-fetch': ({ url, title, content }) =>
    [
      '#### Web Fetch',
      '',
      url ? `**URL:** ${url}` : undefined,
      title ? `**Title:** ${title}` : undefined,
      content ? `\n\`\`\`\n${content}\n\`\`\`` : undefined,
      '',
    ]
      .filter(filterNotNullish)
      .join('\n'),
};

export const markdownSpec: FormatSpec = {
  header: (meta) => `# TeXRA Chat Export\n\n${markdownHeader(meta)}`,
  footer: '',
  nodes: MD_NODES,
};
