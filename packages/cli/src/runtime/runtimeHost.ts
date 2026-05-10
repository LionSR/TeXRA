// Local imports - runtime
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local imports - CLI runtime
import { handleCliApprovalEvent } from './approvalAdapter';
import type { CliContext } from './cliContext';
import { createCliLogger } from './logger';

export type CliOutputFormat = 'text' | 'json' | 'ndjson';

export function createCliRuntimeHost(context: CliContext): AgentRuntimeHost {
  const logger = createCliLogger(context);

  return {
    emit(event, payload) {
      if (handleCliApprovalEvent(event, payload, context)) return;

      if (context.outputFormat === 'ndjson') {
        const record = {
          kind: 'progress',
          event,
          ts: new Date().toISOString(),
          payload,
        } satisfies {
          kind: 'progress';
          event: keyof ProgressEventPayloads;
          ts: string;
          payload: ProgressEventPayloads[keyof ProgressEventPayloads];
        };
        process.stdout.write(`${JSON.stringify(record)}\n`);
        return;
      }

      if (event === 'requestShowError') {
        const message = (payload as ProgressEventPayloads['requestShowError'])
          .message;
        logger.error(message);
        return;
      }

      if (event === 'setTaskState') {
        const data = payload as ProgressEventPayloads['setTaskState'];
        logger.info('Task state registered', { streamId: data.streamId });
      }
    },
  };
}
