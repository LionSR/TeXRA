/**
 * Template-driven formatters for exporting chat conversations
 * as Markdown or LaTeX documents.
 *
 * Architecture (pandoc-style):
 *   raw messages → normalizeMessages() → ExportNode[] → FormatSpec → string
 *
 * Each output format is a FormatSpec: a header template, a footer string,
 * and a node-renderer table. Adding a new block type means adding one case
 * to assistantBlockToNode() and one entry per renderer table.
 *
 * This module is VS Code-free — all platform wiring lives in the caller.
 */

import { z } from 'zod';

// ============================================================
// Input schemas (single source of truth)
// ============================================================

/** Loose schema for API content blocks — accepts many optional fields. */
const ContentBlockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  thinking: z.string().optional(),
  name: z.string().optional(),
  id: z.string().optional(),
  input: z.unknown().optional(),
  content: z.unknown().optional(),
  source: z.object({ type: z.string(), media_type: z.string().optional() }).optional(),
  query: z.string().optional(),
  search_results: z.array(z.object({ title: z.string().optional(), url: z.string().optional() })).optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  page_content: z.string().optional(),
}).passthrough();
type ContentBlock = z.infer<typeof ContentBlockSchema>;

const ConversationMessageSchema = z.object({
  role: z.string().optional(),
  content: z.union([z.string(), z.array(ContentBlockSchema), z.unknown()]).optional(),
}).passthrough();
type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

const ExportConfigSchema = z.object({
  agent: z.string().optional(),
  model: z.string().optional(),
  instruction: z.string().optional(),
  inputFile: z.string().optional(),
  inputFiles: z.array(z.string()).optional(),
  mediaFile: z.string().nullish(),
  mediaFiles: z.array(z.string()).optional(),
  referenceFile: z.string().nullish(),
  referenceFiles: z.array(z.string()).optional(),
  auxiliaryFile: z.string().nullish(),
  auxiliaryFiles: z.array(z.string()).optional(),
  outputFiles: z.array(z.string()).optional(),
});
type ExportConfig = z.infer<typeof ExportConfigSchema>;

export const ChatExportInputSchema = z.object({
  timestamp: z.string(),
  description: z.string().optional(),
  config: ExportConfigSchema,
  messages: z.array(z.unknown()),
});
export type ChatExportInput = z.infer<typeof ChatExportInputSchema>;

// ============================================================
// Intermediate representation — format-agnostic
// ============================================================

const WebSearchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
});

const UserPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('attachment'), attachmentType: z.enum(['image', 'document']) }),
]);
type UserPart = z.infer<typeof UserPartSchema>;

const ExportNodeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user-message'), parts: z.array(UserPartSchema) }),
  z.object({ kind: z.literal('assistant-text'), text: z.string() }),
  z.object({ kind: z.literal('tool-call'), name: z.string(), input: z.string() }),
  z.object({ kind: z.literal('tool-result'), text: z.string() }),
  z.object({ kind: z.literal('web-search'), query: z.string() }),
  z.object({ kind: z.literal('web-search-results'), results: z.array(WebSearchResultSchema) }),
  z.object({ kind: z.literal('web-fetch'), url: z.string(), title: z.string().optional(), content: z.string().optional() }),
]);
type ExportNode = z.infer<typeof ExportNodeSchema>;

// ============================================================
// Format specification
// ============================================================

/** Compile-time guarantee: every node kind has a renderer. */
type NodeRenderers = {
  [K in ExportNode['kind']]: (node: Extract<ExportNode, { kind: K }>) => string;
};

const DocumentMetaSchema = z.object({
  date: z.string(),
  agent: z.string().optional(),
  model: z.string().optional(),
  description: z.string().optional(),
  instruction: z.string().optional(),
  files: z.array(z.tuple([z.string(), z.string()])),
});
type DocumentMeta = z.infer<typeof DocumentMetaSchema>;

interface FormatSpec {
  header: (meta: DocumentMeta) => string;
  footer: string;
  nodes: NodeRenderers;
}

// ============================================================
// Escape utilities
// ============================================================

function escapeLatex(text: string): string {
  return text
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([#$%&_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

/** Wrap text in lstlisting, handling nested end markers. */
function latexListing(text: string): string {
  const safeText = text.replace(/\\end\{lstlisting\}/g, '\\end {lstlisting}');
  return `\\begin{lstlisting}\n${safeText}\n\\end{lstlisting}`;
}

// ============================================================
// Message normalization (raw messages → ExportNode[])
// ============================================================

function extractBlocks(msg: ConversationMessage): ContentBlock[] {
  if (typeof msg.content === 'string') {
    return [{ type: 'text', text: msg.content }];
  }
  if (Array.isArray(msg.content)) {
    return msg.content as ContentBlock[];
  }
  if (msg.content != null) {
    return [{ type: 'text', text: JSON.stringify(msg.content, null, 2) }];
  }
  return [];
}

function blocksToUserParts(blocks: ContentBlock[]): UserPart[] {
  const parts: UserPart[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && b.text) {
      parts.push({ type: 'text', text: b.text });
    } else if (b.type === 'image') {
      parts.push({ type: 'attachment', attachmentType: 'image' });
    } else if (b.type === 'document') {
      parts.push({ type: 'attachment', attachmentType: 'document' });
    }
  }
  return parts;
}

function extractToolResultText(block: ContentBlock): string | undefined {
  if (block.type === 'tool_result') {
    return typeof block.content === 'string'
      ? block.content
      : JSON.stringify(block.content, null, 2);
  }
  if (block.type === 'text' && block.text) {
    return block.text;
  }
  return undefined;
}

function assistantBlockToNode(block: ContentBlock): ExportNode | null {
  switch (block.type) {
    case 'thinking':
      return null;

    case 'text':
      return block.text?.trim()
        ? { kind: 'assistant-text', text: block.text }
        : null;

    case 'tool_use':
      return {
        kind: 'tool-call',
        name: block.name ?? 'unknown',
        input: JSON.stringify(block.input ?? {}, null, 2),
      };

    case 'server_tool_use':
      if (block.name === 'web_search') {
        const query =
          block.input && typeof block.input === 'object'
            ? (block.input as { query?: string }).query
            : undefined;
        return query ? { kind: 'web-search', query } : null;
      }
      return null;

    case 'web_search_tool_result': {
      if (!Array.isArray(block.content)) return null;
      const results = (block.content as ContentBlock[])
        .filter((e) => e.type === 'web_search_result' && e.url)
        .map((e) => ({ title: e.title ?? e.url!, url: e.url! }));
      return results.length
        ? { kind: 'web-search-results', results }
        : null;
    }

    case 'web_fetch_tool_result':
      return {
        kind: 'web-fetch',
        url: block.url ?? '',
        title: block.title,
        content: block.page_content,
      };

    default:
      return null;
  }
}

function normalizeMessages(messages: unknown[]): ExportNode[] {
  const nodes: ExportNode[] = [];
  let lastAssistantHadToolUse = false;

  for (const raw of messages) {
    const msg = raw as ConversationMessage;
    const role = msg.role ?? 'unknown';
    const blocks = extractBlocks(msg);

    if (role === 'user') {
      if (lastAssistantHadToolUse) {
        for (const block of blocks) {
          const text = extractToolResultText(block);
          if (text) nodes.push({ kind: 'tool-result', text });
        }
        lastAssistantHadToolUse = false;
      } else {
        const parts = blocksToUserParts(blocks);
        if (parts.length) nodes.push({ kind: 'user-message', parts });
      }
      continue;
    }

    if (role === 'assistant') {
      lastAssistantHadToolUse = false;
      for (const block of blocks) {
        const node = assistantBlockToNode(block);
        if (node) {
          if (node.kind === 'tool-call') lastAssistantHadToolUse = true;
          nodes.push(node);
        }
      }
      continue;
    }

    // OpenAI tool role
    if (role === 'tool') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content, null, 2);
      nodes.push({ kind: 'tool-result', text });
    }
  }

  return nodes;
}

// ============================================================
// Shared helpers
// ============================================================

/** Metadata fields rendered in the document header. */
const HEADER_FIELDS: Array<{ key: keyof DocumentMeta; label: string }> = [
  { key: 'date', label: 'Date' },
  { key: 'agent', label: 'Agent' },
  { key: 'model', label: 'Model' },
  { key: 'description', label: 'Summary' },
];

function collectFiles(config: ExportConfig): Array<[string, string]> {
  const files: Array<[string, string]> = [];

  const addFile = (label: string, value: string | null | undefined) => {
    if (value?.trim()) files.push([label, value]);
  };
  const addFiles = (label: string, values: string[] | undefined) => {
    if (values?.length) files.push([label, values.join(', ')]);
  };

  addFile('Input file', config.inputFile);
  addFiles('Input files', config.inputFiles);
  addFile('Media file', config.mediaFile);
  addFiles('Media files', config.mediaFiles);
  addFile('Reference', config.referenceFile);
  addFiles('References', config.referenceFiles);
  addFile('Auxiliary', config.auxiliaryFile);
  addFiles('Auxiliary files', config.auxiliaryFiles);
  addFiles('Output files', config.outputFiles);

  return files;
}

function extractMeta(input: ChatExportInput): DocumentMeta {
  return {
    date: new Date(input.timestamp).toLocaleString(),
    agent: input.config.agent,
    model: input.config.model,
    description: input.description,
    instruction: input.config.instruction?.trim() || undefined,
    files: collectFiles(input.config),
  };
}

/** Render nodes through a format spec's renderer table. */
function renderNode(node: ExportNode, renderers: NodeRenderers): string {
  // TypeScript can't narrow discriminated unions through record access,
  // so we cast here. NodeRenderers ensures every kind has a handler.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (renderers as Record<string, (n: any) => string>)[node.kind](node);
}

function renderDocument(input: ChatExportInput, spec: FormatSpec): string {
  const meta = extractMeta(input);
  const nodes = normalizeMessages(input.messages);
  return [
    spec.header(meta),
    ...nodes.map((n) => renderNode(n, spec.nodes)),
    spec.footer,
  ]
    .filter(Boolean)
    .join('\n');
}

// ============================================================
// Markdown format spec
// ============================================================

function markdownHeader(meta: DocumentMeta): string {
  const fields = HEADER_FIELDS.filter((f) => meta[f.key])
    .map((f) => `**${f.label}:** ${meta[f.key]}  `)
    .join('\n');

  const instruction = meta.instruction
    ? `**Instruction:** ${meta.instruction}\n`
    : '';

  const fileList = meta.files.length
    ? ['**Files:**', ...meta.files.map(([l, v]) => `- ${l}: \`${v}\``), ''].join(
        '\n',
      )
    : '';

  return [fields, '', instruction, fileList, '---', '', '## Conversation', '']
    .filter((line) => line !== undefined)
    .join('\n');
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
      .filter((l): l is string => l !== undefined)
      .join('\n'),
};

const markdownSpec: FormatSpec = {
  header: (meta) => `# TeXRA Chat Export\n\n${markdownHeader(meta)}`,
  footer: '',
  nodes: MD_NODES,
};

// ============================================================
// LaTeX format spec
// ============================================================

const LATEX_PREAMBLE = `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[most]{tcolorbox}
\\usepackage{listings}
\\usepackage{hyperref}
\\usepackage{geometry}
\\usepackage{xcolor}
\\geometry{margin=2.5cm}

\\lstset{
  basicstyle=\\ttfamily\\small,
  breaklines=true,
  breakatwhitespace=false,
  columns=fullflexible,
  keepspaces=true,
  frame=none,
  aboveskip=0pt,
  belowskip=0pt,
}

% ── Chat message environments ──
\\newtcolorbox{usermessage}{
  colback=blue!5, colframe=blue!40, title={\\textbf{User}},
  breakable, before skip=8pt, after skip=8pt
}

\\newtcolorbox{assistantmessage}{
  colback=green!5, colframe=green!40, title={\\textbf{Assistant}},
  breakable, before skip=8pt, after skip=8pt
}

\\newtcolorbox{toolcallbox}[1]{
  colback=orange!5, colframe=orange!40, title={\\textbf{Tool: \\texttt{#1}}},
  breakable, before skip=8pt, after skip=8pt
}

\\newtcolorbox{toolresultbox}{
  colback=yellow!5, colframe=yellow!30, title={\\textbf{Tool Result}},
  breakable, before skip=8pt, after skip=8pt, fontupper=\\small
}

\\newtcolorbox{websearchbox}{
  colback=violet!5, colframe=violet!30, title={\\textbf{Web Search}},
  breakable, before skip=8pt, after skip=8pt
}`;

function latexHeader(meta: DocumentMeta): string {
  const esc = escapeLatex;

  const rows = HEADER_FIELDS.filter(
    (f) => f.key === 'date' || meta[f.key],
  ).map(
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
    LATEX_PREAMBLE,
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
      .map((r) => `  \\item \\href{${r.url}}{${escapeLatex(r.title)}}`)
      .join('\n');
    return `\\begin{websearchbox}\n\\begin{itemize}\n${items}\n\\end{itemize}\n\\end{websearchbox}\n`;
  },

  'web-fetch': ({ url, title, content }) =>
    [
      '\\begin{websearchbox}',
      url ? `\\textbf{URL:} \\url{${url}}` : undefined,
      title ? `\\\\\\textbf{Title:} ${escapeLatex(title)}` : undefined,
      content ? `\n${latexListing(content)}` : undefined,
      '\\end{websearchbox}',
      '',
    ]
      .filter((l): l is string => l !== undefined)
      .join('\n'),
};

const latexSpec: FormatSpec = {
  header: latexHeader,
  footer: '\\end{document}',
  nodes: TEX_NODES,
};

// ============================================================
// Public API
// ============================================================

export function formatChatAsMarkdown(input: ChatExportInput): string {
  return renderDocument(input, markdownSpec);
}

export function formatChatAsLatex(input: ChatExportInput): string {
  return renderDocument(input, latexSpec);
}

// ============================================================
// Filename generation
// ============================================================

/**
 * Generate a descriptive filename for the export.
 * Example: `texra-chat-2026-03-05-research-claude-sonnet.md`
 */
export function generateExportFilename(
  input: ChatExportInput,
  extension: 'md' | 'tex',
): string {
  const date = new Date(input.timestamp);
  const datePart = date.toISOString().slice(0, 10);

  const parts = ['texra-chat', datePart];

  if (input.config.agent) {
    parts.push(sanitizeFilename(input.config.agent));
  }
  if (input.config.model) {
    const shortModel = input.config.model
      .replace(/[-_]\d+[-_]\d+.*$/, '')
      .replace(/[-_]\d{8}$/, '');
    parts.push(sanitizeFilename(shortModel));
  }

  return `${parts.join('-')}.${extension}`;
}

function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
