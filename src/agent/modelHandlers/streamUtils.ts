// Standard library imports
// Standard library imports
import { randomUUID } from 'crypto';

// Third-party imports
import { encode as encodeHtml } from 'he';

// Local imports - agent

// Local imports
import { bus } from '@eventBus/ProgressEventBus';
import { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';

/**
 * Create a span element for special log content.
 * @param content - The text to wrap.
 * @param type - The message type value.
 */

export async function streamReasoningToProgressView<T>(
  stream: AsyncIterable<T>,
  extract: (chunk: T) => string,
  logger: AgentLogger,
  streamId: string,
  groupId?: string,
): Promise<string> {
  const id = randomUUID();
  let content = '';

  bus.emit('addLogMessage', {
    stream: streamId,
    logMessage: {
      id,
      text: encodeHtml(content),
      level: 'info',
      timestamp: Date.now(),
      groupId,
      messageType: MESSAGE_TYPES.THINKING,
    },
  });

  for await (const chunk of stream) {
    content += extract(chunk);
    bus.emit('updateLogMessage', {
      stream: streamId,
      logMessage: {
        id,
        text: encodeHtml(content),
        messageType: MESSAGE_TYPES.THINKING,
      },
    });
  }

  logger.debug(`Final reasoning length: ${content.length}`, groupId);
  return content;
}
