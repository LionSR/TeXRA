import * as path from 'node:path';

import { ZodError } from 'zod';
import { MODEL_CONFIGS, ModelProvider } from 'llm-zoo';

import { createRunTrace, type RunTrace } from '@transcript';
import {
  isRemoteAgent,
  resolveAgentForLaunch,
  type ResolvedAgent,
} from '@agent/index';
import {
  logSdkError,
  logUserMessage,
  type AgentTrace,
  type StageHandle,
} from '@agent/trace';
import { getExecutionStore } from '@agent/storage';
import type {
  AgentCore,
  AgentRunIdentity,
} from '@agent/core/flows/BaseFlowServices';
import {
  AgentConfigSchema,
  type AgentConfig,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { UserVariableChannels } from '@agent/core/definition/AgentCycleOptions';
import {
  AttachedMemoryMissesSchema,
  type AttachedMemoryMiss,
} from '@agent/types/AttachedMemory';
import { loadAgentSettingAndPrompts } from '@agent/runtime/agentLoad';
import {
  createModelHandler,
  createModelHandlerForCompatibilityKey,
} from '@agent/runtime/ModelFactory';
import type { ModelHandlerCompatibilityKey } from '@agent/runtime/modelHandlerCompatibilityKey';
import { inferPersistedFlowModelHandlerCompatibilityKey } from '@agent/runtime/modelHandlerCompatibilityInference';
import { flowKey, type FlowRecord } from '@agent/node/persistedFlow';
import { buildUserVars } from '@agent/utils/userVars';
import { UsageMonitor } from '@agent/utils/UsageMonitor';
import { AgentError, getSdkErrorMessage } from '@common/errors';
import { normalizeRunId } from '@common/constants/runIds';
import { INSTRUCTION_ACTION } from '@shared/schemas';
import {
  STREAM_PHASE,
  STREAM_SUBSTATE,
  type ExecutionId,
  type StorageKey,
  type StreamTabId,
} from '@shared/schemas';
import type { AgentSource } from '@shared/schemas/agent';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { generateExecutionId } from '@utils/core/executionId';

import {
  createRunContext,
  withRunContext,
  type CreateRunContextOptions,
} from './RunContext';
import {
  countMediaFilesNeedingVision,
  formatMediaNeedsVisionWarning,
  mediaAttachmentKinds,
  shouldWarnMediaNeedsVision,
} from './mediaVisionWarning';
import { getStreamTabId } from './streamTab';
import { currentSession, type SessionHandle } from './SessionHandle';
import { attachConversationProgressHub } from './conversationProgressHub';
import type { StreamStatusMachine } from './StreamStatusService';
import type { ToolEditApprovalPort } from '@platform/interfaces/toolEditApproval';
import type { AgentRuntimeHost } from './AgentRuntimeHost';

export interface AgentLaunchContext extends AgentCore, AgentRunIdentity {
  usageMonitor: UsageMonitor;
  storageKey: StorageKey;
  parentStage: StageHandle;
  streamStatus: StreamStatusMachine;
  attachedMemoryMisses: AttachedMemoryMiss[];
  /** Whether this tool-use run exits after one cycle instead of idling. */
  stopAfterCycle?: boolean;
  /**
   * Per-run override for the host's tool-edit approval UI, projected onto the
   * ambient {@link RunContext}. See `RunContext.toolEditApprovalHandler`.
   */
  toolEditApprovalHandler?: ToolEditApprovalPort;
  /**
   * Session that owns this run's coordination state. Always populated by
   * {@link buildAgentLaunchContext} (defaults to `currentSession()` — the
   * parent run's session for a delegated launch, the process default for a root
   * launch) — hence required here, unlike the optional
   * {@link AgentLaunchInput.session} launch param — and projected into the
   * ambient {@link RunContext} so run-scoped code resolves it via
   * `currentSession()`.
   */
  session: SessionHandle;
  /**
   * Dispose the run-trace subscribers (channel sink + transcript recorder)
   * registered by {@link createRunTrace}. Must be called once at end-of-run
   * to avoid leaking entries in the module-global `activeFlushers` set and
   * keeping subscribers attached to the trace emitter.
   */
  disposeTrace: () => void;
}

export interface AgentLaunchInput {
  configPayload: AgentConfigPayload;
  executionId?: ExecutionId;
  runtimeHost: AgentRuntimeHost;
  streamTabIdOverride?: StreamTabId;
  taskType?: string;
  /** Fires after streamId is assigned but before setActiveStream is emitted. */
  onBeforeActivation?: (streamId: StreamTabId) => void;
  /** When true, reject if configPayload.agentCategory doesn't match the YAML-defined category. */
  enforceCategory?: boolean;
  /** Skip the `requestShowError` toast -- for callers that show their own UI. */
  suppressErrorNotification?: boolean;
  /** Session owning this run's coordination state. Defaults to the launcher's session (`currentSession()`). */
  session?: SessionHandle;
  /** Resume using this persisted provider-message format instead of today's default route. */
  modelHandlerCompatibilityKey?: ModelHandlerCompatibilityKey | null;
}

const STATUS_MESSAGES: Record<string, string> = {
  [STREAM_SUBSTATE.STARTING]: 'already launching',
  [STREAM_SUBSTATE.RESUMING]: 'resuming',
  [STREAM_PHASE.RUNNING]: 'already running',
  [STREAM_PHASE.WAITING]: 'waiting for retry',
  [STREAM_PHASE.COMPLETED]: 'completed',
  [STREAM_PHASE.CANCELLED]: 'stopped',
  [STREAM_PHASE.FAILED]: 'failed',
};

/**
 * Project an {@link AgentLaunchContext} onto the subset of fields that belong
 * in the ambient {@link RunContext}.
 *
 * This is the single owner of the launch-context → ambient-context mapping, so
 * new per-run flags (e.g. `stopAfterCycle`, `approvalPromptsUnavailable`,
 * `runtimeUnavailableTools`) live in one place and are never silently dropped.
 * The ambient context is intentionally a flat projection, so two fields are
 * renamed from their nested `AgentCore` positions:
 *  - `AgentConfig.agent`  → `RunContext.agentName`
 *  - `AgentConfig.model`  → `RunContext.model`
 *
 * `RunContext.model` reads through `getModel` so tools observe model switches
 * applied to `AgentLaunchContext.config.model` during an interactive session.
 */
function agentContextToRunContext(
  ctx: AgentLaunchContext,
): CreateRunContextOptions {
  return {
    runtimeHost: ctx.runtimeHost,
    streamId: ctx.streamId,
    executionId: ctx.executionId,
    modelSource: 'live' as const,
    getModel: () => ctx.config.model,
    agentName: ctx.config.agent,
    workingDirectory: ctx.workingDirectory,
    delegationDepth: ctx.delegation?.delegationDepth,
    approvalPromptsUnavailable: ctx.delegation?.approvalPromptsUnavailable,
    runtimeUnavailableTools: ctx.runtimeUnavailableTools,
    stopAfterCycle: ctx.stopAfterCycle,
    session: ctx.session,
    toolEditApprovalHandler: ctx.toolEditApprovalHandler,
  };
}

export async function withExecutionRunContext<T>(
  ctx: AgentLaunchContext,
  fn: () => T | Promise<T>,
): Promise<T> {
  return await withRunContext(
    createRunContext(agentContextToRunContext(ctx)),
    fn,
  );
}

export async function getAgentPath(
  agentIdentifier: string,
  runtimeHost: AgentRuntimeHost,
  category: AgentCategory,
  source?: AgentSource | null,
): Promise<ResolvedAgent> {
  // Single launch resolution rule (see resolveAgentForLaunch): exact
  // (source, name) when the delegation pinned one, else the same visible-set
  // resolver validation uses, else the full set for internal agents. Never
  // blind source-priority on a bare name, so launch can't diverge from
  // what was validated.
  const result = resolveAgentForLaunch(category, agentIdentifier, source);
  if (result) return result;

  runtimeHost.emit('showAgentConfigBanner', { agentName: agentIdentifier });
  throw new AgentError(`Could not find agent: ${agentIdentifier}`);
}

async function validateModelExists(
  modelName: string,
  runtimeHost: AgentRuntimeHost,
): Promise<void> {
  if (modelName in MODEL_CONFIGS) return;

  runtimeHost.emit('requestShowInstruction', {
    key: 'modelNotRecognized',
    message: `Model "${modelName}" is not recognized. Review the documentation for supported models.`,
    actions: [INSTRUCTION_ACTION.OPEN_MODELS_DOC],
    showSuppress: false,
  });
  throw new AgentError(`Model ${modelName} not found in MODEL_CONFIGS`);
}

async function inferLaunchModelHandlerCompatibilityKey(
  executionId: ExecutionId,
  model: string,
): Promise<ModelHandlerCompatibilityKey | undefined> {
  try {
    const flowRecord = await getExecutionStore(executionId).read<FlowRecord>(
      flowKey(executionId),
    );
    return inferPersistedFlowModelHandlerCompatibilityKey(
      model,
      flowRecord?.shared,
    );
  } catch {
    return undefined;
  }
}

/**
 * Create a "Run:" stage, optionally logging a user instruction first.
 *
 * ORDERING INVARIANT: The instruction is emitted BEFORE the stage is created.
 * At this point no group context exists, so the message gets no groupId and
 * its timestamp precedes the stage's startTime. The chronological timeline
 * therefore renders the instruction before the run group.
 *
 * ROOT INVARIANT: each run trace owns its stage scope (per-instance
 * AsyncLocalStorage in TraceEmitter), so this opens as a root — it cannot
 * inherit a cross-trace ambient stage from a parent run (e.g. an
 * orchestrator's tool-use stage when this is a subagent). That isolation is
 * what keeps a subagent's "Run:"/Init/r0/r1 subtree from orphaning in its own
 * transcript. See docs/proposals/progress-grouping-refactor.md (R1).
 */
async function beginRunStage(
  agentLogger: AgentTrace,
  label: string,
  instruction: string | undefined,
  mediaFiles: readonly string[] | undefined,
): Promise<StageHandle> {
  if (instruction) {
    logUserMessage(agentLogger, instruction, mediaAttachmentKinds(mediaFiles));
  }
  return agentLogger.openStage(label, { kind: 'run' });
}

async function assembleAgentLaunchContext(
  input: AgentLaunchInput,
  executionId: ExecutionId,
  streamStatus: StreamStatusMachine,
  runtimeHost: AgentRuntimeHost,
  reservedStreamId: StreamTabId | undefined,
  onActivated: (streamId: StreamTabId) => void,
  onRunTraceCreated: (runTrace: RunTrace) => void,
): Promise<AgentLaunchContext> {
  const { configPayload } = input;
  const fullConfig = AgentConfigSchema.parse(configPayload);
  // Resolve by the source the delegation captured at validation time, so launch
  // lands on the exact entry validation/display resolved. When no source is
  // pinned (direct launches, restored records), resolution falls to the
  // category-scoped rule validation uses — never blind name resolution.
  const resolution = await getAgentPath(
    fullConfig.agent,
    runtimeHost,
    fullConfig.agentCategory,
    fullConfig.agentSource,
  );
  // `loadAgentSettingAndPrompts` already applies `ensureAgentCategoryForSource`
  // before parsing, and `AgentSettingSchema` prefaults `agentCategory` (to
  // Workflow when absent), so `setting.agentCategory` is always populated here —
  // a second `ensureAgentCategoryForSource` pass would be a guaranteed no-op.
  const [setting, prompt] = await loadAgentSettingAndPrompts(resolution);

  // Block category mismatch: prevent launching a tool-use agent as a workflow
  // (or vice versa). Source-pinned resolution already guarantees launch lands on
  // the entry validation chose, so this catches only the residual case the
  // registry's pre-merge category can't see: a child agent that `inherits` a
  // parent of the other category resolves with the scanner's pre-merge category
  // (used by getVisibleAgent) but loads a post-merge `setting.agentCategory`
  // that differs. Only enforced when the caller opts in via enforceCategory,
  // because many code paths pass pre-parsed configs where agentCategory was
  // prefaulted to Workflow by the schema (not explicitly chosen by the caller).
  if (
    input.enforceCategory &&
    configPayload.agentCategory &&
    configPayload.agentCategory !== setting.agentCategory
  ) {
    const suggestion =
      setting.agentCategory === AgentCategory.ToolUse
        ? 'delegate_agent'
        : 'delegate_workflow';
    throw new AgentError(
      `Agent '${fullConfig.agent}' is a ${setting.agentCategory} agent but was launched as ${configPayload.agentCategory}. Use ${suggestion} instead.`,
    );
  }

  await validateModelExists(fullConfig.model, runtimeHost);

  const config: AgentConfig = {
    ...fullConfig,
    agentCategory: setting.agentCategory,
  };

  const modelConfig = MODEL_CONFIGS[fullConfig.model];
  const modelHandlerCompatibilityKey =
    input.modelHandlerCompatibilityKey ??
    (await inferLaunchModelHandlerCompatibilityKey(executionId, config.model));
  const modelHandler = modelHandlerCompatibilityKey
    ? await createModelHandlerForCompatibilityKey(
        modelConfig,
        modelHandlerCompatibilityKey,
      )
    : await createModelHandler(modelConfig);

  const streamId =
    input.streamTabIdOverride ??
    reservedStreamId ??
    getStreamTabId(config.agent, fullConfig.model, { executionId });

  // `currentSession()` (not `defaultSession()`): a delegated launch runs inside
  // the parent run's ALS, so it inherits the parent's session; a root launch
  // runs outside any ALS, so it resolves to the process default. Either way the
  // child is tracked in the same session as its launcher.
  const session = input.session ?? currentSession();
  const rawRunTrace = createRunTrace(
    streamId,
    session.transcripts,
    session.flushers,
  );
  const detachSessionTrace = session.attachRunTrace(
    rawRunTrace.trace,
    streamId,
  );
  const detachProgressHub = attachConversationProgressHub(
    session.events,
    runtimeHost,
    streamId,
  );
  const runTrace: RunTrace = {
    trace: rawRunTrace.trace,
    dispose: () => {
      detachProgressHub();
      detachSessionTrace();
      rawRunTrace.dispose();
    },
  };
  onRunTraceCreated(runTrace);
  const agentLogger = runTrace.trace;
  modelHandler.setAgentCategory(setting.agentCategory);
  modelHandler.setLogger(agentLogger);

  session.events.assertRunSubscribersAttachedBeforeActivation(streamId);
  input.onBeforeActivation?.(streamId);

  runtimeHost.emit('setActiveStream', {
    streamId,
    agentCategory: setting.agentCategory,
    isRemote: isRemoteAgent(fullConfig.agent),
  });
  onActivated(streamId);

  // Log the initial instruction as a user message so both workflow and
  // tool-use tabs display it inline with the stream log (no separate panel).
  const displayInstruction =
    config.displayInstruction == null
      ? config.instruction?.trim()
      : config.displayInstruction.trim();
  const initialInstruction =
    displayInstruction && !input.streamTabIdOverride
      ? displayInstruction
      : undefined;

  const parentStage = await beginRunStage(
    agentLogger,
    `Run: ${config.agent}`,
    initialInstruction,
    config.mediaFiles,
  );
  const storageKey: StorageKey = parentStage.id
    ? normalizeRunId(parentStage.id)
    : (executionId as StorageKey);

  // Tell the user when attached images will be dropped because the chosen model
  // lacks vision. The downstream initializeMessages/addMediaToUserMessage guards
  // drop them silently otherwise.
  const visionMediaCount = countMediaFilesNeedingVision(config.mediaFiles);
  if (
    shouldWarnMediaNeedsVision(config.mediaFiles, modelHandler.capabilities)
  ) {
    agentLogger.warn(
      formatMediaNeedsVisionWarning(
        visionMediaCount,
        'attached',
        fullConfig.model,
      ),
    );
  }

  const agentPath = path.dirname(resolution.definitionPath);
  const buildVars = () =>
    buildUserVars(
      config,
      setting,
      prompt,
      agentPath,
      {
        isOpenai: modelHandler.config.provider === ModelProvider.OPENAI,
        isAnthropic: modelHandler.config.provider === ModelProvider.ANTHROPIC,
        isGoogle: modelHandler.config.provider === ModelProvider.GOOGLE,
      },
      agentLogger,
    );

  const baseVars =
    setting.agentCategory === AgentCategory.ToolUse
      ? await buildVars()
      : await parentStage.child('Init').run(buildVars);

  const userVarChannels: UserVariableChannels = {
    input: Object.freeze(baseVars),
    transient: { ...baseVars },
  };
  const attachedMemoryMisses = AttachedMemoryMissesSchema.parse(
    baseVars.ATTACHED_MEMORY_MISSES,
  );

  const usageMonitor = new UsageMonitor(
    { capabilities: modelHandler.capabilities, config: modelHandler.config },
    { logger: agentLogger, runtimeHost, storageKey, streamId },
    {
      agentName: config.agent,
      agentCategory: setting.agentCategory,
    },
  );

  return {
    config,
    setting,
    prompt,
    modelHandler,
    streamId,
    executionId,
    logger: agentLogger,
    parentStage,
    storageKey,
    userVarChannels,
    attachedMemoryMisses,
    usageMonitor,
    runtimeHost,
    streamStatus,
    workingDirectory: configPayload.workingDirectory?.trim() || undefined,
    session,
    disposeTrace: runTrace.dispose,
  };
}

function acquireStreamOrThrow(
  streamId: StreamTabId,
  streamStatus: StreamStatusMachine,
  runtimeHost: AgentRuntimeHost,
  taskType: string = 'Task',
): void {
  if (
    streamStatus.tryAcquire(streamId, {
      runtimeHost,
    })
  ) {
    return;
  }

  const substate = streamStatus.getSubstate(streamId);
  const status =
    substate === STREAM_SUBSTATE.STARTING ||
    substate === STREAM_SUBSTATE.RESUMING
      ? substate
      : (streamStatus.get(streamId) ?? '');
  const statusMsg = STATUS_MESSAGES[status] || 'already running';
  throw new AgentError(
    `${taskType} "${streamId}" is ${statusMsg}. Please wait for it to complete or stop it first.`,
  );
}

/**
 * Saga-style compensation for a failed stream activation.
 *
 *  - Pre-activation failure (no `activatedStreamId`): the UI tab was never
 *    registered. Release the reserved lock if we held it, and publish a
 *    terminal rollback only if acquisition already emitted a visible status.
 *
 *  - Post-activation failure (`activatedStreamId` set): the UI tab is
 *    visible. Surface the failure on it and transition to FAILED so the
 *    tab doesn't hang in STARTING.
 */
function compensateFailedActivation(args: {
  configPayload: AgentConfigPayload;
  reservedStreamId?: StreamTabId;
  activatedStreamId?: StreamTabId;
  streamStatus: StreamStatusMachine;
  runtimeHost: AgentRuntimeHost;
  err: unknown;
  // The run-trace from assembleAgentLaunchContext when it was created before the
  // throw. Reused for the error log so we don't allocate a second one; outer
  // catch disposes it after this returns.
  runTrace?: RunTrace;
}): void {
  const {
    configPayload,
    reservedStreamId,
    activatedStreamId,
    streamStatus,
    runtimeHost,
    err,
    runTrace,
  } = args;

  if (activatedStreamId) {
    // `activatedStreamId` is set only after `runTrace` is created in
    // `assembleAgentLaunchContext`, so runTrace is always present here in
    // practice. Guard for defensiveness.
    if (runTrace) {
      logSdkError(
        runTrace.trace,
        `Failed to start agent ${configPayload.agent}: ${getSdkErrorMessage(err)}`,
        err,
        { operation: `start ${configPayload.agent}` },
      );
    }
    if (
      !streamStatus.transitionToTerminal(
        activatedStreamId,
        STREAM_PHASE.FAILED,
        {
          runtimeHost,
          trace: runTrace?.trace,
        },
      )
    ) {
      runTrace?.trace.warn('Failed to mark activation failure terminal', {
        data: {
          agentIdentifier: configPayload.agent,
          streamId: activatedStreamId,
        },
      });
    }
    return;
  }

  if (reservedStreamId) {
    streamStatus.releaseIfReserved(reservedStreamId, {
      runtimeHost,
    });
  }
}

/**
 * Resolves agent context and reserves the final stream id before the UI is
 * activated.
 *
 * Treats the `setActiveStream` emission as a transactional commit point:
 * resolution failures before that point release the lock silently; failures
 * after surface on the visible tab via {@link compensateFailedActivation}.
 */
export async function buildAgentLaunchContext(
  input: AgentLaunchInput,
): Promise<AgentLaunchContext> {
  const { configPayload, runtimeHost } = input;
  const launchSession = input.session ?? currentSession();
  const streamStatus = launchSession.status;
  const executionId = input.executionId ?? generateExecutionId();
  if (
    !input.streamTabIdOverride &&
    (!configPayload.agent || !configPayload.model)
  ) {
    throw new AgentError('Missing required fields: model and/or agent');
  }

  const reservedStreamId = input.streamTabIdOverride
    ? undefined
    : getStreamTabId(configPayload.agent, configPayload.model, { executionId });
  if (reservedStreamId) {
    acquireStreamOrThrow(
      reservedStreamId,
      streamStatus,
      runtimeHost,
      input.taskType,
    );
  }

  let activatedStreamId: StreamTabId | undefined;
  // Captured so the outer catch can dispose the trace and let
  // `compensateFailedActivation` reuse it for the failure log. Released to the
  // returned context on the success path (cleaned up by runFlowWithLifecycle).
  let runTrace: RunTrace | undefined;
  try {
    const ctx = await assembleAgentLaunchContext(
      { ...input, session: launchSession },
      executionId,
      streamStatus,
      runtimeHost,
      reservedStreamId,
      (streamId) => {
        activatedStreamId = streamId;
      },
      (rt) => {
        runTrace = rt;
      },
    );
    return ctx;
  } catch (err) {
    compensateFailedActivation({
      configPayload,
      reservedStreamId,
      activatedStreamId,
      streamStatus,
      runtimeHost,
      err,
      runTrace,
    });
    runTrace?.dispose();
    if (!input.suppressErrorNotification && !(err instanceof ZodError)) {
      runtimeHost.emit('requestShowError', {
        message: toErrorMessage(err),
      });
    }
    throw err;
  }
}
