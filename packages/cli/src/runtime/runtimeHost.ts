// Local imports - runtime
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { SetTaskStatePayload } from '@agent/runtime/taskStateProgressPayload';
import {
  isRuntimeInteractionEvent,
  type RuntimeInteractionEvent,
  type RuntimeInteractionEventPayloads,
} from '@agent/runtime/runtimeInteractionEvents';
import {
  isRuntimePresentationEvent,
  type RuntimePresentationEventPayloads,
} from '@agent/runtime/runtimePresentationEvents';
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';

// Local imports - CLI runtime
import { handleCliApprovalEvent } from './approvalAdapter';
import {
  createCliLogger,
  createCliLogSink,
  writeNdjsonStdout,
  type Logger,
  type LogSink,
} from './logSinks';
import {
  createRunProgressRenderer,
  isRunProgressEvent,
} from './runProgressRenderer';
import type { CliContext } from './cliContext';

export type CliRuntimeHost = AgentRuntimeHost & {
  prepareInteractivePrompt?: () => void;
  close(): Promise<void>;
};

export function createCliRuntimeHost(context: CliContext): CliRuntimeHost {
  let sink: LogSink | undefined;
  let logger: Logger | undefined;
  let closed = false;
  const runProgress = createRunProgressRenderer(context);
  function ensureLogger(): Logger {
    if (logger) return logger;
    sink = createCliLogSink(context.outputFormat);
    logger = createCliLogger(sink);
    return logger;
  }

  function prepareInteractivePrompt(): void {
    runProgress?.preserve();
  }

  return {
    prepareInteractivePrompt,
    emit(event, payload) {
      if (closed) return;

      if (
        isRuntimeInteractionEvent(event) &&
        handleCliApprovalEvent(
          event as RuntimeInteractionEvent,
          payload as RuntimeInteractionEventPayloads[RuntimeInteractionEvent],
          context,
          {
            beforePrompt: prepareInteractivePrompt,
          },
        )
      ) {
        return;
      }

      if (context.outputFormat === 'ndjson') {
        const record: CliNdjsonRecord = {
          kind: 'progress',
          event,
          ts: new Date().toISOString(),
          payload,
        };
        writeNdjsonStdout(record);
        return;
      }

      if (event === 'requestShowError') {
        runProgress?.preserve();
        ensureLogger().error(
          (payload as RuntimePresentationEventPayloads['requestShowError'])
            .message,
        );
        return;
      }

      if (
        !isRuntimePresentationEvent(event) &&
        !isRuntimeInteractionEvent(event) &&
        isRunProgressEvent(event) &&
        runProgress?.handle(event, payload)
      ) {
        return;
      }

      if (context.quietLogs) return;

      if (event === 'setTaskState') {
        const data = payload as SetTaskStatePayload;
        ensureLogger().info('Task state registered', {
          streamId: data.streamId,
        });
        return;
      }

      ensureLogger().debug(`Progress event: ${String(event)}`);
    },
    async close() {
      closed = true;
      runProgress?.clear();
      await sink?.flush?.();
      await sink?.close?.();
    },
  };
}
