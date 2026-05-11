// Local imports - runtime
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local imports - CLI runtime
import { handleCliApprovalEvent } from './approvalAdapter';
import type { CliContext } from './cliContext';
import { writeNdjsonStdout } from './logSinks';
import { createCliLogger } from './logger';

export type CliRuntimeHost = AgentRuntimeHost & {
  close(): Promise<void>;
};

export function createCliRuntimeHost(context: CliContext): CliRuntimeHost {
  let logger: ReturnType<typeof createCliLogger> | undefined;
  const cliLogger = (): ReturnType<typeof createCliLogger> =>
    (logger ??= createCliLogger(context));

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
        writeNdjsonStdout(record);
        return;
      }

      if (event === 'requestShowError') {
        const message = (payload as ProgressEventPayloads['requestShowError'])
          .message;
        cliLogger().logger.error(message);
        return;
      }

      if (event === 'setTaskState') {
        const data = payload as ProgressEventPayloads['setTaskState'];
        cliLogger().logger.info('Task state registered', {
          streamId: data.streamId,
        });
        return;
      }

      cliLogger().logger.debug(`Progress event: ${String(event)}`);
    },
    async close() {
      await logger?.close();
    },
  };
}
