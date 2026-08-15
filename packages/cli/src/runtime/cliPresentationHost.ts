// Local imports - runtime
import {
  dispatchPresentationEvent,
  type HostApprovalBypassStateUpdate,
  type PresentationEventHandlers,
  type RuntimePresentationEvent,
  type RuntimePresentationEventPayloads,
  type SessionEventHub,
} from '@agent/runtime';
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import type { ApprovalBypassKind } from '@shared/approvalBypassKind';
import { INSTRUCTION_ACTION, type InstructionAction } from '@shared/schemas';

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
import { missingAgentMessage } from './agents';
import type { CliContext } from './cliContext';

export interface CliRuntimeHost {
  emit<K extends RuntimePresentationEvent>(
    event: K,
    payload: RuntimePresentationEventPayloads[K],
  ): boolean;
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
 * phrasing since there's no button to click here. The `satisfies` clause keeps
 * the table exhaustive at compile time, but the lookup type stays partial: an
 * action token can arrive from a newer producer over the wire, and those fall
 * back to the raw token rather than printing an empty hint.
 */
const INSTRUCTION_ACTION_HINT: Partial<Record<InstructionAction, string>> = {
  [INSTRUCTION_ACTION.SET_API_KEY]: 'set your API key (texra setup)',
  [INSTRUCTION_ACTION.OPEN_CONFIGURATION_GUIDE]: 'see the configuration guide',
  [INSTRUCTION_ACTION.OPEN_MODELS_DOC]: 'see the model documentation',
} satisfies Record<InstructionAction, string>;

/**
 * Builds the NDJSON-mode handler map. `requestOpenFile` and
 * `requestEnsureProgressView` have no NDJSON wire representation today and
 * stay deliberate no-ops; every other event returns `true` when it rendered
 * a user-visible record so the session can report delivery. Building this
 * per `logger` keeps the handlers closed over the specific `Logger` instance
 * in play at call time (an ndjson sink is created lazily via
 * `ensureLogger()`).
 */
function createRuntimePresentationNdjsonHandlers(
  logger: Logger,
): PresentationEventHandlers<RuntimePresentationEventPayloads> {
  return {
    requestShowError: (payload) => {
      logger.error(payload.message);
      return true;
    },
    requestShowInstruction: (payload) => {
      logger.info(payload.message, {
        key: payload.key,
        actions: payload.actions,
        showSuppress: payload.showSuppress,
      });
      return true;
    },
    requestOpenFile: () => false,
    showAgentConfigBanner: ({ agentName }) => {
      logger.error(missingAgentMessage(agentName));
      return true;
    },
    requestEnsureProgressView: () => false,
  };
}

export function createCliRuntimeHost(context: CliContext): CliRuntimeHost {
  let sink: LogSink | undefined;
  let logger: Logger | undefined;
  let ndjsonHandlers:
    PresentationEventHandlers<RuntimePresentationEventPayloads> | undefined;
  let closed = false;
  const runProgress = createRunProgressRenderer(context);
  function ensureLogger(): Logger {
    if (logger) return logger;
    sink = createCliLogSink(context.outputFormat);
    logger = createCliLogger(sink);
    return logger;
  }

  function logDebugEvent(event: RuntimePresentationEvent): void {
    if (context.quietLogs) return;
    ensureLogger().debug(`Runtime event: ${String(event)}`);
  }

  /**
   * Text-mode (non-NDJSON) handler map. `requestOpenFile` and
   * `requestEnsureProgressView` have no dedicated text-mode presentation
   * today, so they stay no-ops and report no delivery. `showAgentConfigBanner`
   * is rendered as a visible, actionable "agent not found" error so CLI
   * launch failures surface once through the targeted path. Reproduced
   * per-key here rather than as a catch-all, so a future
   * `RuntimePresentationEventPayloads` addition is a compile error to decide
   * on rather than a silent fall-through.
   */
  const textModeHandlers: PresentationEventHandlers<RuntimePresentationEventPayloads> =
    {
      requestShowError: (payload) => {
        runProgress?.preserve();
        ensureLogger().error(payload.message);
        return true;
      },
      requestShowInstruction: (payload) => {
        // Not gated by quietLogs (below): unlike the debug fallback, this is
        // an actionable instruction (e.g. missing API key), not routine
        // progress noise.
        runProgress?.preserve();
        const hint = payload.actions?.length
          ? ` (${payload.actions
              .map((action) => INSTRUCTION_ACTION_HINT[action] ?? action)
              .join(', ')})`
          : '';
        ensureLogger().info(`${payload.message}${hint}`);
        return true;
      },
      requestOpenFile: () => {
        logDebugEvent('requestOpenFile');
        return false;
      },
      showAgentConfigBanner: ({ agentName }) => {
        runProgress?.preserve();
        ensureLogger().error(missingAgentMessage(agentName));
        return true;
      },
      requestEnsureProgressView: () => {
        logDebugEvent('requestEnsureProgressView');
        return false;
      },
    };

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
    ): boolean {
      if (closed) return false;

      if (context.outputFormat === 'ndjson') {
        ndjsonHandlers ??=
          createRuntimePresentationNdjsonHandlers(ensureLogger());
        return (
          dispatchPresentationEvent(ndjsonHandlers, event, payload) === true
        );
      }

      return (
        dispatchPresentationEvent(textModeHandlers, event, payload) === true
      );
    },
    async close() {
      closed = true;
      runProgress?.clear();
      await sink?.flush?.();
      await sink?.close?.();
    },
  };
}
