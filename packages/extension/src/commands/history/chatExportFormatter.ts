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
import {
  isAssistantMessage,
  isToolMessage,
} from 'openai/lib/chatCompletionUtils';
import { assertToolCallsAreChatCompletionFunctionToolCalls } from 'openai/lib/parser';
import latexPreamble from '@resources/templates/chatExport.tex';
import type { Part } from '@google/genai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import type {
  ResponseFunctionToolCallItem,
  ResponseInputItem,
} from 'openai/resources/responses/responses';

// ============================================================
// Input schemas (single source of truth)
// ============================================================

/** Loose schema for API content blocks — accepts many optional fields.
 *  Covers Anthropic, OpenAI Chat Completions, and OpenAI Response API formats. */
const ContentBlockSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  thinking: z.string().optional(),
  name: z.string().optional(),
  id: z.string().optional(),
  input: z.unknown().optional(),
  content: z.unknown().optional(),
  source: z
    .looseObject({ type: z.string(), media_type: z.string().optional() })
    .optional(),
  query: z.string().optional(),
  search_results: z
    .array(
      z.looseObject({
        title: z.string().optional(),
        url: z.string().optional(),
      }),
    )
    .optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  page_content: z.string().optional(),
  // OpenAI Response API fields
  arguments: z.string().optional(),
  output: z.string().optional(),
});
type ContentBlock = z.infer<typeof ContentBlockSchema>;

const ConversationMessageSchema = z.looseObject({
  role: z.string().optional(),
  content: z
    .union([z.string(), z.array(ContentBlockSchema), z.unknown()])
    .optional(),
  // Google GenAI uses `parts` instead of `content`
  parts: z.array(z.unknown()).optional(),
  // OpenAI Chat Completions: tool_calls on assistant messages
  tool_calls: z.array(z.unknown()).optional(),
});
type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

const ExportConfigSchema = z.object({
  agent: z.string().optional(),
  model: z.string().optional(),
  instruction: z.string().optional(),
  inputFiles: z.array(z.string()).optional(),
  mediaFiles: z.array(z.string()).optional(),
  contextFiles: z.array(z.string()).optional(),
  outputFiles: z.array(z.string()).optional(),
});
type ExportConfig = z.infer<typeof ExportConfigSchema>;

const ChatExportInputSchema = z.object({
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
  z.object({
    type: z.literal('attachment'),
    attachmentType: z.enum(['image', 'document']),
  }),
]);
type UserPart = z.infer<typeof UserPartSchema>;

export const ExportNodeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user-message'), parts: z.array(UserPartSchema) }),
  z.object({ kind: z.literal('assistant-text'), text: z.string() }),
  z.object({
    kind: z.literal('tool-call'),
    name: z.string(),
    input: z.string(),
  }),
  z.object({ kind: z.literal('tool-result'), text: z.string() }),
  z.object({ kind: z.literal('web-search'), query: z.string() }),
  z.object({
    kind: z.literal('web-search-results'),
    results: z.array(WebSearchResultSchema),
  }),
  z.object({
    kind: z.literal('web-fetch'),
    url: z.string().optional(),
    title: z.string().optional(),
    content: z.string().optional(),
  }),
]);
export type ExportNode = z.infer<typeof ExportNodeSchema>;

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
export type DocumentMeta = z.infer<typeof DocumentMetaSchema>;

export interface FormatSpec {
  header: (meta: DocumentMeta) => string;
  footer: string;
  nodes: NodeRenderers;
}

// ============================================================
// Escape utilities
// ============================================================

/**
 * Single-pass LaTeX text escaping (pandoc/pylatex pattern).
 * A character-level replacement map avoids ordering bugs —
 * every special character is handled exactly once.
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

const LATEX_ESCAPE_RE = /[\\#$%&_{}\~\^]/g;

function escapeLatex(text: string): string {
  return text.replaceAll(LATEX_ESCAPE_RE, (ch) => LATEX_ESCAPE_MAP[ch]);
}

/** Escape special characters in URLs for \\href and \\url commands. */
const LATEX_URL_ESCAPE_RE = /[%#]/g;
const LATEX_URL_ESCAPE_MAP: Record<string, string> = { '%': '\\%', '#': '\\#' };

function escapeLatexUrl(url: string): string {
  return url.replaceAll(LATEX_URL_ESCAPE_RE, (ch) => LATEX_URL_ESCAPE_MAP[ch]);
}

/** Wrap text in lstlisting, handling nested end markers. */
function latexListing(text: string): string {
  const safeText = text.replaceAll('\\end{lstlisting}', '\\end {lstlisting}');
  return `\\begin{lstlisting}\n${safeText}\n\\end{lstlisting}`;
}

// ============================================================
// Message normalization (raw messages → ExportNode[])
// ============================================================

function extractBlocks(msg: ConversationMessage): ContentBlock[] {
  // Google GenAI: field-based Parts → type-based ContentBlocks
  if (Array.isArray(msg.parts)) {
    return (msg.parts as Part[]).flatMap(googlePartToBlocks);
  }

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

/** Convert a Google GenAI Part (field-based discrimination) to type-based ContentBlock(s). */
function googlePartToBlocks(part: Part): ContentBlock[] {
  // Google GenAI: thought is a boolean flag; the actual text is in part.text.
  // Must check before the plain text branch to avoid exposing thinking as assistant text.
  if (part.thought === true && typeof part.text === 'string') {
    return [{ type: 'thinking', thinking: part.text }];
  }
  if (typeof part.text === 'string') {
    return [{ type: 'text', text: part.text }];
  }
  if (part.functionCall && typeof part.functionCall === 'object') {
    const fc = part.functionCall;
    return [
      {
        type: 'tool_use',
        name: fc.name ?? 'unknown',
        input: fc.args ?? {},
      },
    ];
  }
  if (part.functionResponse && typeof part.functionResponse === 'object') {
    const fr = part.functionResponse;
    return [
      {
        type: 'tool_result',
        content:
          typeof fr.response === 'string'
            ? fr.response
            : JSON.stringify(fr.response ?? '', null, 2),
      },
    ];
  }
  if (part.inlineData && typeof part.inlineData === 'object') {
    const data = part.inlineData as { mimeType?: string };
    return [
      { type: data.mimeType?.startsWith('image/') ? 'image' : 'document' },
    ];
  }
  // Google GenAI: URI-based file data (uploaded files over the inline threshold)
  if (part.fileData && typeof part.fileData === 'object') {
    const data = part.fileData as { mimeType?: string };
    return [
      { type: data.mimeType?.startsWith('image/') ? 'image' : 'document' },
    ];
  }
  return [];
}

function blocksToUserParts(blocks: ContentBlock[]): UserPart[] {
  const parts: UserPart[] = [];
  for (const b of blocks) {
    // Anthropic: 'text', OpenAI Response API: 'input_text'
    if ((b.type === 'text' || b.type === 'input_text') && b.text) {
      parts.push({ type: 'text', text: b.text });
    } else if (
      b.type === 'image' ||
      b.type === 'input_image' ||
      b.type === 'image_url'
    ) {
      parts.push({ type: 'attachment', attachmentType: 'image' });
    } else if (
      b.type === 'document' ||
      b.type === 'input_file' ||
      b.type === 'file'
    ) {
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
  // Anthropic: 'text', OpenAI Response API: 'input_text'
  if ((block.type === 'text' || block.type === 'input_text') && block.text) {
    return block.text;
  }
  return undefined;
}

function assistantBlockToNode(block: ContentBlock): ExportNode | null {
  switch (block.type) {
    case 'thinking':
    case 'redacted_thinking':
      return null;

    // Anthropic: 'text', OpenAI Response API: 'output_text'
    case 'text':
    case 'output_text':
      return block.text?.trim()
        ? { kind: 'assistant-text', text: block.text }
        : null;

    case 'tool_use':
      return {
        kind: 'tool-call',
        name: block.name ?? 'unknown',
        input: JSON.stringify(block.input ?? {}, null, 2),
      };

    // Tool result blocks: Anthropic tool_result + server-side code execution results
    case 'tool_result':
    case 'code_execution_tool_result':
    case 'bash_code_execution_tool_result':
    case 'text_editor_code_execution_tool_result':
      return {
        kind: 'tool-result',
        text:
          typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content ?? '', null, 2),
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
      return results.length ? { kind: 'web-search-results', results } : null;
    }

    case 'web_fetch_tool_result':
      return {
        kind: 'web-fetch',
        url: block.url,
        title: block.title,
        content: block.page_content,
      };

    default:
      return null;
  }
}

export function normalizeMessages(messages: unknown[]): ExportNode[] {
  const nodes: ExportNode[] = [];
  let lastAssistantHadToolUse = false;

  for (const raw of messages) {
    const item = raw as Record<string, unknown>;

    // OpenAI Response API: top-level function_call items (not wrapped in a message)
    if (isResponseFunctionCallItem(item)) {
      const args =
        typeof item.arguments === 'string'
          ? item.arguments
          : JSON.stringify(item.arguments ?? {}, null, 2);
      const name = item.name ?? 'unknown';
      nodes.push({ kind: 'tool-call', name, input: args });
      lastAssistantHadToolUse = true;
      continue;
    }

    // OpenAI Response API: top-level function_call_output items.
    // output can be a string OR an array of input_text/input_file/input_image parts.
    if (isResponseFunctionCallOutputItem(item)) {
      const output = item.output;
      if (Array.isArray(output)) {
        const textParts: string[] = [];
        for (const part of output) {
          if (part.type === 'input_text' && typeof part.text === 'string') {
            textParts.push(part.text);
          } else if (part.type === 'input_image') {
            textParts.push('[image attachment]');
          } else if (part.type === 'input_file') {
            textParts.push('[file attachment]');
          }
        }
        if (textParts.length) {
          nodes.push({ kind: 'tool-result', text: textParts.join('\n') });
        }
      } else {
        const outputText =
          typeof output === 'string'
            ? output
            : JSON.stringify(output ?? '', null, 2);
        nodes.push({ kind: 'tool-result', text: outputText });
      }
      lastAssistantHadToolUse = false;
      continue;
    }

    const msg = item as ConversationMessage;
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

    // Google GenAI uses 'model' role instead of 'assistant'
    if (role === 'assistant' || role === 'model') {
      lastAssistantHadToolUse = false;
      for (const block of blocks) {
        const node = assistantBlockToNode(block);
        if (node) {
          if (node.kind === 'tool-call') lastAssistantHadToolUse = true;
          nodes.push(node);
        }
      }

      // OpenAI Chat Completions: tool_calls array on assistant messages
      for (const tc of getAssistantToolCalls(item)) {
        const fn = tc.function;
        if (fn?.name) {
          nodes.push({
            kind: 'tool-call',
            name: fn.name,
            input: fn.arguments ?? '{}',
          });
          lastAssistantHadToolUse = true;
        }
      }
      continue;
    }

    // OpenAI Chat Completions tool role
    const openaiMsg = toChatCompletionMessageParam(item);
    if (role === 'tool' || isToolMessage(openaiMsg)) {
      const text =
        typeof openaiMsg.content === 'string'
          ? openaiMsg.content
          : JSON.stringify(openaiMsg.content, null, 2);
      nodes.push({ kind: 'tool-result', text });
      lastAssistantHadToolUse = false;
    }
  }

  return nodes;
}

function isResponseFunctionCallItem(
  item: unknown,
): item is ResponseFunctionToolCallItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    item.type === 'function_call'
  );
}

function isResponseFunctionCallOutputItem(
  item: unknown,
): item is ResponseInputItem.FunctionCallOutput {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    item.type === 'function_call_output'
  );
}

function toChatCompletionMessageParam(
  item: unknown,
): ChatCompletionMessageParam {
  return item as ChatCompletionMessageParam;
}

function getAssistantToolCalls(
  item: unknown,
): ChatCompletionMessageFunctionToolCall[] {
  const message = toChatCompletionMessageParam(item);
  if (!isAssistantMessage(message) || !Array.isArray(message.tool_calls)) {
    return [];
  }

  try {
    const candidate = message.tool_calls as ChatCompletionMessageToolCall[];
    assertToolCallsAreChatCompletionFunctionToolCalls(candidate);
    return candidate;
  } catch {
    const functionToolCalls: ChatCompletionMessageFunctionToolCall[] = [];
    for (const toolCall of message.tool_calls) {
      const candidate: ChatCompletionMessageToolCall[] = [toolCall];
      try {
        assertToolCallsAreChatCompletionFunctionToolCalls(candidate);
        functionToolCalls.push(candidate[0]);
      } catch {
        // Skip non-function or malformed entries while preserving valid calls.
      }
    }
    return functionToolCalls;
  }
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

  const addFiles = (label: string, values: string[] | undefined) => {
    if (values?.length) files.push([label, values.join(', ')]);
  };

  addFiles('Input files', config.inputFiles);
  addFiles('Media files', config.mediaFiles);
  addFiles('Context files', config.contextFiles);
  addFiles('Output files', config.outputFiles);

  return files;
}

export function extractMeta(input: ChatExportInput): DocumentMeta {
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
  extension: 'md' | 'tex' | 'html',
): string {
  return `${generateExportStem(input)}.${extension}`;
}

/**
 * Shared filename stem (no extension) used by both single-file exports
 * (md/tex) and the HTML export's containing folder.
 */
export function generateExportFolderName(input: ChatExportInput): string {
  return generateExportStem(input);
}

function generateExportStem(input: ChatExportInput): string {
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

  return parts.join('-');
}

export function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-|-$/g, '');
}
