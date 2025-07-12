// Standard library imports
import { randomUUID } from 'crypto';

// Local imports
import { emitProgress } from '@eventBus/ProgressEventBus';
import { AgentLogger } from '@logger/AgentLogger';
import { encode as encodeHtml } from 'he';
import { MESSAGE_TYPES } from '@logger/messageTypes';

/**
 * Create a span element for special log content.
 * @param content - The text to wrap.
 * @param type - The message type value.
 */
const escapeContent = (content: string): string => encodeHtml(content);

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
    logMessage: {
      id,
      text: escapeContent(content),
      level: 'info',
      timestamp: Date.now(),
      groupId,
      messageType: MESSAGE_TYPES.THINKING,
    },
  });

  for await (const chunk of stream) {
    content += extract(chunk);
    emitProgress('updateLogMessage', {
      stream: streamId,
      logMessage: {
        id,
        text: escapeContent(content),
        messageType: MESSAGE_TYPES.THINKING,
      },
    });
  }

  logger.debug(`Final reasoning length: ${content.length}`, groupId);
  return content;
}
