/**
 * LaTeX format spec for chat export.
 *
 * The document preamble is passed into `formatChatAsLatex`: the caller reads
 * it from the packaged resources' `templates/chatExport.tex`, so this
 * formatter stays pure.
 */

import type {
  ChatExportInput,
  DocumentMeta,
} from '@texra/agent/export/schemas';

import {
  ATTACHMENT_LABELS,
  EXPORT_TITLE,
  HEADER_FIELDS,
  renderDocument,
  type NodeRenderers,
} from './formatSpec';

/**
 * A character-level replacement map (pandoc/pylatex pattern) avoids ordering
 * bugs: every special character is handled exactly once in a single pass.
 */
const LATEX_ESCAPE_MAP: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '#': '\\#',
  $: '\\$',
  '%': '\\%',
  '&': '\\&',
  _: '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
};

const LATEX_ESCAPE_RE = /[\\#$%&_{}~^]/g;

function escapeLatex(text: string): string {
  return text.replaceAll(LATEX_ESCAPE_RE, (ch) => LATEX_ESCAPE_MAP[ch]);
}

/** Wrap text in lstlisting, handling nested end markers. */
function latexListing(text: string): string {
  const safeText = text.replaceAll('\\end{lstlisting}', '\\end {lstlisting}');
  return `\\begin{lstlisting}\n${safeText}\n\\end{lstlisting}`;
}

function latexHeader(meta: DocumentMeta, latexPreamble: string): string {
  const rows = HEADER_FIELDS.filter((f) => meta[f.key]).map(
    (f) => `\\textbf{${f.label}:} & ${escapeLatex(String(meta[f.key]))} \\\\`,
  );

  const instruction = meta.instruction
    ? `\n\\medskip\\noindent\\textbf{Instruction:} ${escapeLatex(meta.instruction)}\n`
    : '';

  const fileList = meta.files.length
    ? [
        '\n\\medskip\\noindent\\textbf{Files:}',
        '\\begin{itemize}',
        ...meta.files.map(
          ({ label, value }) =>
            `  \\item ${escapeLatex(label)}: \\texttt{${escapeLatex(value)}}`,
        ),
        '\\end{itemize}',
      ].join('\n')
    : '';

  return [
    latexPreamble,
    '',
    '\\begin{document}',
    '',
    `\\section*{${EXPORT_TITLE}}`,
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

const TEX_NODES: NodeRenderers = {
  'user-message': ({ parts }) => {
    const body = parts
      .map((p) =>
        p.type === 'text'
          ? escapeLatex(p.text)
          : `\\textit{[${ATTACHMENT_LABELS[p.attachmentType]}]}`,
      )
      .join('\n\n');
    return `\\begin{usermessage}\n${body}\n\\end{usermessage}\n`;
  },

  'assistant-text': ({ text }) =>
    `\\begin{assistantmessage}\n${escapeLatex(text)}\n\\end{assistantmessage}\n`,

  thinking: () => '',

  'tool-call': ({ name, input }) =>
    `\\begin{toolcallbox}{${escapeLatex(name)}}\n${latexListing(JSON.stringify(input, null, 2))}\n\\end{toolcallbox}\n`,

  'tool-result': ({ text }) =>
    `\\begin{toolresultbox}\n${latexListing(text)}\n\\end{toolresultbox}\n`,

  'web-search': ({ query }) =>
    `\\begin{websearchbox}\n\\textbf{Query:} ${escapeLatex(query)}\n\\end{websearchbox}\n`,
};

/** Render a conversation as a LaTeX document under the host-supplied preamble. */
export function formatChatAsLatex(
  input: ChatExportInput,
  latexPreamble: string,
): string {
  return renderDocument(input, {
    header: (meta) => latexHeader(meta, latexPreamble),
    footer: '\\end{document}',
    nodes: TEX_NODES,
  });
}
