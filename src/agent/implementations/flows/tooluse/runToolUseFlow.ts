// Node imports
import { isDeepStrictEqual } from 'node:util';

// Local imports
import { getExecutionStore } from '@agent/storage';
import {
  activeModelHandlerCompatibilityKey,
  createModelHandler,
  modelHandlersShareConversationFormat,
  modelHandlerCompatibilityKey,
} from '@agent/runtime/ModelFactory';
import { inferAndLogPersistedModelHandlerCompatibilityKey } from '@agent/runtime/modelHandlerCompatibilityInference';
import type { ModelHandlerCompatibilityKey } from '@agent/runtime/modelHandlerCompatibilityKey';
import { type SessionHandle } from '@agent/runtime/SessionHandle';
import { useLaunchRunContext } from '@agent/runtime/RunContext';
import type { SessionHostInteractions } from '@agent/runtime/HostInteractions';
import {
  PersistedFlow,
  PersistedFlowStateError,
  flowKey,
  readPersistedFlowRecord,
  stampFlowRecordSchemaVersion,
} from '@agent/node/persistedFlow';
import {
  AgentCategory,
  type AgentToolUseSetting,
} from '@agent/core/definition/AgentDataclass';
import type { ITool, IToolRegistry } from '@agent/core/tools/ToolTypes';
import type { BaseFlowContextInit } from '@agent/core/flows/BaseFlowServices';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import type { FollowUpQueueBatchItem } from '@agent/followUp/FollowUpQueue';
import { resolveAgentTools } from '@agent/runtime/agentToolResolution';
import type { ToolInjectionRegistry } from '@agent/runtime/toolInjection';
import {
  getRuntimeModelConfig,
  resolveRuntimeModelConfig,
} from '@model/runtimeModelRegistry';
import type { SubagentProgressUpdate } from '@shared/schemas';
import { RUN_OUTCOME, STREAM_PHASE, type RunOutcome } from '@shared/schemas';
import { deriveRunOutcome } from '@shared/streams/streamStatus';
import { getDefaultToolRegistry } from '@tools/registry';
import {
  buildOverlayToolRegistry,
  buildTerminalTool,
} from '@tools/structuredOutput';
import { TaskRunFileService } from '@utils/files';

// Local file imports
import { ToolUsePrepareNode } from './nodes/ToolUsePrepareNode';
import { ToolUseCycleNode } from './nodes/ToolUseCycleNode';
import { ToolUseWaitNode } from './nodes/ToolUseWaitNode';
import {
  findLastAssistantText,
  extractTouchedFiles,
  migrateSharedState,
  ToolUseRunSharedCanonicalSchema,
  type PreparedShared,
  type ToolUseRunShared,
} from './nodes/types';
import {
  currentModelFromUserChannels,
  setToolUseSharedModel,
} from './modelSwitchState';
import { ToolUseSessionLifecycle } from './ToolUseSessionLifecycle';
import { throwFlowLastError } from '../flowLastError';
import type { ToolUseServices } from './ToolUseServices';

export interface RunToolUseFlowInput<
  C = unknown,
> extends BaseFlowContextInit<C> {
  setting: AgentToolUseSetting;
  /** Canonical shared state and the persisted value observed during retrieval. */
  resume?: Readonly<{ shared: PreparedShared; sourceShared: unknown }>;
  /** One batch already drained by an external child-turn owner. */
  drainedFollowUps?: readonly FollowUpQueueBatchItem[];
  /**
   * Take messages queued at a resume ownership boundary. Called first after
   * live-flow attachment and then after each WAITING suspension; a later call
   * may decline ownership by returning an empty batch.
   */
  takePendingFollowUps?: () => readonly FollowUpQueueBatchItem[];
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
  /** Caller-supplied tools available only to this run. */
  tools?: readonly ITool[];
  /** Reports whether terminal finalization should retain the resume record. */
  onFlowRecordDisposition?: (disposition: 'preserve' | 'delete') => void;
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
  /**
   * Value the model submitted through the synthetic `submit_output` terminal
   * tool, already validated by that tool's Zod schema. Present only when the
   * run's config carried an `outputSchema` and the model called the tool.
   */
  structured?: unknown;
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

interface ToolUseFlowContext {
  readonly ownerSession: SessionHandle;
  readonly session: ToolUseSessionLifecycle;
  readonly modelHandler: ToolUseServices['modelHandler'];
  readonly interactions: SessionHostInteractions;
  readonly model: string;
  interrupt(): void;
  requestImmediateCompaction(): void;
  modelSwitchDisabledReason(model: string): string | undefined;
  switchModel(model: string): Promise<void>;
}

export type ToolUseFlowSetupCallback = (
  context: ToolUseFlowContext,
) => void | (() => void);

class ToolUsePersistedFlow<C> extends PersistedFlow<
  ToolUseRunShared,
  ToolUseServices<C>
> {
  async prepareForFollowUp(shared: ToolUseRunShared): Promise<void> {
    shared.shouldSkipCycle = true;
    await this.resetNodeHistory(shared);
  }
}

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
  const { streamId, executionId, session: runSession } = runScope;
  // Capture the run's scope at setup. The interrupt closure below fires from
  // the host thread outside the ALS, so it must use this captured session
  // handle instead of asking for an ambient current session later.
  const sessionLifecycle = new ToolUseSessionLifecycle(
    streamId,
    runSession.followUps,
  );
  const baseRegistry = toolRegistry ?? getDefaultToolRegistry();
  const { tools: resolvedTools } = await resolveAgentTools({
    tools: setting.tools,
    registry: baseRegistry,
    logger,
    approvalPromptsUnavailable: runContext.approvalPromptsUnavailable,
    runtimeUnavailableTools: runContext.runtimeUnavailableTools,
    toolInjections: input.toolInjections,
  });
  const overlayTools: ITool[] = [];
  const overlayNames = new Set<string>();
  const appendOverlayTool = (tool: ITool): void => {
    const { name } = tool.definition;
    const definitionIndex = resolvedTools.findIndex(
      (definition) => definition.name === name,
    );
    if (
      overlayNames.has(name) ||
      baseRegistry.has(name) ||
      definitionIndex !== -1
    ) {
      logger.warn(`Run-scoped tool "${name}" shadows an existing tool.`);
    }
    overlayNames.add(name);
    const definition = { ...tool.definition, forceFunctionCall: true };
    if (definitionIndex === -1) {
      resolvedTools.push(definition);
    } else {
      resolvedTools[definitionIndex] = definition;
    }
    overlayTools.push(tool);
  };
  for (const tool of input.tools ?? []) appendOverlayTool(tool);

  // Unforced structured-output floor: when the config declares an output
  // schema, append a synthetic `submit_output` terminal tool to the
  // model-facing list and route lookups for it through a per-run registry
  // overlay. The model finishes by calling the tool; its own Zod schema
  // validates the call (with the existing ZodError -> retry repair), and
  // `capture` records the validated value into this flow-local slot.
  const outputSchema =
    input.config.agentCategory === AgentCategory.ToolUse
      ? input.config.outputSchema
      : undefined;
  let pendingStructuredOutput: ToolUseRunShared['structured'];
  let finalTool: ToolUseServices<C>['finalTool'];
  if (outputSchema) {
    const terminalTool = buildTerminalTool(outputSchema, (value) => {
      pendingStructuredOutput = value;
    });
    finalTool = { name: terminalTool.definition.name };
    appendOverlayTool(terminalTool);
  }
  const registry = overlayTools.length
    ? buildOverlayToolRegistry(baseRegistry, overlayTools)
    : baseRegistry;

  const kv = getExecutionStore(executionId);

  const services: ToolUseServices<C> = {
    ...input,
    setting: { ...setting, tools: resolvedTools },
    session: sessionLifecycle,
    toolRegistry: registry,
    finalTool,
    resumeShared: input.resume?.shared ?? null,
    persistTodos: (todos) => kv.writeTodos(todos),
    getPendingStructuredOutput: () => pendingStructuredOutput,
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

    const nextConfig = getRuntimeModelConfig(model);
    if (!nextConfig) return `Model ${model} is not registered`;

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
    const nextConfig = await resolveRuntimeModelConfig(model);
    if (!nextConfig) {
      throw new Error(`Model ${model} is not registered`);
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
      setting.agentCategory,
      services.runScope.session.responseTextProcessing,
    )) as ToolUseServices<C>['modelHandler'];
    if (!modelHandlersShareConversationFormat(previousHandler, nextHandler)) {
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

  // A resume completes its one-shot handoff immediately after `onSetup`
  // attaches the live context, before the flow is interruptible. An async
  // cancellation racing in during the recovery read must not erase follow-ups
  // appended to the now-live session after attachment --
  // `flowContext.interrupt()` uses the queue-preserving variant for exactly
  // this window, matching `preserveResumeRecord`'s finally guard.
  // Cleared once the flow has passed both guards and moved into real work,
  // so a later mid-run cancellation keeps the normal destructive clear.
  let inResumeStartupWindow = input.resume !== undefined;

  const flowContext: ToolUseFlowContext = {
    ownerSession: runSession,
    session: sessionLifecycle,
    get modelHandler() {
      return services.modelHandler;
    },
    interactions: runSession.interactions,
    get model() {
      return services.config.model;
    },
    interrupt(): void {
      onInterrupt?.();
      runSession.interactions.cancel({ streamId, cause: 'Run interrupted.' });
      if (
        inResumeStartupWindow ||
        (input.isSubagent === true && input.takePendingFollowUps !== undefined)
      ) {
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
  let attachmentFollowUps: readonly FollowUpQueueBatchItem[] = [];
  let preserveResumeRecord = false;
  let persistenceRecoveryPending = false;
  let flowRunStarted = false;
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
    attachmentFollowUps = input.takePendingFollowUps?.() ?? [];
    // A host can hand off a cancellation synchronously during setup. Observe
    // it before touching the persisted resume record.
    if (input.checkInterruption()) {
      preserveResumeRecord = input.resume !== undefined;
      return { outcome };
    }

    persistenceRecoveryPending = true;
    const flowRecord = await readPersistedFlowRecord(kv, executionId);
    // Cancellation can also arrive while the recovery read is pending. Do not
    // start a migration or repair write after that handoff.
    if (input.checkInterruption()) {
      persistenceRecoveryPending = false;
      preserveResumeRecord = input.resume !== undefined;
      return { outcome };
    }
    // Past both startup cancellation guards: any later interrupt() is a
    // genuine mid-run cancellation, so go back to the normal destructive
    // queue clear instead of the resume-startup rescue above.
    inResumeStartupWindow = false;

    if (flowRecord && input.resume) {
      logger.debug('Resuming tool-use flow from persistence');
      // Retrieval owns the single migration/validation boundary. The second
      // read may be self-healed only when it still matches the exact value
      // retrieval observed; any intervening drift must fail loudly instead of
      // being overwritten by the earlier canonical copy.
      if (!isDeepStrictEqual(flowRecord.shared, input.resume.sourceShared)) {
        throw new PersistedFlowStateError(executionId, 'invalid-shared');
      }
      const resumedShared: PreparedShared = {
        ...input.resume.shared,
        ...(input.resume.shared.modelHandlerCompatibilityKey === undefined &&
          compatibilityKey !== undefined && {
            modelHandlerCompatibilityKey: compatibilityKey,
          }),
      };
      if (!isDeepStrictEqual(flowRecord.shared, resumedShared)) {
        flowRecord.shared = resumedShared;
        await kv.write(
          flowKey(executionId),
          stampFlowRecordSchemaVersion(flowRecord),
        );
      }
    } else if (flowRecord) {
      logger.debug('Resuming tool-use flow from persistence');
      const migrationResult = migrateSharedState(flowRecord.shared);
      if (!migrationResult.success) {
        throw new PersistedFlowStateError(executionId, 'invalid-shared', {
          cause: migrationResult.error,
        });
      }
      // Defensive fallback only: no resume handoff means the resume
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
        migratedData.modelHandlerCompatibilityKey ??
        inferAndLogPersistedModelHandlerCompatibilityKey(
          sharedModel,
          migratedData.messages,
          logger,
        ) ??
        compatibilityKey;
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
    // Cleanup may delete a terminal flow record only after absence was
    // confirmed or a present record passed its migration boundary.
    persistenceRecoveryPending = false;

    let resumedFollowUps = [
      ...(input.drainedFollowUps ?? []),
      ...attachmentFollowUps,
    ];
    let finalAction: Awaited<ReturnType<ToolUsePersistedFlow<C>['run']>>;
    do {
      const prepareNode = new ToolUsePrepareNode<C>();
      const cycleNode = new ToolUseCycleNode<C>();
      const waitNode = new ToolUseWaitNode<C>(resumedFollowUps);
      prepareNode.next(cycleNode);
      cycleNode.next(waitNode);
      waitNode.on(FlowTransition.CONTINUE, cycleNode);
      waitNode.on(FlowTransition.WAITING, waitNode);
      const pf = new ToolUsePersistedFlow<C>(
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
      flowRunStarted = true;
      try {
        finalAction = await pf.run(shared);
      } catch (error: unknown) {
        if (input.checkInterruption()) {
          shared = (await pf.getShared()) ?? shared;
          await pf.prepareForFollowUp(shared);
        }
        throw error;
      }
      // Re-read shared from the flow record — PersistedFlow deep-clones the
      // initial shared via structuredClone, so nodes mutate the clone, not the
      // original object. Without this, reads of lastError, messages, etc. below
      // would always see the stale initial values.
      shared = (await pf.getShared()) ?? shared;
      if (finalAction !== FlowTransition.WAITING || input.checkInterruption()) {
        break;
      }

      // Close the live-flow admission boundary before the post-park drain.
      // From this synchronous detach onward, sendFollowUp queues instead of
      // reporting `sent`; the immediately following drain therefore cannot
      // miss input in a gap between its empty check and final teardown.
      teardownSetup?.();
      teardownSetup = undefined;
      resumedFollowUps = [...(input.takePendingFollowUps?.() ?? [])];
      if (resumedFollowUps.length > 0) {
        teardownSetup = onSetup?.(flowContext) ?? undefined;
      }
    } while (resumedFollowUps.length > 0);

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
      const cancelled =
        input.checkInterruption() || Boolean(shared.userCancelledRetry);
      outcome = deriveRunOutcome({
        failed: Boolean(shared.lastError),
        // A retry the user declined ends the run without leaving a
        // `lastError` behind. Counting only `checkInterruption()` here
        // reported that run as COMPLETED while the `finally` below still
        // preserved its record as resumable — a success that is also
        // resumable. `userCancelledRetry` survives only when it is why the
        // run ended: the wait node clears it when a follow-up recovers.
        cancelled,
      });
      if (outcome === RUN_OUTCOME.CANCELLED) {
        await activePersistedFlow?.prepareForFollowUp(shared);
      }
    }
    if (shared.lastError) {
      // Re-throw so runFlowWithLifecycle logs the error and shows
      // the user notification, while preserving terminal run accounting.
      const err = new ToolUseFlowError(shared.lastError.message, {
        outcome,
        lastResponse,
        touchedFiles,
        totalCostUsd,
      });
      throwFlowLastError(err, shared.lastError);
    }
  } finally {
    activePersistedFlow = undefined;
    teardownSetup?.();
    teardownSetup = undefined;
    let preservationReason: string | undefined;
    if (preserveResumeRecord) {
      preservationReason =
        'Flow record preserved after resume startup cancellation';
    } else if (persistenceRecoveryPending) {
      preservationReason =
        'Flow record preserved after persistence recovery failure';
    } else if (outcome === STREAM_PHASE.WAITING) {
      preservationReason = 'Flow record preserved for native subagent WAITING';
    } else if (flowRunStarted && input.checkInterruption()) {
      preservationReason = 'Flow record preserved after user interruption';
    } else if (shared.userCancelledRetry) {
      preservationReason =
        'Flow record preserved for resume after retry cancellation';
    }
    const preserveFlowRecord = preservationReason !== undefined;
    const preserveFollowUpQueue =
      preserveFlowRecord && !persistenceRecoveryPending;

    if (preservationReason) logger.debug(preservationReason);
    input.onFlowRecordDisposition?.(preserveFlowRecord ? 'preserve' : 'delete');
    // AgentRunLifecycle applies this policy with terminal metadata through one
    // storage finalization after the flow reports its outcome.

    // A suspended cursor and a completed parent with live children remain
    // explicitly recoverable. Every other exit is terminal. The lifecycle's
    // generation-scoped release is a no-op for an inner native-child turn,
    // whose child loop retains the sole consumer lease across turns.
    sessionLifecycle.release(
      preserveFollowUpQueue || runSession.executions.hasActiveChildren(streamId)
        ? 'recoverable'
        : 'terminal',
    );
    runSession.interactions.cancel({ streamId, cause: 'Run ended.' });
    for (const handler of switchedHandlers) {
      handler.dispose();
    }
  }

  if (
    outputSchema !== undefined &&
    outcome === RUN_OUTCOME.COMPLETED &&
    shared.structured === undefined
  ) {
    throw new Error(
      'Structured-output run completed without calling submit_output.',
    );
  }

  return {
    outcome,
    lastResponse,
    touchedFiles,
    totalCostUsd,
    structured: shared.structured,
  };
}
