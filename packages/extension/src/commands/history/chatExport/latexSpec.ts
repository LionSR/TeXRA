/** LaTeX format spec for chat export. */

import latexPreamble from '@resources/templates/chatExport.tex';
import type { DocumentMeta } from '@agent/export/schemas';
import { filterNotNullish } from '@utils/core';

import { escapeLatex, escapeLatexUrl, latexListing } from './escapeUtils';
import {
  HEADER_FIELDS,
  type FormatSpec,
  type NodeRenderers,
} from './formatSpec';

function latexHeader(meta: DocumentMeta): string {
  const esc = escapeLatex;

  const rows = HEADER_FIELDS.filter((f) => f.key === 'date' || meta[f.key]).map(
    (f) =>
      `\\textbf{${f.label}:} & ${esc(String(meta[f.key] ?? 'Unknown'))} \\\\`,
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

const LATEX_ATTACHMENT_LABELS: Record<string, string> = {
  image: '\\textit{[Image attachment]}',
  document: '\\textit{[Document attachment]}',
};

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
      .map(
        (r) =>
          `  \\item \\href{${escapeLatexUrl(r.url)}}{${escapeLatex(r.title)}}`,
      )
      .join('\n');
    return `\\begin{websearchbox}\n\\begin{itemize}\n${items}\n\\end{itemize}\n\\end{websearchbox}\n`;
  },

  'web-fetch': ({ url, title, content }) =>
    [
      '\\begin{websearchbox}',
      url ? `\\textbf{URL:} \\url{${escapeLatexUrl(url)}}` : undefined,
      title
        ? `${url ? '\\\\' : ''}\\textbf{Title:} ${escapeLatex(title)}`
        : undefined,
      content ? `\n${latexListing(content)}` : undefined,
      '\\end{websearchbox}',
      '',
    ]
      .filter(filterNotNullish)
      .join('\n'),
};

export const latexSpec: FormatSpec = {
  header: latexHeader,
  footer: '\\end{document}',
  nodes: TEX_NODES,
};
