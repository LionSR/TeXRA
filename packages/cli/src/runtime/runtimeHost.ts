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
import { createRunProgressRenderer } from './runProgressRenderer';
import type { CliContext } from './cliContext';

export type CliRuntimeHost = AgentRuntimeHost & {
  close(): Promise<void>;
};

export function createCliRuntimeHost(context: CliContext): CliRuntimeHost {
  let sink: LogSink | undefined;
  let logger: Logger | undefined;
  const runProgress = createRunProgressRenderer(context);
  function ensureLogger(): Logger {
    if (logger) return logger;
    sink =
      context.outputFormat === 'ndjson'
        ? new NdjsonStdoutSink()
        : new StderrTextSink();
    logger = createStructuredLogger(sink);
    return logger;
  }

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

      if (event === 'requestShowError') {
        runProgress?.preserve();
        ensureLogger().error(
          (payload as ProgressEventPayloads['requestShowError']).message,
        );
        return;
      }

      if (runProgress?.handle(event, payload)) return;

      if (context.quietLogs) return;

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
      runProgress?.clear();
      await sink?.flush?.();
      await sink?.close?.();
    },
  };
}
