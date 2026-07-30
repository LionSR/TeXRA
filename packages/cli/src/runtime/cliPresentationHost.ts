// Local imports - runtime
import type {
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from '@agent/runtime/runtimePresentationEvents';
import type {
  ApprovalBypassKind,
  HostApprovalBypassStateUpdate,
} from '@agent/runtime/HostInteractions';
import type { SessionEventHub } from '@agent/runtime/SessionEventHub';
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import { INSTRUCTION_ACTION, type InstructionAction } from '@shared/schemas';
import { assertNever } from '@utils/core';

// Local imports - CLI runtime
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

export interface CliRuntimeHost {
  emit<K extends RuntimePresentationEvent>(
    event: K,
    payload: RuntimePresentationEventPayloads[K],
  ): void;
  attachRunProgressRenderer(events: SessionEventHub): () => void;
  prepareInteractivePrompt?: () => void;
  emitApprovalBypassState(update: HostApprovalBypassStateUpdate): void;
  close(): Promise<void>;
}

const ApprovalBypassNdjsonEvent = {
  bash: 'updateBashApprovalBypassState',
  toolEdit: 'updateToolEditApprovalBypassState',
  superYolo: 'updateSuperYoloBypassState',
} as const satisfies Record<ApprovalBypassKind, string>;

/**
 * Human-readable phrasing for {@link InstructionAction} tokens printed to
 * stderr in text mode. Mirrors what the VS Code extension's
 * `INSTRUCTION_ACTION_VIEW` (packages/extension/src/frontend/events/
 * agentEventListeners.ts) conveys via its button titles, translated to CLI
 * phrasing since there's no button to click here. Unknown/future tokens fall
 * back to the raw token rather than failing.
 */
const INSTRUCTION_ACTION_HINT: Partial<Record<InstructionAction, string>> = {
  [INSTRUCTION_ACTION.SET_API_KEY]: 'set your API key (texra setup)',
  [INSTRUCTION_ACTION.OPEN_CONFIGURATION_GUIDE]: 'see the configuration guide',
  [INSTRUCTION_ACTION.OPEN_MODELS_DOC]: 'see the model documentation',
};

function writeRuntimePresentationNdjson(
  logger: Logger,
  event: RuntimePresentationEvent,
  payload: RuntimePresentationEventPayloads[RuntimePresentationEvent],
): void {
  switch (event) {
    case 'requestShowError': {
      const errorPayload =
        payload as RuntimePresentationEventPayloads['requestShowError'];
      logger.error(errorPayload.message);
      return;
    }
    case 'requestShowInstruction': {
      const instructionPayload =
        payload as RuntimePresentationEventPayloads['requestShowInstruction'];
      logger.info(instructionPayload.message, {
        key: instructionPayload.key,
        actions: instructionPayload.actions,
        showSuppress: instructionPayload.showSuppress,
      });
      return;
    }
    case 'requestOpenFile':
    case 'showAgentConfigBanner':
    case 'requestEnsureProgressView':
      return;
    default:
      assertNever(event, 'Unhandled CLI NDJSON presentation event');
  }
}

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

  return {
    attachRunProgressRenderer: (events) =>
      attachRunProgressRenderer(events, runProgress),
    prepareInteractivePrompt: () => runProgress?.preserve(),
    emitApprovalBypassState({ streamId, kind, bypassActive }) {
      if (closed || context.outputFormat !== 'ndjson') return;
      const record: CliNdjsonRecord = {
        kind: 'progress',
        event: ApprovalBypassNdjsonEvent[kind],
        ts: new Date().toISOString(),
        payload: { streamId, bypassActive },
      };
      writeNdjsonStdout(record);
    },
    emit<K extends RuntimePresentationEvent>(
      event: K,
      payload: RuntimePresentationEventPayloads[K],
    ) {
      if (closed) return;

      if (context.outputFormat === 'ndjson') {
        writeRuntimePresentationNdjson(
          ensureLogger(),
          event,
          payload as RuntimePresentationEventPayloads[RuntimePresentationEvent],
        );
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

      if (event === 'requestShowInstruction') {
        // Not gated by quietLogs (below): unlike the debug fallback, this is
        // an actionable instruction (e.g. missing API key), not routine
        // progress noise.
        runProgress?.preserve();
        const instructionPayload =
          payload as RuntimePresentationEventPayloads['requestShowInstruction'];
        const hint = instructionPayload.actions?.length
          ? ` (${instructionPayload.actions
              .map((action) => INSTRUCTION_ACTION_HINT[action] ?? action)
              .join(', ')})`
          : '';
        ensureLogger().info(`${instructionPayload.message}${hint}`);
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
