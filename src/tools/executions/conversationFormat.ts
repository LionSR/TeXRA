/**
 * Pure formatters for rendering a stored execution conversation as text.
 * Used by ExecutionsTool's /conversation endpoint; kept free of I/O so the
 * tool class stays focused on path routing and storage access.
 */

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? `${str.slice(0, maxLen - 3)}...` : str;
}

/**
 * The recognized content-block shapes within a stored conversation. Stored
 * blocks are untrusted JSON, so each variant only declares the fields this
 * formatter reads; unknown shapes fall through to the JSON default.
 */
type ConversationBlock =
  | { type: 'text'; text?: unknown }
  | { type: 'tool_use'; name?: unknown; input?: unknown }
  | { type: 'tool_result'; content?: unknown };

/** Narrows an arbitrary stored block to a recognized variant by its `type` tag. */
function asConversationBlock(block: unknown): ConversationBlock | undefined {
  if (typeof block !== 'object' || block === null) return undefined;
  const type = (block as { type?: unknown }).type;
  if (type === 'text' || type === 'tool_use' || type === 'tool_result') {
    return block as ConversationBlock;
  }
  return undefined;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function formatBlock(block: unknown): string {
  if (typeof block === 'string') {
    return block;
  }
  const typed = asConversationBlock(block);
  switch (typed?.type) {
    case 'text':
      return asText(typed.text);
    case 'tool_use':
      return `[tool_use: ${asText(typed.name)}(${truncate(JSON.stringify(typed.input ?? {}), 100)})]`;
    case 'tool_result': {
      const output =
        typeof typed.content === 'string'
          ? typed.content
          : (JSON.stringify(typed.content) ?? '');
      return `[tool_result: ${truncate(output, 100)}]`;
    }
    default:
      // `JSON.stringify` returns undefined for undefined/symbol/function
      // blocks; fall back to '' so truncate never sees a non-string (matches
      // the tool_result and message-content paths above).
      return truncate(JSON.stringify(block) ?? '', 100);
  }
}

interface ConversationMessage {
  role?: unknown;
  content?: unknown;
}

function formatMessageContent(content: unknown): string {
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
    const m = (msg ?? {}) as ConversationMessage;
    // Coerce a missing, non-string, or empty role to "unknown": stored roles
    // are untrusted, and an empty label would render a meaningless role="".
    const role = asText(m.role) || 'unknown';
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
