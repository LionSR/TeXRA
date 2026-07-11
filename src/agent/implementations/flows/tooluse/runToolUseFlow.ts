import { isDeepStrictEqual } from 'node:util';

// Third-party imports
import { MODEL_CONFIGS } from 'llm-zoo';

// Local imports - agent
import { getExecutionStore } from '@agent/storage';
import {
  activeModelHandlerCompatibilityKey,
  createModelHandler,
  modelHandlerCompatibilityKey,
} from '@agent/runtime/ModelFactory';
import { inferPersistedModelHandlerCompatibilityKey } from '@agent/runtime/modelHandlerCompatibilityInference';
import type { ModelHandlerCompatibilityKey } from '@agent/runtime/modelHandlerCompatibilityKey';
import { type SessionHandle } from '@agent/runtime/SessionHandle';
import { useLaunchRunContext } from '@agent/runtime/RunContext';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import {
  PersistedFlow,
  flowKey,
  stampFlowRecordSchemaVersion,
  type FlowRecord,
} from '@agent/node/persistedFlow';
import type { AgentToolUseSetting } from '@agent/core/definition/AgentDataclass';
import type { IToolRegistry } from '@agent/core/tools/ToolTypes';
import type { BaseFlowContextInit } from '@agent/core/flows/BaseFlowServices';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import type { FollowUpQueueBatchItem } from '@agent/followUp/FollowUpQueue';
import { resolveAgentTools } from '@agent/runtime/agentToolResolution';
import type { ToolInjectionRegistry } from '@agent/runtime/toolInjection';
import { deriveRunOutcome } from '@common/constants/streamStatus';
import { attachProviderError } from '@common/errors/sdkErrorUtils';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  toProviderErrorFromRetry,
  type RunOutcome,
} from '@shared/schemas';
import type { SubagentProgressUpdate } from '@shared/schemas';

// Local imports - tools and flow
import { getDefaultToolRegistry } from '@tools/registry';
import { TaskRunFileService } from '@utils/files';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { ToolUsePrepareNode } from './nodes/ToolUsePrepareNode';
import { ToolUseCycleNode } from './nodes/ToolUseCycleNode';
import { ToolUseWaitNode } from './nodes/ToolUseWaitNode';
import {
  findLastAssistantText,
  extractTouchedFiles,
  migrateSharedState,
  ToolUseRunSharedSchema,
  ToolUseRunSharedCanonicalSchema,
  type ToolUseRunShared,
} from './nodes/types';
import {
  currentModelFromUserChannels,
  setToolUseSharedModel,
} from './modelSwitchState';
import { ToolUseSessionLifecycle } from './ToolUseSessionLifecycle';
import type { ToolUseSessionSnapshot } from './ToolUseSessionTypes';
import type { ToolUseServices } from './ToolUseServices';

export interface RunToolUseFlowInput<
  C = unknown,
> extends BaseFlowContextInit<C> {
  setting: AgentToolUseSetting;
  resumeSnapshot?: ToolUseSessionSnapshot | null;
  /** One batch already drained by an external child-turn owner. */
  drainedFollowUps?: readonly FollowUpQueueBatchItem[];
  onFollowUpConsumed?: () => void;
  /** When true, delegation tools are filtered out to prevent nesting, and
   *  every completed model cycle suspends at WAITING (see `ToolUseWaitNode`)
   *  instead of blocking in-flow for the next follow-up. A resumed flow may
   *  first consume `drainedFollowUps`; the child-run loop still owns
   *  delivery and every later turn boundary. */
  isSubagent?: boolean;
  /** Fires on meaningful progress: todo changes, tool call milestones. */
  onProgress?: (update: SubagentProgressUpdate) => void;
  /** Root-run-only: fires with the latest response at every cycle boundary — see `ToolUseServices.onIdle`. */
  onIdle?: (lastResponse: string | undefined) => void;
  /** Fires after a running tool-use chat changes its model. */
  onModelChanged?: (
    modelHandler: ToolUseServices['modelHandler'],
    model: string,
  ) => void;
  /** Runtime feature registry for auto-injected tools. */
  toolInjections?: ToolInjectionRegistry;
}

export interface RunToolUseFlowResult {
  outcome: RunOutcome | typeof STREAM_PHASE.WAITING;
  lastResponse?: string;
  /** Workspace-relative paths of files edited by tool calls during this session. */
  touchedFiles?: string[];
  /**
   * Total model cost (USD) accumulated by this run, including any subagents
   * it delegated to (rolled up at the delegation boundary). Used by parent
   * runs.
   */
  totalCostUsd?: number;
}

class ToolUseFlowError extends Error {
  constructor(
    message: string,
    readonly result: RunToolUseFlowResult,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ToolUseFlowError';
  }
}

export function getToolUseFlowErrorResult(
  error: unknown,
): RunToolUseFlowResult | undefined {
  return error instanceof ToolUseFlowError ? error.result : undefined;
}

/**
 * Build the canonical self-heal payload for a resumed flow record's `shared`
 * blob from the resume boundary's already-validated snapshot
 * (`SessionResumeRetrieval.retrieveToolUseResumeData` -- the single owner of
 * FlowRecord.shared's legacy-format migration and persisted-format
 * modelHandlerCompatibilityKey inference). The snapshot's key is authoritative
 * when present; otherwise the active handler's key preserves the legacy
 * self-heal fallback. `structuralBase` is the record's fully validated
 * `migrateSharedState` output, which supplies any pass-through fields the
 * snapshot's narrower resume contract doesn't carry (e.g. `systemPrompt`,
 * `lastError`) so they survive the write-back untouched.
 */
function buildResumedSharedFromSnapshot(
  structuralBase: ToolUseRunShared,
  snapshot: ToolUseSessionSnapshot,
  activeCompatibilityKey: ModelHandlerCompatibilityKey | undefined,
): ToolUseRunShared {
  return ToolUseRunSharedSchema.parse({
    ...structuralBase,
    messages: snapshot.messages,
    modelHandlerCompatibilityKey:
      snapshot.modelHandlerCompatibilityKey ?? activeCompatibilityKey,
    stateSlices: {
      runStateSnapshot: snapshot.run,
      workspaceSnapshot: snapshot.workspace,
      userChannels: snapshot.user,
    },
  });
}

interface ToolUseFlowContext {
  readonly ownerSession: SessionHandle;
  readonly session: ToolUseSessionLifecycle;
  readonly modelHandler: ToolUseServices['modelHandler'];
  readonly runtimeHost: AgentRuntimeHost;
  readonly model: string;
  interrupt(): void;
  requestImmediateCompaction(): void;
  modelSwitchDisabledReason(model: string): string | undefined;
  switchModel(model: string): Promise<void>;
}

export type ToolUseFlowSetupCallback = (
  context: ToolUseFlowContext,
) => void | (() => void);

type ToolUsePersistedFlow<C> = PersistedFlow<
  ToolUseRunShared,
  ToolUseServices<C>
>;

const IMMEDIATE_COMPACTION_FOLLOW_UP =
  'The user requested immediate context compaction. Do not start a new task; continue only far enough for the runtime to process any available context compaction, and do not claim that compaction has completed.';
const MODEL_SWITCH_DIFFERENT_FORMAT_ERROR =
  'Cannot switch this conversation to a model with a different conversation format. Start a new chat to use that model.';
const MODEL_SWITCH_DIFFERENT_FORMAT_REASON =
  'different conversation format; start new chat';

export async function runToolUseFlow<C = unknown>(
  input: RunToolUseFlowInput<C>,
  toolRegistry?: IToolRegistry,
  onSetup?: ToolUseFlowSetupCallback,
): Promise<RunToolUseFlowResult> {
  const { logger, setting, onInterrupt } = input;
  const runContext = useLaunchRunContext();
  const { runScope } = runContext;
  const { runtimeHost, streamId, executionId, session: runSession } = runScope;
  // Capture the run's scope at setup. The interrupt closure below fires from
  // the host thread outside the ALS, so it must use this captured session
  // handle instead of asking for an ambient current session later.
  const sessionLifecycle = new ToolUseSessionLifecycle(
    streamId,
    runSession.followUps,
  );
  const registry = toolRegistry ?? getDefaultToolRegistry();
  const { tools: resolvedTools } = await resolveAgentTools({
    tools: setting.tools,
    registry,
    logger,
    approvalPromptsUnavailable: runContext.approvalPromptsUnavailable,
    runtimeUnavailableTools: runContext.runtimeUnavailableTools,
    toolInjections: input.toolInjections,
  });

  const kv = getExecutionStore(executionId);

  const services: ToolUseServices<C> = {
    ...input,
    session: sessionLifecycle,
    resolvedTools,
    toolRegistry: registry,
    snapshot: input.resumeSnapshot ?? null,
    onRoundFinalized: input.onRoundFinalized ?? (async () => {}),
    persistTodos: (todos) => kv.writeTodos(todos),
    fileService: new TaskRunFileService(executionId),
  };
  const switchedHandlers = new Set<ToolUseServices<C>['modelHandler']>();
  let activePersistedFlow: ToolUsePersistedFlow<C> | undefined;

  const persistModelSwitch = async (model: string): Promise<void> => {
    const flow = activePersistedFlow;
    const liveShared = await flow?.getShared();
    if (!flow || !liveShared || !setToolUseSharedModel(liveShared, model)) {
      throw new Error(
        'Cannot save the model switch because the resumable session state is unavailable.',
      );
    }
    await flow.setShared(liveShared);
  };

  const modelSwitchDisabledReason = (model: string): string | undefined => {
    if (services.config.model === model) return undefined;

    const nextConfig = MODEL_CONFIGS[model];
    if (!nextConfig) return `Model ${model} not found in MODEL_CONFIGS`;

    const activeKey = activeModelHandlerCompatibilityKey(services.modelHandler);
    if (!activeKey) {
      // Non-factory handlers still reach switchModel's constructor-reference
      // check. Keep the UI permissive rather than guessing their format here.
      return undefined;
    }
    const nextKey = modelHandlerCompatibilityKey(nextConfig);
    if (!nextKey) return `Unsupported model provider: ${nextConfig.provider}`;
    return activeKey === nextKey
      ? undefined
      : MODEL_SWITCH_DIFFERENT_FORMAT_REASON;
  };

  const switchModel = async (model: string): Promise<void> => {
    const nextConfig = MODEL_CONFIGS[model];
    if (!nextConfig) {
      throw new Error(`Model ${model} not found in MODEL_CONFIGS`);
    }
    if (services.config.model === model) return;

    const disabledReason = modelSwitchDisabledReason(model);
    if (disabledReason) {
      throw new Error(
        disabledReason === MODEL_SWITCH_DIFFERENT_FORMAT_REASON
          ? MODEL_SWITCH_DIFFERENT_FORMAT_ERROR
          : disabledReason,
      );
    }

    const previousHandler = services.modelHandler;
    const nextHandler = (await createModelHandler(
      nextConfig,
    )) as ToolUseServices<C>['modelHandler'];
    // Backstop for untagged/custom handlers and future route drift. This is a
    // constructor-reference comparison, so CLI minification cannot affect it.
    if (nextHandler.constructor !== previousHandler.constructor) {
      nextHandler.dispose();
      throw new Error(MODEL_SWITCH_DIFFERENT_FORMAT_ERROR);
    }
    try {
      await persistModelSwitch(model);
    } catch (error) {
      nextHandler.dispose();
      throw error;
    }
    nextHandler.setAgentCategory(setting.agentCategory);
    nextHandler.setLogger(logger);

    const nextAgentConfig = { ...services.config, model };
    await kv.writeConfig(nextAgentConfig);

    services.modelHandler = nextHandler;
    services.config.model = model;
    services.userVarChannels.transient.MODEL = model;

    switchedHandlers.add(nextHandler);
    if (previousHandler !== input.modelHandler) {
      previousHandler.dispose();
      switchedHandlers.delete(previousHandler);
    }
    logger.emit({
      type: 'run.config',
      streamId,
      executionId,
      config: services.config,
    });
    input.onModelChanged?.(nextHandler, model);
  };

  // A resume's setupSession (see `resumeQueuedToolUseSnapshot`) re-appends
  // its drained follow-up batch into `sessionLifecycle` from inside
  // `onSetup` below, before the flow is interruptible. An async
  // cancellation racing in during that window (through the recovery read,
  // see the `checkInterruption()` guards below) must not erase that batch
  // -- `flowContext.interrupt()` uses the queue-preserving variant for
  // exactly this window, matching `preserveResumeRecord`'s finally guard.
  // Cleared once the flow has passed both guards and moved into real work,
  // so a later mid-run cancellation keeps the normal destructive clear.
  let inResumeStartupWindow = input.resumeSnapshot !== undefined;

  const flowContext: ToolUseFlowContext = {
    ownerSession: runSession,
    session: sessionLifecycle,
    get modelHandler() {
      return services.modelHandler;
    },
    runtimeHost,
    get model() {
      return services.config.model;
    },
    interrupt(): void {
      onInterrupt?.();
      runSession.interactions.cancel({ streamId, cause: 'Run interrupted.' });
      if (inResumeStartupWindow) {
        sessionLifecycle.interruptPreservingQueue();
      } else {
        sessionLifecycle.interrupt();
      }
    },
    requestImmediateCompaction(): void {
      services.modelHandler.requestCompaction();
      if (!sessionLifecycle.hasQueuedFollowUp()) {
        sessionLifecycle.appendSyntheticFollowUp(
          IMMEDIATE_COMPACTION_FOLLOW_UP,
        );
      }
    },
    modelSwitchDisabledReason,
    switchModel,
  };

  let outcome: RunToolUseFlowResult['outcome'] = RUN_OUTCOME.CANCELLED;
  let lastResponse: string | undefined;
  let touchedFiles: string[] | undefined;
  let totalCostUsd: number | undefined;
  let teardownSetup: (() => void) | undefined;
  let preserveResumeRecord = false;
  const compatibilityKey = activeModelHandlerCompatibilityKey(
    services.modelHandler,
  );

  let shared: ToolUseRunShared = {
    messages: [],
    modelHandlerCompatibilityKey: compatibilityKey,
    shouldSkipCycle: false,
    stateSlices: null,
  };

  try {
    teardownSetup = onSetup?.(flowContext) ?? undefined;
    // A host can hand off a cancellation synchronously during setup. Observe
    // it before touching the persisted resume record.
    if (input.checkInterruption()) {
      preserveResumeRecord = input.resumeSnapshot !== undefined;
      return { outcome };
    }

    let flowRecord: FlowRecord | null = null;
    try {
      flowRecord = (await kv.read<FlowRecord>(flowKey(executionId))) ?? null;
    } catch (error) {
      // A failed read here silently converts a resume into an empty-history
      // fresh run -- as loud as the adjacent migration-failure warning below,
      // so it is visible instead of vanishing into debug output.
      logger.warn('Resume parse failed, starting fresh', {
        data: { executionId, error: toErrorMessage(error) },
      });
    }
    // Cancellation can also arrive while the recovery read is pending. Do not
    // start a migration or repair write after that handoff.
    if (input.checkInterruption()) {
      preserveResumeRecord = input.resumeSnapshot !== undefined;
      return { outcome };
    }
    // Past both startup cancellation guards: any later interrupt() is a
    // genuine mid-run cancellation, so go back to the normal destructive
    // queue clear instead of the resume-startup rescue above.
    inResumeStartupWindow = false;

    if (flowRecord?.shared) {
      logger.debug('Resuming tool-use flow from persistence');
      const migrationResult = migrateSharedState(flowRecord.shared);
      if (migrationResult === null) {
        logger.warn('Failed to parse flow record shared state, starting fresh');
        await kv.delete(flowKey(executionId));
        flowRecord = null;
      } else if (input.resumeSnapshot) {
        // The resume boundary (SessionResumeRetrieval.retrieveToolUseResumeData)
        // already migrated this record's legacy shapes and strictly validated
        // the result into `input.resumeSnapshot` before this flow was ever
        // launched -- it is the single owner of FlowRecord.shared's
        // legacy-format parsing and persisted-format compatibility-key
        // inference. Consume its canonical fields directly here instead of
        // re-deriving them; `migrateSharedState` preserves pass-through fields
        // the snapshot's narrower contract doesn't carry (systemPrompt,
        // lastError, ...) so they survive this self-heal write.
        const resumedShared = buildResumedSharedFromSnapshot(
          migrationResult.data,
          input.resumeSnapshot,
          compatibilityKey,
        );
        // `resumeToolUseFromSnapshot` passes `resumeSnapshot` on every
        // native-subagent turn, so this self-heal write must skip whenever
        // the record was already canonical: no legacy shape to migrate, and
        // the snapshot-derived fields match what is already persisted.
        // Otherwise this becomes a `StorageFSKVStore` disk write per turn.
        const writeNeeded =
          migrationResult.migrated ||
          !isDeepStrictEqual(migrationResult.data, resumedShared);
        flowRecord.shared = resumedShared;
        if (writeNeeded) {
          await kv.write(
            flowKey(executionId),
            stampFlowRecordSchemaVersion(flowRecord),
          );
        }
      } else {
        // Defensive fallback only: no resumeSnapshot means the resume
        // boundary above was never consulted for this call (e.g. a fresh
        // launch that happens to find a leftover record for its execution
        // id). Migrate/backfill here so PersistedFlow.ensureRecord never sees
        // a stale legacy shape.
        let migratedData = migrationResult.data;
        let shouldWriteShared = migrationResult.migrated;
        const sharedModel = migratedData.stateSlices
          ? (currentModelFromUserChannels(
              migratedData.stateSlices.userChannels,
            ) ?? services.config.model)
          : services.config.model;
        const backfillCompatibilityKey =
          inferPersistedModelHandlerCompatibilityKey(
            sharedModel,
            migratedData.messages,
          ) ?? compatibilityKey;
        if (
          !migratedData.modelHandlerCompatibilityKey &&
          backfillCompatibilityKey
        ) {
          logger.debug(
            'Backfilled tool-use model-handler compatibility key in shared state.',
          );
          migratedData = {
            ...migratedData,
            modelHandlerCompatibilityKey: backfillCompatibilityKey,
          };
          shouldWriteShared = true;
        }
        if (shouldWriteShared) {
          if (migrationResult.migrated) {
            logger.debug('Migrated legacy shared state to flat format');
          }
          flowRecord.shared = migratedData;
          await kv.write(
            flowKey(executionId),
            stampFlowRecordSchemaVersion(flowRecord),
          );
        }
      }
    }

    const prepareNode = new ToolUsePrepareNode<C>();
    const cycleNode = new ToolUseCycleNode<C>();
    const waitNode = new ToolUseWaitNode<C>(input.drainedFollowUps);
    prepareNode.next(cycleNode);
    cycleNode.next(waitNode);
    waitNode.on(FlowTransition.CONTINUE, cycleNode);
    waitNode.on(FlowTransition.WAITING, waitNode);
    const pf: ToolUsePersistedFlow<C> = new PersistedFlow(
      prepareNode,
      kv,
      executionId,
      ToolUseRunSharedCanonicalSchema,
    );
    activePersistedFlow = pf;
    pf.setServices(services);
    // Note: the flow record is the resume SSOT and the transcript sidecar
    // owns completed-run display/export (#7246 Decision 1) — the old
    // per-step `conversation.json`/`todos.json` projections are gone.
    // Live-run todos still persist event-driven via `persistTodos` above.
    pf.setProjection(async (s, store) => {
      const currentTouchedFiles = extractTouchedFiles(s.stateSlices);
      if (currentTouchedFiles.length) {
        await store.writeWorkspaceFiles(currentTouchedFiles);
      }
    });
    const finalAction = await pf.run(shared);
    // Re-read shared from the flow record — PersistedFlow deep-clones the
    // initial shared via structuredClone, so nodes mutate the clone, not the
    // original object.  Without this, reads of lastError, messages, etc. below
    // would always see the stale initial values.
    shared = (await pf.getShared()) ?? shared;

    lastResponse =
      findLastAssistantText(shared.messages, (m) =>
        services.modelHandler.extractAssistantText(m),
      ) ||
      shared.lastResponse ||
      undefined;
    totalCostUsd =
      shared.stateSlices?.runStateSnapshot.usageAccumulator.totals.totalCost;
    const extractedTouchedFiles = extractTouchedFiles(shared.stateSlices);
    touchedFiles = extractedTouchedFiles.length
      ? extractedTouchedFiles
      : undefined;

    // `FlowTransition.WAITING` is only ever produced by `ToolUseWaitNode`
    // suspending a subagent cycle (see its doc comment) — no further gating
    // needed here; the wait node's own `isSubagent`/`stopAfterCycle` check is
    // the single source of truth for whether a suspension is legitimate.
    if (finalAction === FlowTransition.WAITING) {
      outcome = STREAM_PHASE.WAITING;
    } else {
      outcome = deriveRunOutcome({
        failed: Boolean(shared.lastError),
        cancelled: input.checkInterruption(),
      });
    }
    if (shared.lastError) {
      // Re-throw so runFlowWithLifecycle logs the error and shows
      // the user notification, while preserving terminal run accounting.
      // Attach the full structured provider error so downstream error
      // formatters can surface statusCode, provider, etc. without
      // sniffing the message string.
      const err = new ToolUseFlowError(shared.lastError.message, {
        outcome,
        lastResponse,
        touchedFiles,
        totalCostUsd,
      });
      attachProviderError(err, toProviderErrorFromRetry(shared.lastError));
      throw err;
    }
  } finally {
    activePersistedFlow = undefined;
    teardownSetup?.();
    teardownSetup = undefined;
    if (preserveResumeRecord) {
      logger.debug('Flow record preserved after resume startup cancellation');
    } else if (outcome === STREAM_PHASE.WAITING) {
      logger.debug('Flow record preserved for native subagent WAITING');
    } else if (shared.userCancelledRetry) {
      logger.debug('Flow record preserved for resume after retry cancellation');
    } else {
      try {
        await kv.delete(flowKey(executionId));
      } catch {
        // Ignore cleanup errors
      }
    }

    // WAITING outcome: leave the follow-up queue live, matching the flow
    // record preserved above. A delegate_agent follow-up can race into it via
    // sendFollowUp's 'active' branch between the WAITING transition inside
    // ToolUseWaitNode and this teardown — the tool-use flow context detaches
    // above, but the stream doesn't leave WAITING until resume, so the same
    // live queue instance is what a genuine kill (see ExecutionRegistry.
    // terminate's waiting-cleanup path) or resume drains instead of a
    // `dispose()` here silently discarding it.
    //
    // Resume-startup cancellation (preserveResumeRecord): a resume's
    // setupSession re-appends its drained follow-up batch into this same
    // live queue before the flow is interruptible. `flowContext.interrupt()`
    // uses `sessionLifecycle.interruptPreservingQueue()` instead of
    // `interrupt()` for exactly this window (see its call site above), so
    // that batch survives a cancellation landing while the recovery read is
    // pending. Skipping `dispose()`/release here too keeps it intact for the
    // next `resumeQueuedToolUseSnapshot` call's `drainItems()` instead of
    // discarding the user's queued input alongside the preserved flow
    // record.
    if (outcome !== STREAM_PHASE.WAITING && !preserveResumeRecord) {
      sessionLifecycle.dispose();
    }
    runSession.interactions.cancel({ streamId, cause: 'Run ended.' });
    for (const handler of switchedHandlers) {
      handler.dispose();
    }
  }

  return {
    outcome,
    lastResponse,
    touchedFiles,
    totalCostUsd,
  };
}
