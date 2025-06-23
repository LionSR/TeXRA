import { randomUUID } from 'crypto';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
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
  const safeContent = escapeHtml(content);
  return `<span class="message-info" data-message-type="${type}">${safeContent}</span>`;
}

const THINKING_TEMPLATE = (content: string) =>
  createInfoSpan(content, 'thinking');

export async function streamReasoningToProgressView<T>(
  stream: AsyncIterable<T>,
  extract: (chunk: T) => string,
  provider: ProgressViewProvider,
  logger: AgentLogger,
  streamId: string,
  groupId?: string,
): Promise<string> {
  const id = randomUUID();
  let content = '';

  provider.addLogMessage(
    streamId,
    THINKING_TEMPLATE(content),
    'info',
    groupId,
    Date.now(),
    'thinking',
    id,
  );

  for await (const chunk of stream) {
    content += extract(chunk);
    provider.updateLogMessage(
      streamId,
      id,
      THINKING_TEMPLATE(content),
      'thinking',
    );
  }

  logger.debug(`Final reasoning length: ${content.length}`, groupId);
  return content;
}
