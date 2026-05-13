// Local imports - runtime
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import {
  createStructuredLogger,
  type Logger,
  type LogSink,
} from '@logger/structuredLogger';

// Local imports - CLI runtime
import { handleCliApprovalEvent } from './approvalAdapter';
import {
  NdjsonStdoutSink,
  StderrTextSink,
  writeNdjsonStdout,
} from './logSinks';
import type { CliContext } from './cliContext';

export type CliRuntimeHost = AgentRuntimeHost & {
  close(): Promise<void>;
};

export function createCliRuntimeHost(context: CliContext): CliRuntimeHost {
  const quietLogs = context.quietLogs ?? false;
  let sink: LogSink | undefined;
  let logger: Logger | undefined;
  const ensureLogger = (): Logger => {
    if (logger) return logger;
    sink =
      context.outputFormat === 'ndjson'
        ? new NdjsonStdoutSink()
        : new StderrTextSink();
    logger = createStructuredLogger(sink);
    return logger;
  };

  return {
    emit(event, payload) {
      if (handleCliApprovalEvent(event, payload, context)) return;

      if (context.outputFormat === 'ndjson') {
        writeNdjsonStdout({
          kind: 'progress',
          event,
          ts: new Date().toISOString(),
          payload,
        });
        return;
      }

      if (quietLogs && event !== 'requestShowError') return;

      if (event === 'requestShowError') {
        ensureLogger().error(
          (payload as ProgressEventPayloads['requestShowError']).message,
        );
        return;
      }

      if (event === 'setTaskState') {
        const data = payload as ProgressEventPayloads['setTaskState'];
        ensureLogger().info('Task state registered', {
          streamId: data.streamId,
        });
        return;
      }

      ensureLogger().debug(`Progress event: ${String(event)}`);
    },
    async close() {
      await sink?.flush?.();
      await sink?.close?.();
    },
  };
}
