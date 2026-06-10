/**
 * Pure formatters for rendering a stored execution conversation as text.
 * Used by ExecutionsTool's /conversation endpoint; kept free of I/O so the
 * tool class stays focused on path routing and storage access.
 */

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 3) + '...' : str;
}

function formatBlock(block: unknown): string {
  if (typeof block === 'string') {
    return block;
  }
  const b = block as Record<string, unknown>;
  switch (b?.type) {
    case 'text':
      return (b.text as string) ?? '';
    case 'tool_use':
      return `[tool_use: ${b.name}(${truncate(JSON.stringify(b.input ?? {}), 100)})]`;
    case 'tool_result': {
      const output =
        typeof b.content === 'string'
          ? b.content
          : (JSON.stringify(b.content) ?? '');
      return `[tool_result: ${truncate(output, 100)}]`;
    }
    default:
      return truncate(JSON.stringify(block), 100);
  }
}

export function formatMessageContent(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') {
    return truncate(content, 500);
  }
  if (Array.isArray(content)) {
    return content.map((block) => formatBlock(block)).join('\n');
  }
  return truncate(JSON.stringify(content) ?? '', 500);
}

/** Render a stored conversation as numbered <message> blocks. */
export function formatConversation(conversation: readonly unknown[]): string {
  const messages = conversation.map((msg, i) => {
    const m = msg as { role?: string; content?: unknown };
    const role = m.role ?? 'unknown';
    const content = formatMessageContent(m.content);
    return `<message index="${i + 1}" role="${role}">\n${content}\n</message>`;
  });

  return `Conversation (${conversation.length} messages):\n\n${messages.join('\n\n')}`;
}

/** Slice multi-line output to a 1-based inclusive [start, end] range. */
export function applyViewRange(output: string, viewRange?: number[]): string {
  if (!viewRange || viewRange.length < 2) return output;
  const lines = output.split('\n');
  const [start, end] = viewRange;
  return lines
    .slice(Math.max(start - 1, 0), Math.min(end, lines.length))
    .join('\n');
}
