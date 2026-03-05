/**
 * Pure-data formatters for exporting tool-use chat conversations
 * as Markdown or LaTeX documents.
 *
 * This module is VS Code-free — all platform wiring lives in the caller.
 */

// ============================================================
// Types for the raw conversation messages
// ============================================================

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
  content?: unknown;
  source?: { type: string; media_type?: string };
  // Web search / fetch
  query?: string;
  search_results?: Array<{ title?: string; url?: string }>;
  url?: string;
  title?: string;
  page_content?: string;
}

interface ConversationMessage {
  role?: string;
  content?: string | ContentBlock[] | unknown;
}

interface ExportConfig {
  agent?: string;
  model?: string;
  instruction?: string;
  inputFile?: string;
  inputFiles?: string[];
  mediaFile?: string | null;
  mediaFiles?: string[];
  referenceFile?: string | null;
  referenceFiles?: string[];
  auxiliaryFile?: string | null;
  auxiliaryFiles?: string[];
  outputFiles?: string[];
}

export interface ChatExportInput {
  timestamp: string;
  description?: string;
  config: ExportConfig;
  messages: unknown[];
}

// ============================================================
// LaTeX escaping
// ============================================================

function escapeLatex(text: string): string {
  return text
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([#$%&_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

/**
 * Wrap text in a lstlisting environment for verbatim code display.
 * Handles cases where the text itself contains \end{lstlisting}.
 */
function latexListing(text: string): string {
  // If content contains the lstlisting end marker, escape it
  const safeText = text.replace(/\\end\{lstlisting\}/g, '\\end {lstlisting}');
  return `\\begin{lstlisting}\n${safeText}\n\\end{lstlisting}`;
}

// ============================================================
// Block extraction helpers
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

// ============================================================
// File list formatting
// ============================================================

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

// ============================================================
// Markdown formatter
// ============================================================

export function formatChatAsMarkdown(input: ChatExportInput): string {
  const { timestamp, description, config, messages } = input;
  const date = new Date(timestamp).toLocaleString();
  const lines: string[] = [];

  // Header
  lines.push('# TeXRA Chat Export');
  lines.push('');
  lines.push(`**Date:** ${date}  `);
  if (config.agent) lines.push(`**Agent:** ${config.agent}  `);
  if (config.model) lines.push(`**Model:** ${config.model}  `);
  if (description) lines.push(`**Summary:** ${description}  `);
  lines.push('');

  // Instruction
  if (config.instruction?.trim()) {
    lines.push(`**Instruction:** ${config.instruction}`);
    lines.push('');
  }

  // Files
  const files = collectFiles(config);
  if (files.length) {
    lines.push('**Files:**');
    for (const [label, value] of files) {
      lines.push(`- ${label}: \`${value}\``);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## Conversation');
  lines.push('');

  // Messages
  let lastAssistantHadToolUse = false;

  for (const raw of messages) {
    const msg = raw as ConversationMessage;
    const role = msg.role ?? 'unknown';
    const blocks = extractBlocks(msg);

    if (role === 'user') {
      if (lastAssistantHadToolUse) {
        // This is a tool result message
        for (const block of blocks) {
          if (block.type === 'tool_result') {
            const resultText =
              typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content, null, 2);
            lines.push('#### Tool Result');
            lines.push('');
            lines.push('```');
            lines.push(resultText);
            lines.push('```');
            lines.push('');
          } else if (block.type === 'text' && block.text) {
            lines.push('#### Tool Result');
            lines.push('');
            lines.push('```');
            lines.push(block.text);
            lines.push('```');
            lines.push('');
          }
        }
        lastAssistantHadToolUse = false;
      } else {
        // Regular user message
        lines.push('### User');
        lines.push('');
        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            lines.push(block.text);
            lines.push('');
          } else if (block.type === 'image') {
            lines.push('*[Image attachment]*');
            lines.push('');
          } else if (block.type === 'document') {
            lines.push('*[Document attachment]*');
            lines.push('');
          }
        }
      }
      continue;
    }

    if (role === 'assistant') {
      lastAssistantHadToolUse = false;

      for (const block of blocks) {
        if (block.type === 'thinking') {
          // Skip thinking blocks per design decision
          continue;
        }

        if (block.type === 'text' && block.text?.trim()) {
          lines.push('### Assistant');
          lines.push('');
          lines.push(block.text);
          lines.push('');
        }

        if (block.type === 'tool_use') {
          lastAssistantHadToolUse = true;
          lines.push(`#### Tool: \`${block.name}\``);
          lines.push('');
          lines.push('```json');
          lines.push(JSON.stringify(block.input ?? {}, null, 2));
          lines.push('```');
          lines.push('');
        }

        if (
          block.type === 'server_tool_use' &&
          block.name === 'web_search'
        ) {
          lines.push('#### Web Search');
          lines.push('');
          if (block.input && typeof block.input === 'object') {
            const query = (block.input as { query?: string }).query;
            if (query) lines.push(`**Query:** ${query}`);
          }
          lines.push('');
        }

        if (block.type === 'web_search_tool_result') {
          if (block.content && Array.isArray(block.content)) {
            for (const entry of block.content as ContentBlock[]) {
              if (entry.type === 'web_search_result' && entry.url) {
                lines.push(
                  `- [${entry.title ?? entry.url}](${entry.url})`,
                );
              }
            }
            lines.push('');
          }
        }

        if (block.type === 'web_fetch_tool_result') {
          lines.push('#### Web Fetch');
          lines.push('');
          if (block.url) lines.push(`**URL:** ${block.url}`);
          if (block.title) lines.push(`**Title:** ${block.title}`);
          if (block.page_content) {
            lines.push('');
            lines.push('```');
            lines.push(block.page_content);
            lines.push('```');
          }
          lines.push('');
        }
      }
      continue;
    }

    // Other roles (e.g., 'tool' for OpenAI format)
    if (role === 'tool') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content, null, 2);
      lines.push('#### Tool Result');
      lines.push('');
      lines.push('```');
      lines.push(text);
      lines.push('```');
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ============================================================
// LaTeX formatter
// ============================================================

export function formatChatAsLatex(input: ChatExportInput): string {
  const { timestamp, description, config, messages } = input;
  const date = new Date(timestamp).toLocaleString();
  const lines: string[] = [];

  // Preamble
  lines.push('\\documentclass[11pt,a4paper]{article}');
  lines.push('\\usepackage[utf8]{inputenc}');
  lines.push('\\usepackage[T1]{fontenc}');
  lines.push('\\usepackage[most]{tcolorbox}');
  lines.push('\\usepackage{listings}');
  lines.push('\\usepackage{hyperref}');
  lines.push('\\usepackage{geometry}');
  lines.push('\\usepackage{xcolor}');
  lines.push('\\geometry{margin=2.5cm}');
  lines.push('');

  // Listings setup
  lines.push('\\lstset{');
  lines.push('  basicstyle=\\ttfamily\\small,');
  lines.push('  breaklines=true,');
  lines.push('  breakatwhitespace=false,');
  lines.push('  columns=fullflexible,');
  lines.push('  keepspaces=true,');
  lines.push('  frame=none,');
  lines.push('  aboveskip=0pt,');
  lines.push('  belowskip=0pt,');
  lines.push('}');
  lines.push('');

  // tcolorbox environment definitions
  lines.push('% ── Chat message environments ──');
  lines.push('\\newtcolorbox{usermessage}{');
  lines.push(
    '  colback=blue!5, colframe=blue!40, title={\\textbf{User}},',
  );
  lines.push('  breakable, before skip=8pt, after skip=8pt');
  lines.push('}');
  lines.push('');
  lines.push('\\newtcolorbox{assistantmessage}{');
  lines.push(
    '  colback=green!5, colframe=green!40, title={\\textbf{Assistant}},',
  );
  lines.push('  breakable, before skip=8pt, after skip=8pt');
  lines.push('}');
  lines.push('');
  lines.push('\\newtcolorbox{toolcallbox}[1]{');
  lines.push(
    '  colback=orange!5, colframe=orange!40, title={\\textbf{Tool: \\texttt{#1}}},',
  );
  lines.push('  breakable, before skip=8pt, after skip=8pt');
  lines.push('}');
  lines.push('');
  lines.push('\\newtcolorbox{toolresultbox}{');
  lines.push(
    '  colback=yellow!5, colframe=yellow!30, title={\\textbf{Tool Result}},',
  );
  lines.push(
    '  breakable, before skip=8pt, after skip=8pt, fontupper=\\small',
  );
  lines.push('}');
  lines.push('');
  lines.push('\\newtcolorbox{websearchbox}{');
  lines.push(
    '  colback=violet!5, colframe=violet!30, title={\\textbf{Web Search}},',
  );
  lines.push('  breakable, before skip=8pt, after skip=8pt');
  lines.push('}');
  lines.push('');

  // Title
  const safeAgent = escapeLatex(config.agent ?? 'Unknown');
  const safeModel = escapeLatex(config.model ?? 'Unknown');
  lines.push('\\begin{document}');
  lines.push('');
  lines.push('\\section*{TeXRA Chat Export}');
  lines.push('');
  lines.push('\\begin{tabular}{@{}ll}');
  lines.push(`\\textbf{Date:}  & ${escapeLatex(date)} \\\\`);
  lines.push(`\\textbf{Agent:} & ${safeAgent} \\\\`);
  lines.push(`\\textbf{Model:} & ${safeModel} \\\\`);
  if (description) {
    lines.push(
      `\\textbf{Summary:} & ${escapeLatex(description)} \\\\`,
    );
  }
  lines.push('\\end{tabular}');
  lines.push('');

  // Instruction
  if (config.instruction?.trim()) {
    lines.push(
      `\\medskip\\noindent\\textbf{Instruction:} ${escapeLatex(config.instruction)}`,
    );
    lines.push('');
  }

  // Files
  const files = collectFiles(config);
  if (files.length) {
    lines.push('\\medskip\\noindent\\textbf{Files:}');
    lines.push('\\begin{itemize}');
    for (const [label, value] of files) {
      lines.push(
        `  \\item ${escapeLatex(label)}: \\texttt{${escapeLatex(value)}}`,
      );
    }
    lines.push('\\end{itemize}');
    lines.push('');
  }

  lines.push('\\bigskip\\hrule\\bigskip');
  lines.push('');

  // Messages
  let lastAssistantHadToolUse = false;

  for (const raw of messages) {
    const msg = raw as ConversationMessage;
    const role = msg.role ?? 'unknown';
    const blocks = extractBlocks(msg);

    if (role === 'user') {
      if (lastAssistantHadToolUse) {
        // Tool result message
        for (const block of blocks) {
          const resultText =
            block.type === 'tool_result'
              ? typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content, null, 2)
              : block.type === 'text'
                ? block.text ?? ''
                : '';

          if (resultText) {
            lines.push('\\begin{toolresultbox}');
            lines.push(latexListing(resultText));
            lines.push('\\end{toolresultbox}');
            lines.push('');
          }
        }
        lastAssistantHadToolUse = false;
      } else {
        // Regular user message
        const textParts: string[] = [];
        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            textParts.push(escapeLatex(block.text));
          } else if (block.type === 'image') {
            textParts.push('\\textit{[Image attachment]}');
          } else if (block.type === 'document') {
            textParts.push('\\textit{[Document attachment]}');
          }
        }
        if (textParts.length) {
          lines.push('\\begin{usermessage}');
          lines.push(textParts.join('\n\n'));
          lines.push('\\end{usermessage}');
          lines.push('');
        }
      }
      continue;
    }

    if (role === 'assistant') {
      lastAssistantHadToolUse = false;

      for (const block of blocks) {
        if (block.type === 'thinking') {
          continue;
        }

        if (block.type === 'text' && block.text?.trim()) {
          lines.push('\\begin{assistantmessage}');
          lines.push(escapeLatex(block.text));
          lines.push('\\end{assistantmessage}');
          lines.push('');
        }

        if (block.type === 'tool_use') {
          lastAssistantHadToolUse = true;
          const safeName = escapeLatex(block.name ?? 'unknown');
          lines.push(`\\begin{toolcallbox}{${safeName}}`);
          lines.push(
            latexListing(JSON.stringify(block.input ?? {}, null, 2)),
          );
          lines.push('\\end{toolcallbox}');
          lines.push('');
        }

        if (
          block.type === 'server_tool_use' &&
          block.name === 'web_search'
        ) {
          const query =
            block.input && typeof block.input === 'object'
              ? (block.input as { query?: string }).query
              : undefined;
          lines.push('\\begin{websearchbox}');
          if (query) {
            lines.push(`\\textbf{Query:} ${escapeLatex(query)}`);
          }
          lines.push('\\end{websearchbox}');
          lines.push('');
        }

        if (block.type === 'web_search_tool_result') {
          if (block.content && Array.isArray(block.content)) {
            lines.push('\\begin{websearchbox}');
            lines.push('\\begin{itemize}');
            for (const entry of block.content as ContentBlock[]) {
              if (entry.type === 'web_search_result' && entry.url) {
                const title = escapeLatex(entry.title ?? entry.url);
                lines.push(
                  `  \\item \\href{${entry.url}}{${title}}`,
                );
              }
            }
            lines.push('\\end{itemize}');
            lines.push('\\end{websearchbox}');
            lines.push('');
          }
        }

        if (block.type === 'web_fetch_tool_result') {
          lines.push('\\begin{websearchbox}');
          if (block.url) {
            lines.push(
              `\\textbf{URL:} \\url{${block.url}}`,
            );
          }
          if (block.title) {
            lines.push(
              `\\\\\\textbf{Title:} ${escapeLatex(block.title)}`,
            );
          }
          if (block.page_content) {
            lines.push('');
            lines.push(latexListing(block.page_content));
          }
          lines.push('\\end{websearchbox}');
          lines.push('');
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
      lines.push('\\begin{toolresultbox}');
      lines.push(latexListing(text));
      lines.push('\\end{toolresultbox}');
      lines.push('');
    }
  }

  lines.push('\\end{document}');
  return lines.join('\n');
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
  const datePart = date.toISOString().slice(0, 10); // YYYY-MM-DD

  const parts = ['texra-chat', datePart];

  if (input.config.agent) {
    parts.push(sanitizeFilename(input.config.agent));
  }
  if (input.config.model) {
    // Shorten model name: "claude-sonnet-4-6" → "claude-sonnet"
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
