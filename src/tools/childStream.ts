// Local imports
import type { AgentTrace, StageHandle } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { captureOwnedExecutionLeaseIfPresent } from '@agent/storage/executionLease';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  finalizeRunTerminal,
  type RunTerminalPersistence,
} from '@agent/runtime/AgentRunLifecycle';
import { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { classifyAgentError } from '@common/errors';
import { RUN_OUTCOME, STREAM_PHASE, buildRunDescriptor } from '@shared/schemas';
import type {
  ExecutionId,
  RunKind,
  StreamTabId,
  StorageKey,
} from '@shared/schemas';
import { deriveRunOutcome } from '@shared/streams/streamStatus';
import { createRunTrace } from '@transcript';
import { formatDuration } from '@utils/core';
import { truncateWithEllipsis } from '@utils/text/stringUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

interface CreateChildStreamOptions {
  runtimeHost: AgentRuntimeHost;
  streamPrefix: string;
  streamCategory: AgentCategory;
  runKind: RunKind;
  agentName: string;
  description: string;
  config: AgentConfig;
  /** Tool that spawned this child (e.g. "bash", "codex"). Used for icon selection in the UI. */
  toolName?: string;
}

/**
 * How the child stream's own caller believes its run ended. `finalize` still
 * cross-checks the execution registry for an already-CANCELLED status (an
 * explicit stop/kill can land between the caller deciding this and the call
 * landing here), so `cancelled` always wins regardless of what the registry
 * later confirms.
 */
export type ChildStreamOutcome =
  | { kind: 'completed' }
  | { kind: 'failed'; error?: unknown; errorMessage?: string }
  | { kind: 'cancelled' };

interface FinalizeChildStreamOptions {
  wallTimeMs?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  } | null;
  /** Defaults to `{ kind: 'completed' }` when omitted. */
  outcome?: ChildStreamOutcome;
  /** Session stage closed with the derived outcome (agent-CLI loop's stage). */
  stage?: Pick<StageHandle, 'end'>;
  /** Durable execution-state action; background bash owns its richer block. */
  persistence?: RunTerminalPersistence;
  /** Remove the child stream tab from the progress view once finalized. */
  autoClose?: boolean;
}

export interface ChildStream {
  childStreamId: StreamTabId;
  logger: AgentTrace;
  /** The child loop is idle and waiting for the next follow-up instruction. */
  waitForInput: () => void;
  /** The child loop has started processing a turn. */
  beginTurn: () => void;
  /** The active turn failed; preserve explicit user stops. */
  failTurn: () => void;
  /**
   * Complete the child stream lifecycle through the owning execution handle.
   * Resolves once the shared terminal finalizer has persisted, settled, and
   * untracked — callers that must not exit before the terminal status lands
   * (headless CLI session loops) await it.
   */
  finalize: (options?: FinalizeChildStreamOptions) => Promise<void>;
}

/** Create a child stream tab and execution handle for a background child task. */
export function createChildStream(
  executionId: ExecutionId,
  parentStreamId: StreamTabId,
  options: CreateChildStreamOptions,
): ChildStream {
  const childStreamId = `${options.streamPrefix}#${executionId}` as StreamTabId;
  const { runtimeHost } = options;

  // Capture the run's session at creation (inside the parent run's ALS); the
  // status-update and finalize closures below fire later, possibly outside it.
  const session = currentSession();
  const runTrace = createRunTrace(
    childStreamId,
    session.transcripts,
    session.flushers,
    executionId,
  );
  const detachSessionTrace = session.attachRunTrace(
    runTrace.trace,
    childStreamId,
  );
  const disposeTrace = () => {
    detachSessionTrace();
    runTrace.dispose();
  };
  session.events.assertRunSubscribersAttachedBeforeActivation(childStreamId);

  // Register the child stream (state, logs, hints) without switching the
  // active tab. Background child streams (bash, codex) shouldn't yank the
  // user away from whatever they're viewing — the tab simply appears.
  session.events.emit({
    scope: 'session',
    event: {
      type: 'setActiveStream',
      payload: {
        streamId: childStreamId,
        agentCategory: options.streamCategory,
        suppressViewSwitch: true,
      },
    },
  });
  runTrace.trace.emit({
    type: 'run.start',
    descriptor: buildRunDescriptor({
      streamId: childStreamId,
      executionId,
      agent: options.agentName,
      category: options.streamCategory,
      kind: options.runKind,
    }),
  });
  runTrace.trace.emit({
    type: 'run.config',
    streamId: childStreamId,
    executionId,
    config: options.config,
  });
  const description = truncateWithEllipsis(options.description, 80);
  session.events.emit({
    scope: 'session',
    event: {
      type: 'updateStreamDescription',
      payload: {
        streamId: childStreamId,
        description,
      },
    },
  });

  const handle = new AgentExecutionHandle(
    executionId,
    parentStreamId,
    childStreamId,
    options.agentName,
    options.streamCategory,
    runtimeHost,
    runTrace.trace,
  );
  const executionLeaseScope = captureOwnedExecutionLeaseIfPresent(executionId);
  if (executionLeaseScope) {
    handle.attachExecutionLeaseScope(executionLeaseScope);
  }
  if (options.toolName) handle.toolName = options.toolName;
  // The process-owned snapshot listener persists both facts before handle
  // tracking; a later presentation replays them from the snapshot store during
  // canonical state loading (#8258).
  session.executions.trackAgentExecution(handle, {
    status: STREAM_PHASE.RUNNING,
  });

  return {
    childStreamId,
    logger: runTrace.trace,
    // Mid-run status updates are intentionally best-effort. Explicit stops and
    // stale handles are ignored by the registry; finalize owns terminal status.
    waitForInput: () => {
      session.executions.updateAgentExecutionStatus(
        handle,
        STREAM_PHASE.WAITING,
      );
    },
    beginTurn: () => {
      session.executions.updateAgentExecutionStatus(
        handle,
        STREAM_PHASE.RUNNING,
      );
    },
    failTurn: () => {
      session.executions.updateAgentExecutionStatus(
        handle,
        STREAM_PHASE.FAILED,
      );
    },
    finalize: (finalizeOptions) =>
      finalizeChildStream({
        handle,
        session,
        logger: runTrace.trace,
        disposeTrace,
        options: finalizeOptions,
      }),
  };
}

interface FinalizeChildStreamArgs {
  handle: AgentExecutionHandle;
  session: SessionHandle;
  logger: AgentTrace;
  disposeTrace: () => void;
  options?: FinalizeChildStreamOptions;
}

/**
 * Finalize a child stream tab: presentation logging plus the child-specific
 * outcome derivation, then the shared terminal finalizer (settle, untrack,
 * terminal stream phase) and the autoClose emit. Child streams never traverse
 * the run lifecycle, so this is their only settle point.
 */
async function finalizeChildStream(
  args: FinalizeChildStreamArgs,
): Promise<void> {
  const { handle, session, logger, disposeTrace, options } = args;
  const outcomeOption = options?.outcome ?? { kind: 'completed' as const };
  const errorMessage =
    outcomeOption.kind === 'failed'
      ? (outcomeOption.errorMessage ??
        (outcomeOption.error != null
          ? toErrorMessage(outcomeOption.error)
          : undefined))
      : undefined;

  if (errorMessage) {
    logger.error(errorMessage);
  }
  if (options?.wallTimeMs != null) {
    logger.info(`Completed in ${formatDuration(options.wallTimeMs)}`);
  }
  if (options?.usage) {
    logger.info('Tokens', {
      data: {
        input: options.usage.input_tokens,
        output: options.usage.output_tokens,
      },
    });
  }

  // The terminal outcome the child finishes with — the single derivation for
  // everything the shared finalizer projects. Explicit user stops win: the
  // registry may already show CANCELLED (stop/kill transitioned it) for a
  // child whose own exit reported a failure (e.g. a killed bash process exits
  // non-zero), and long-lived child loops finalize after an interrupt. Clean
  // exits project to `completed` so the tab clears.
  const stopped =
    outcomeOption.kind === 'cancelled' ||
    session.executions.getStatus(handle).status === STREAM_PHASE.CANCELLED;
  const outcome = deriveRunOutcome({
    failed: !stopped && outcomeOption.kind === 'failed',
    cancelled: stopped,
  });
  const error =
    outcome === RUN_OUTCOME.FAILED
      ? {
          kind: classifyAgentError(
            outcomeOption.kind === 'failed' ? outcomeOption.error : undefined,
          ),
          message: errorMessage ?? 'Child stream failed',
        }
      : undefined;

  await finalizeRunTerminal({
    handle,
    executions: session.executions,
    streamStatus: session.status,
    outcome,
    error,
    isSubagent: handle.parentStreamId !== handle.childStreamId,
    stage: options?.stage,
    // No trace emit: child-stream results must stay out of `session.onResult`
    // (host toast) consumers — the loop already presents them as follow-ups.
    persistence: options?.persistence ?? { kind: 'skip' },
  });
  disposeTrace();

  if (options?.autoClose) {
    session.events.emit({
      scope: 'session',
      event: {
        type: 'removeStream',
        payload: { streamId: handle.childStreamId },
      },
    });
  }
}
