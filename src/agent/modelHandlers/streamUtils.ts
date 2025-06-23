// Standard library imports
import { randomUUID } from 'crypto';

// Local imports
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import { AgentLogger } from '@logger/AgentLogger';

const THINKING_TEMPLATE = (content: string) =>
  `<span class="message-info">Thinking content: ${content}</span>`;

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
