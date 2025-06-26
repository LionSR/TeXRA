// Standard library imports
import { randomUUID } from 'crypto';

// Local imports
import { emitProgress } from '@eventBus/ProgressEventBus';
import { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import type { LogMessageData } from '@logger/LogTypes';

export async function streamReasoningToProgressView<T>(
  stream: AsyncIterable<T>,
  extract: (chunk: T) => string,
  logger: AgentLogger,
  streamId: string,
  groupId?: string,
): Promise<string> {
  const id = randomUUID();
  let content = '';

  const baseData: LogMessageData = {
    id,
    text: content,
    level: 'info',
    timestamp: Date.now(),
    groupId,
    messageType: MESSAGE_TYPES.THINKING,
  };

  emitProgress('addLogMessage', {
    stream: streamId,
    message: baseData,
  });

  for await (const chunk of stream) {
    content += extract(chunk);
    emitProgress('updateLogMessage', {
      stream: streamId,
      message: { ...baseData, text: content },
    });
  }

  logger.debug(`Final reasoning length: ${content.length}`, groupId);
  return content;
}
