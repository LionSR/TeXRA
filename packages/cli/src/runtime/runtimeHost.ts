// Local imports - runtime
import type {
  AgentRuntimeEvent,
  AgentRuntimeEventPayloads,
  AgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
import {
  isRuntimeInteractionEvent,
  type RuntimeInteractionEvent,
  type RuntimeInteractionEventPayloads,
} from '@agent/runtime/runtimeInteractionEvents';
import type { RuntimePresentationEventPayloads } from '@agent/runtime/runtimePresentationEvents';
import type { SessionEventHub } from '@agent/runtime/SessionEventHub';
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
  attachRunProgressRenderer,
  createRunProgressRenderer,
} from './runProgressRenderer';
import type { CliContext } from './cliContext';

export type CliRuntimeHost = AgentRuntimeHost & {
  attachRunProgressRenderer(events: SessionEventHub): () => void;
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

  function attachProgressRenderer(events: SessionEventHub): () => void {
    return attachRunProgressRenderer(events, runProgress);
  }

  return {
    attachRunProgressRenderer: attachProgressRenderer,
    prepareInteractivePrompt,
    emit<K extends AgentRuntimeEvent>(
      event: K,
      payload: AgentRuntimeEventPayloads[K],
    ) {
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

      if (context.quietLogs) return;

      ensureLogger().debug(`Runtime event: ${String(event)}`);
    },
    async close() {
      closed = true;
      runProgress?.clear();
      await sink?.flush?.();
      await sink?.close?.();
    },
  };
}
