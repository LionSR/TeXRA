// Node imports
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

// Local imports
import { logSdkError } from '@agent/trace';
import { getExecutionStore } from '@agent/storage';
import type { Action } from '@agent/node';
import {
  activeModelHandlerCompatibilityKey,
  createModelHandler,
  modelHandlersShareConversationFormat,
  resolveModelHandlerCompatibilityKey,
} from '@agent/runtime/ModelFactory';
import type { RunModelHandler } from '@agent/runtime/ModelCell';
import { type SessionHandle } from '@agent/runtime/SessionHandle';
import type { SessionHostInteractions } from '@agent/runtime/HostInteractions';
import {
  PersistedFlow,
  PersistedFlowStateError,
  flowKey,
  readPersistedFlowRecord,
  stampCompatibilityKey,
  stampFlowRecordSchemaVersion,
} from '@agent/node/persistedFlow';
import { type AgentToolUseSetting } from '@agent/core/definition/AgentDataclass';
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
import type { RetryErrorInfo, SubagentProgressUpdate } from '@shared/schemas';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  type RunOutcome,
  AgentCategory,
} from '@shared/schemas';
import { deriveRunOutcome } from '@shared/streams/streamStatus';
import { getDefaultToolRegistry } from '@tools/registry';
import {
  buildOverlayToolRegistry,
  buildTerminalTool,
} from '@tools/structuredOutput';
import { TaskRunFileService } from '@utils/files/taskRunStorage';

// Local file imports
import { ToolUsePrepareNode } from './nodes/ToolUsePrepareNode';
import { ToolUseCycleNode } from './nodes/ToolUseCycleNode';
import { ToolUseWaitNode } from './nodes/ToolUseWaitNode';
import {
  extractTouchedFiles,
  migrateSharedState,
  ToolUseRunSharedCanonicalSchema,
  type PreparedShared,
  type ToolUseRunShared,
} from './nodes/types';
import { setToolUseSharedModel } from './modelSwitchState';
import { ToolUseSessionLifecycle } from './ToolUseSessionLifecycle';
import type { ToolUseServices } from './ToolUseServices';

export interface RunToolUseFlowInput<
  C = unknown,
> extends BaseFlowContextInit<C> {
  /** Abort this run's sticky signal. */
  interrupt: () => void;
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
  /**
   * Fires after a running tool-use chat changes its model, once the shared
   * `ModelCell` already holds the new pair. The handler is deliberately not
   * passed: readers take it from the cell. Required because the launch
   * context still owns the persisted `AgentConfig.model` field, which would
   * otherwise keep naming the model the run started with.
   */
  onModelChanged: (model: string) => void;
  /** Runtime feature registry for auto-injected tools. */
  toolInjections?: ToolInjectionRegistry;
  /** Caller-supplied tools available only to this run. */
  tools?: readonly ITool[];
  /** Reports whether terminal finalization should retain the resume record. */
  onFlowRecordDisposition?: (disposition: 'preserve' | 'delete') => void;
}

export interface RunToolUseFlowResult {
  outcome: RunOutcome | typeof STREAM_PHASE.WAITING;
  response?: string;
  /** Workspace-relative paths of files edited by tool calls during this session. */
  files?: string[];
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
  /**
   * The structured provider error behind a FAILED outcome. The run reports its
   * failure here rather than by throwing, so the partial response, touched
   * files, and cost it did produce travel with it.
   */
  error?: RetryErrorInfo;
}

export interface ToolUseFlowContext {
  readonly ownerSession: SessionHandle;
  readonly session: ToolUseSessionLifecycle;
  readonly modelHandler: RunModelHandler;
  readonly interactions: SessionHostInteractions;
  readonly model: string;
  interrupt(): void;
  requestImmediateCompaction(): void;
  modelSwitchDisabledReason(model: string): string | undefined;
  switchModel(model: string): Promise<void>;
}

/**
 * Host wiring that is live only while the flow can accept an interrupt. The
 * flow owns the pairing: every `attach` is followed by exactly one `detach`,
 * including when `attach` itself throws after wiring part of the host up.
 */
export interface ToolUseFlowAttachment {
  attach(context: ToolUseFlowContext): void;
  detach(context: ToolUseFlowContext): void;
}

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
  attachment?: ToolUseFlowAttachment,
): Promise<RunToolUseFlowResult> {
  const { logger, setting, runScope, toolPolicy } = input;
  const { streamId, executionId, session: runSession, signal } = runScope;
  const continuationGenerationId =
    runSession.followUps.currentChildGenerationId(streamId) ??
    input.resume?.shared.continuationGenerationId ??
    randomUUID();
  // Capture the run's scope at setup. The interrupt closure below fires from
  // the host thread outside the ALS, so it must use this captured session
  // handle instead of asking for an ambient current session later.
  const sessionLifecycle = new ToolUseSessionLifecycle(
    streamId,
    runSession.followUps,
    continuationGenerationId,
  );
  const baseRegistry = toolRegistry ?? getDefaultToolRegistry();
  const { tools: resolvedTools } = await resolveAgentTools({
    tools: setting.tools,
    registry: baseRegistry,
    logger,
    approvalPromptsUnavailable: toolPolicy.approvalPromptsUnavailable,
    runtimeUnavailableTools: toolPolicy.runtimeUnavailableTools,
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
  let response: string | undefined;
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
    getPendingStructuredOutput: () => pendingStructuredOutput,
    onCycleResponse: (cycleResponse) => {
      response = cycleResponse;
    },
    fileService: new TaskRunFileService(executionId),
  };
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
    if (services.modelCell.modelId === model) return undefined;

    const nextConfig = getRuntimeModelConfig(model);
    if (!nextConfig) return `Model ${model} is not registered`;

    const activeKey = activeModelHandlerCompatibilityKey(
      services.modelCell.handler,
    );
    if (!activeKey) {
      // Non-factory handlers still reach switchModel's constructor-reference
      // check. Keep the UI permissive rather than guessing their format here.
      return undefined;
    }
    const nextKey = resolveModelHandlerCompatibilityKey(nextConfig);
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
    if (services.modelCell.modelId === model) return;

    const disabledReason = modelSwitchDisabledReason(model);
    if (disabledReason) {
      throw new Error(
        disabledReason === MODEL_SWITCH_DIFFERENT_FORMAT_REASON
          ? MODEL_SWITCH_DIFFERENT_FORMAT_ERROR
          : disabledReason,
      );
    }

    const nextHandler = (await createModelHandler(
      nextConfig,
      services.runScope.session.responseTextProcessing,
    )) as RunModelHandler<C>;
    if (
      !modelHandlersShareConversationFormat(
        services.modelCell.handler,
        nextHandler,
      )
    ) {
      nextHandler.dispose();
      throw new Error(MODEL_SWITCH_DIFFERENT_FORMAT_ERROR);
    }
    // Both persistence writes land before the live swap, so a failed write
    // leaves the run on the model it is already using instead of a model no
    // resume would reconstruct.
    const nextAgentConfig = { ...services.config, model };
    try {
      await persistModelSwitch(model);
      await kv.writeRunRecord(nextAgentConfig);
    } catch (error) {
      nextHandler.dispose();
      throw error;
    }
    nextHandler.setAgentCategory(setting.agentCategory);
    nextHandler.setLogger(logger);

    services.modelCell.swap(nextHandler, model);
    input.onModelChanged(model);
    logger.emit({
      type: 'run.config',
      streamId,
      executionId,
      config: nextAgentConfig,
    });
  };

  // A resume completes its one-shot handoff immediately after the live context
  // is attached, before the flow is interruptible. An async cancellation racing
  // in during the recovery read must not erase follow-ups appended to the
  // now-live session after attachment, so this window asks the lifecycle to
  // preserve the queue, matching `preserveResumeRecord`'s finally guard.
  // Cleared once the flow has passed both guards and moved into real work, so a
  // later mid-run cancellation asks for the normal destructive clear. Whether
  // that clear actually happens is the lifecycle's call: it alone knows whether
  // this flow owns the queue or borrowed an outer consumer's.
  let inResumeStartupWindow = input.resume !== undefined;

  const flowContext: ToolUseFlowContext = {
    ownerSession: runSession,
    session: sessionLifecycle,
    get modelHandler() {
      return services.modelCell.handler;
    },
    interactions: runSession.interactions,
    get model() {
      return services.modelCell.modelId;
    },
    interrupt(): void {
      input.interrupt();
      runSession.interactions.cancel({ streamId, cause: 'Run interrupted.' });
      sessionLifecycle.interrupt(inResumeStartupWindow ? 'preserve' : 'clear');
    },
    requestImmediateCompaction(): void {
      services.modelCell.handler.requestCompaction();
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
  let files: string[] | undefined;
  let totalCostUsd: number | undefined;
  let attachmentFollowUps: readonly FollowUpQueueBatchItem[] = [];
  let preserveResumeRecord = false;
  let persistenceRecoveryPending = false;
  let flowRunStarted = false;
  let primaryFailure: { readonly error: unknown } | undefined;
  let earlyResult: RunToolUseFlowResult | undefined;
  const startupInterruption = new Error('Tool-use startup interrupted.');
  const teardownFailures: Array<{
    readonly operation: string;
    readonly error: unknown;
  }> = [];
  const attemptTeardown = (operation: string, action: () => void): void => {
    try {
      action();
    } catch (error) {
      teardownFailures.push({ operation, error });
    }
  };
  const compatibilityKey = activeModelHandlerCompatibilityKey(
    services.modelCell.handler,
  );

  // The live host attachment, scoped to the windows where this flow can accept
  // an interrupt. `live` flips before `attach` runs, so wiring that throws
  // partway through is still detached by the finally below, and a detach can
  // never fire against an attachment that was already taken down.
  let live = false;
  const liveAttachment = {
    attach(): void {
      if (live) return;
      live = true;
      attachment?.attach(flowContext);
    },
    detach(): void {
      if (!live) return;
      live = false;
      attachment?.detach(flowContext);
    },
  };

  let shared: ToolUseRunShared = {
    messages: [],
    continuationGenerationId,
    modelId: services.modelCell.modelId,
    modelHandlerCompatibilityKey: compatibilityKey,
    shouldSkipCycle: false,
    stateSlices: null,
  };

  try {
    liveAttachment.attach();
    attachmentFollowUps = input.takePendingFollowUps?.() ?? [];
    // A host can hand off a cancellation synchronously during setup. Observe
    // it before touching the persisted resume record.
    if (signal.aborted) {
      preserveResumeRecord = input.resume !== undefined;
      earlyResult = { outcome };
      throw startupInterruption;
    }

    persistenceRecoveryPending = true;
    const flowRecord = await readPersistedFlowRecord(kv, executionId);
    // Cancellation can also arrive while the recovery read is pending. Do not
    // start a migration or repair write after that handoff.
    if (signal.aborted) {
      persistenceRecoveryPending = false;
      preserveResumeRecord = input.resume !== undefined;
      earlyResult = { outcome };
      throw startupInterruption;
    }
    // Past both startup cancellation guards: any later interrupt() is a
    // genuine mid-run cancellation, so go back to the normal destructive
    // queue clear instead of the resume-startup rescue above.
    inResumeStartupWindow = false;

    if (flowRecord) logger.debug('Resuming tool-use flow from persistence');
    if (flowRecord && input.resume) {
      // Retrieval owns the single migration/validation boundary. The second
      // read may be self-healed only when it still matches the exact value
      // retrieval observed; any intervening drift must fail loudly instead of
      // being overwritten by the earlier canonical copy.
      if (!isDeepStrictEqual(flowRecord.shared, input.resume.sourceShared)) {
        throw new PersistedFlowStateError(executionId, 'invalid-shared');
      }
      const resumedShared: PreparedShared = stampCompatibilityKey(
        input.resume.shared,
        compatibilityKey,
      );
      if (!isDeepStrictEqual(flowRecord.shared, resumedShared)) {
        flowRecord.shared = resumedShared;
        await kv.write(
          flowKey(executionId),
          stampFlowRecordSchemaVersion(flowRecord),
        );
      }
    } else if (flowRecord) {
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
      // a stale legacy shape. Model-based compatibility inference for
      // keyless records lives at the resume-retrieval boundary
      // (SessionResumeRetrieval); this path stamps the active handler's key.
      let migratedData = migrationResult.data;
      let shouldWriteShared = migrationResult.migrated;
      if (migratedData.continuationGenerationId !== continuationGenerationId) {
        logger.debug(
          'Rebound leftover tool-use flow state to the fresh continuation generation.',
        );
        migratedData = {
          ...migratedData,
          continuationGenerationId,
        };
        shouldWriteShared = true;
      }
      const backfilled = stampCompatibilityKey(migratedData, compatibilityKey);
      if (backfilled !== migratedData) {
        logger.debug(
          'Backfilled tool-use model-handler compatibility key in shared state.',
        );
        migratedData = backfilled;
        shouldWriteShared = true;
      }
      if (shouldWriteShared) {
        if (migrationResult.migrated) {
          logger.debug('Normalized persisted tool-use shared state');
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

    let resumedFollowUps: readonly FollowUpQueueBatchItem[] = [
      ...(input.drainedFollowUps ?? []),
      ...attachmentFollowUps,
    ];
    let finalAction: Action | undefined;
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
        if (signal.aborted) {
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
      if (finalAction !== FlowTransition.WAITING || signal.aborted) {
        break;
      }

      // Close the live-flow admission boundary before the post-park drain.
      // From this synchronous detach onward, sendFollowUp queues instead of
      // reporting `sent`; the immediately following drain therefore cannot
      // miss input in a gap between its empty check and final teardown.
      liveAttachment.detach();
      resumedFollowUps = input.takePendingFollowUps?.() ?? [];
      if (resumedFollowUps.length > 0) liveAttachment.attach();
    } while (resumedFollowUps.length > 0);

    totalCostUsd =
      shared.stateSlices?.runStateSnapshot.usageAccumulator.totals.totalCost;
    const extractedTouchedFiles = extractTouchedFiles(shared.stateSlices);
    files = extractedTouchedFiles.length ? extractedTouchedFiles : undefined;

    // `FlowTransition.WAITING` is only ever produced by `ToolUseWaitNode`
    // suspending a subagent cycle (see its doc comment) — no further gating
    // needed here; the wait node's own `isSubagent`/`stopAfterCycle` check is
    // the single source of truth for whether a suspension is legitimate.
    // A recorded `lastError` still outranks it: a run that failed is terminal,
    // and reporting it as suspended would park a failure instead of surfacing
    // it (the wait node stops rather than suspends after an error, so this is
    // a guard on the ordering, not a live branch).
    if (finalAction === FlowTransition.WAITING && !shared.lastError) {
      outcome = STREAM_PHASE.WAITING;
    } else {
      const cancelled = signal.aborted || Boolean(shared.userCancelledRetry);
      outcome = deriveRunOutcome({
        failed: Boolean(shared.lastError),
        // A retry the user declined ends the run without leaving a
        // `lastError` behind. Counting only the run signal here
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
    if (
      outputSchema !== undefined &&
      outcome === RUN_OUTCOME.COMPLETED &&
      shared.structured === undefined
    ) {
      throw new Error(
        'Structured-output run completed without calling submit_output.',
      );
    }
  } catch (error) {
    if (error !== startupInterruption) primaryFailure = { error };
  } finally {
    activePersistedFlow = undefined;
    attemptTeardown('detaching the live flow', () => liveAttachment.detach());
    let preservationReason: string | undefined;
    if (preserveResumeRecord) {
      preservationReason =
        'Flow record preserved after resume startup cancellation';
    } else if (persistenceRecoveryPending) {
      preservationReason =
        'Flow record preserved after persistence recovery failure';
    } else if (outcome === STREAM_PHASE.WAITING) {
      preservationReason = 'Flow record preserved for native subagent WAITING';
    } else if (flowRunStarted && signal.aborted) {
      preservationReason = 'Flow record preserved after user interruption';
    } else if (shared.userCancelledRetry) {
      preservationReason =
        'Flow record preserved for resume after retry cancellation';
    }
    const preserveFlowRecord = preservationReason !== undefined;
    const preserveFollowUpQueue =
      preserveFlowRecord && !persistenceRecoveryPending;

    if (preservationReason) logger.debug(preservationReason);
    attemptTeardown('reporting flow-record disposition', () =>
      input.onFlowRecordDisposition?.(
        preserveFlowRecord ? 'preserve' : 'delete',
      ),
    );
    // AgentRunLifecycle applies this policy with terminal metadata through one
    // storage finalization after the flow reports its outcome.

    // A suspended cursor and a completed parent with live children remain
    // explicitly recoverable. Every other exit is terminal. The lifecycle's
    // generation-scoped release is a no-op for an inner native-child turn,
    // whose child loop retains the sole consumer lease across turns.
    attemptTeardown('releasing the follow-up queue', () =>
      sessionLifecycle.release(
        preserveFollowUpQueue ||
          runSession.executions.hasActiveChildren(streamId)
          ? 'recoverable'
          : 'terminal',
      ),
    );
    // Pending host interactions are cancelled by `runFlowWithLifecycle`'s
    // finally, which runs after this one — the same order this flow used when
    // it cancelled them itself, so a queue release still happens first.
  }

  // A failure the run already holds — thrown out of the flow, or recorded in
  // `lastError` and carried on the result — outranks a teardown failure. Both
  // cases report every teardown problem to the log and let the run's own error
  // reach the caller; only an otherwise successful exit surfaces a teardown
  // failure as the run's failure.
  const carriedError = shared.lastError;
  const runAlreadyFailed =
    primaryFailure !== undefined || carriedError !== undefined;
  const [firstTeardownFailure, ...restTeardownFailures] = teardownFailures;
  const failuresToLog = runAlreadyFailed
    ? teardownFailures
    : restTeardownFailures;
  for (const failure of failuresToLog) {
    logSdkError(
      logger,
      `Tool-use teardown failed while ${failure.operation}`,
      failure.error,
    );
  }
  if (primaryFailure) throw primaryFailure.error;
  if (!runAlreadyFailed && firstTeardownFailure) {
    throw firstTeardownFailure.error;
  }
  if (earlyResult) return earlyResult;

  return {
    outcome,
    response,
    files,
    totalCostUsd,
    structured: shared.structured,
    ...(carriedError ? { error: carriedError } : {}),
  };
}
