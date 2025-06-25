// Standard library imports
import { randomUUID } from 'crypto';

// Local imports
import { emitProgress } from '@eventBus/ProgressEventBus';
import { AgentLogger } from '@logger/AgentLogger';
import { escapeHtml } from '@logger/logUtils';

/**
 * Create a span element for special log content.
 * @param content - The text to wrap.
 * @param type - The message type value.
 */
export function createInfoSpan(
  content: string,
  type: 'thinking' | 'scratchpad',
): string {
  if (!content || typeof content !== 'string') {
    throw new Error('Content must be a non-empty string');
  }
  if (type !== 'thinking' && type !== 'scratchpad') {
    throw new Error('Type must be either "thinking" or "scratchpad"');
  }

  const safeContent = escapeHtml(content);
  return `<span class="message-info" data-message-type="${type}">${safeContent}</span>`;
}

const THINKING_TEMPLATE = (content: string) =>
  createInfoSpan(content, 'thinking');

export async function streamReasoningToProgressView<T>(
  stream: AsyncIterable<T>,
  extract: (chunk: T) => string,
  logger: AgentLogger,
  streamId: string,
  groupId?: string,
): Promise<string> {
  const id = randomUUID();
  let content = '';

  emitProgress('addLogMessage', {
    stream: streamId,
    message: THINKING_TEMPLATE(content),
    level: 'info',
    groupId,
    timestamp: Date.now(),
    messageType: 'thinking',
    id,
  });

  for await (const chunk of stream) {
    content += extract(chunk);
    emitProgress('updateLogMessage', {
      stream: streamId,
      id,
      message: THINKING_TEMPLATE(content),
      messageType: 'thinking',
    });
  }

  logger.debug(`Final reasoning length: ${content.length}`, groupId);
  return content;
}
