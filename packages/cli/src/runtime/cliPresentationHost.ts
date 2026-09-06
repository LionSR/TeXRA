// Local imports - runtime
import {
  dispatchPresentationEvent,
  type HostApprovalBypassStateUpdate,
  type PresentationEventHandlers,
  type RuntimePresentationEvent,
  type RuntimePresentationEventPayloads,
  type SessionHandle,
} from '@agent/runtime';
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import type { ApprovalBypassKind } from '@shared/approvalBypassKind';
import type { ExecutionId } from '@shared/schemas';
import { formatInstructionActionHint } from '@shared/copy/instructionActionHint';

// Local imports - CLI runtime
import {
  createCliLogger,
  createCliLogSink,
  flushNdjsonStdout,
  writeNdjsonStdout,
  type Logger,
  type LogSink,
} from './logSinks';
import { createRunProgressRenderer } from './runProgressRenderer';
import { missingAgentMessage } from './agents';
import type { CliContext } from './cliContext';

export interface CliRuntimeHost {
  emit<K extends RuntimePresentationEvent>(
    event: K,
    payload: RuntimePresentationEventPayloads[K],
  ): boolean;
  attachRunProgressRenderer(
    session: SessionHandle,
    options?: { readonly executionId?: ExecutionId },
  ): () => void;
  prepareInteractivePrompt?: () => void;
  emitApprovalBypassState(update: HostApprovalBypassStateUpdate): void;
  close(): Promise<void>;
}

const ApprovalBypassNdjsonEvent = {
  bash: 'updateBashApprovalBypassState',
  toolEdit: 'updateToolEditApprovalBypassState',
  superYolo: 'updateSuperYoloBypassState',
} as const satisfies Record<ApprovalBypassKind, string>;

export function createCliRuntimeHost(context: CliContext): CliRuntimeHost {
  let sink: LogSink | undefined;
  let logger: Logger | undefined;
  let closed = false;
  const ndjson = context.outputFormat === 'ndjson';
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
   * The one runtime-presentation handler map, both modes. Every event returns
   * `true` when it rendered a user-visible record so the session can report
   * delivery. `showAgentConfigBanner` is rendered as a visible, actionable
   * "agent not found" error so CLI launch failures surface once through the
   * targeted path. Reproduced per-key rather than as a catch-all, so a future
   * `RuntimePresentationEventPayloads` addition is a compile error to decide
   * on rather than a silent fall-through.
   *
   * `requestOpenFile` and `requestEnsureProgressView` have no presentation of
   * their own in either mode. Their debug line is gated on `!ndjson` because
   * the NDJSON logger writes to STDOUT, so a debug call there would put a
   * `kind: 'log'` record on the frozen public wire.
   * `RUNTIME_PRESENTATION_NDJSON_CASES` in
   * `src/test-kernel/cli/RunProgressRenderer.vitest.ts` pins the exact record
   * set each event may emit in NDJSON mode.
   *
   * `runProgress?.preserve()` is inert in NDJSON mode: production never builds
   * a renderer there (`shouldRenderRunProgress`), and where a test context
   * does, `preserve()` no-ops behind its own `ansi && liveLine` guard.
   */
  const handlers: PresentationEventHandlers<RuntimePresentationEventPayloads> =
    {
      requestShowError: (payload) => {
        runProgress?.preserve();
        ensureLogger().error(payload.message);
        return true;
      },
      requestShowInstruction: (payload) => {
        // Not gated by quietLogs (unlike the debug fallback): this is an
        // actionable instruction (e.g. missing API key), not routine progress
        // noise. The action hint is a text-mode affordance; NDJSON carries the
        // actions as fields instead, and `StderrTextSink` drops `fields`, so
        // one call serves both.
        runProgress?.preserve();
        const hint = ndjson ? '' : formatInstructionActionHint(payload.actions);
        ensureLogger().info(`${payload.message}${hint}`, {
          key: payload.key,
          actions: payload.actions,
          showSuppress: payload.showSuppress,
        });
        return true;
      },
      requestOpenFile: () => {
        if (!ndjson) logDebugEvent('requestOpenFile');
        return false;
      },
      showAgentConfigBanner: ({ agentName }) => {
        runProgress?.preserve();
        ensureLogger().error(missingAgentMessage(agentName));
        return true;
      },
      requestEnsureProgressView: () => {
        if (!ndjson) logDebugEvent('requestEnsureProgressView');
        return false;
      },
    };

  return {
    attachRunProgressRenderer: (session, options) =>
      runProgress ? runProgress.attach(session, options) : () => undefined,
    prepareInteractivePrompt: () => runProgress?.preserve(),
    emitApprovalBypassState({ streamId, kind, bypassActive }) {
      if (closed || !ndjson) return;
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
      return dispatchPresentationEvent(handlers, event, payload) === true;
    },
    async close() {
      closed = true;
      runProgress?.clear();
      await sink?.flush?.();
      // Approval-bypass records go through the module-level NDJSON queue via
      // `writeNdjsonStdout`, which the lazily created `sink` may never cover.
      if (ndjson) await flushNdjsonStdout();
    },
  };
}
