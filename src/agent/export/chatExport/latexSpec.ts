/**
 * LaTeX format spec for chat export.
 *
 * The document preamble is injected via `createLatexSpec(latexPreamble)` rather
 * than imported here: the `.tex` template lives under the extension package's
 * `resources/` (host-specific), so this core formatter stays free of any
 * `@resources` import and is buildable from any host.
 */

import type { DocumentMeta, ExportAttachmentType } from '@agent/export/schemas';
import { sanitizeLiveLinkUrl } from '@shared/utils/liveLinkUrl';
import { filterNotNullish } from '@utils/core';

import { escapeLatex, escapeLatexUrl, latexListing } from './escapeUtils';
import {
  HEADER_FIELDS,
  type FormatSpec,
  type NodeRenderers,
} from './formatSpec';

function latexHeader(meta: DocumentMeta, latexPreamble: string): string {
  const esc = escapeLatex;

  const rows = HEADER_FIELDS.filter((f) => meta[f.key]).map(
    (f) => `\\textbf{${f.label}:} & ${esc(String(meta[f.key]))} \\\\`,
  );

  const instruction = meta.instruction
    ? `\n\\medskip\\noindent\\textbf{Instruction:} ${esc(meta.instruction)}\n`
    : '';

  const fileList = meta.files.length
    ? [
        '\n\\medskip\\noindent\\textbf{Files:}',
        '\\begin{itemize}',
        ...meta.files.map(
          ([l, v]) => `  \\item ${esc(l)}: \\texttt{${esc(v)}}`,
        ),
        '\\end{itemize}',
      ].join('\n')
    : '';

  return [
    latexPreamble,
    '',
    '\\begin{document}',
    '',
    '\\section*{TeXRA Chat Export}',
    '',
    '\\begin{tabular}{@{}ll}',
    ...rows,
    '\\end{tabular}',
    instruction,
    fileList,
    '',
    '\\bigskip\\hrule\\bigskip',
    '',
  ].join('\n');
}

const LATEX_ATTACHMENT_LABELS = {
  image: '\\textit{[Image attachment]}',
  document: '\\textit{[Document attachment]}',
} as const satisfies Record<ExportAttachmentType, string>;

function latexLinkOrText(url: string, title: string): string {
  const safeUrl = sanitizeLiveLinkUrl(url);
  const safeTitle = escapeLatex(title);
  return safeUrl
    ? `\\href{${escapeLatexUrl(safeUrl)}}{${safeTitle}}`
    : safeTitle;
}

const TEX_NODES: NodeRenderers = {
  'user-message': ({ parts }) => {
    const body = parts
      .map((p) =>
        p.type === 'text'
          ? escapeLatex(p.text)
          : LATEX_ATTACHMENT_LABELS[p.attachmentType],
      )
      .join('\n\n');
    return `\\begin{usermessage}\n${body}\n\\end{usermessage}\n`;
  },

  'assistant-text': ({ text }) =>
    `\\begin{assistantmessage}\n${escapeLatex(text)}\n\\end{assistantmessage}\n`,

  'tool-call': ({ name, input }) =>
    `\\begin{toolcallbox}{${escapeLatex(name)}}\n${latexListing(input)}\n\\end{toolcallbox}\n`,

  'tool-result': ({ text }) =>
    `\\begin{toolresultbox}\n${latexListing(text)}\n\\end{toolresultbox}\n`,

  'web-search': ({ query }) =>
    `\\begin{websearchbox}\n\\textbf{Query:} ${escapeLatex(query)}\n\\end{websearchbox}\n`,

  'web-search-results': ({ results }) => {
    const items = results
      .map((r) => `  \\item ${latexLinkOrText(r.url, r.title)}`)
      .join('\n');
    return `\\begin{websearchbox}\n\\begin{itemize}\n${items}\n\\end{itemize}\n\\end{websearchbox}\n`;
  },

  'web-fetch': ({ url, title, content }) => {
    const safeUrl = url ? sanitizeLiveLinkUrl(url) : undefined;
    return [
      '\\begin{websearchbox}',
      safeUrl ? `\\textbf{URL:} \\url{${escapeLatexUrl(safeUrl)}}` : undefined,
      title
        ? `${safeUrl ? '\\\\' : ''}\\textbf{Title:} ${escapeLatex(title)}`
        : undefined,
      content ? `\n${latexListing(content)}` : undefined,
      '\\end{websearchbox}',
      '',
    ]
      .filter(filterNotNullish)
      .join('\n');
  },
};

/**
 * Build the LaTeX format spec, binding the host-supplied document preamble
 * into the header renderer.
 */
export function createLatexSpec(latexPreamble: string): FormatSpec {
  return {
    header: (meta) => latexHeader(meta, latexPreamble),
    footer: '\\end{document}',
    nodes: TEX_NODES,
  };
}
