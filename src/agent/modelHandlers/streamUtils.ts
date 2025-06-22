import { randomUUID } from 'crypto';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { AgentLogger } from '@logger/AgentLogger';

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
    `<span class="message-info">Thinking content: ${content}</span>`,
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
      `<span class="message-info">Thinking content: ${content}</span>`,
      'thinking',
    );
  }

  logger.debug(`Final reasoning length: ${content.length}`, groupId);
  return content;
}
