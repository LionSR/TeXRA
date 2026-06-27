// Chat-session controller: owns run start/resume/stop/follow-up state-transition
// orchestration for the CLI chat session. Host-neutral (no Ink/TUI rendering
// dependencies) — the Ink component consumes narrow commands exposed here.
//
// Extracted from runChatTui.tsx per #6328 so that UI rendering, command
// parsing, runtime orchestration, and persistence rules evolve independently.

import { setTimeout as sleep } from 'node:timers/promises';

import PQueue from 'p-queue';

import { tryPlatform } from '@platform/platform';
import { getDefaultStreamLogStore, StreamSnapshotStore } from '@transcript';
import { registerExecution, writeTerminalStatus } from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfig,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  executeAgent,
  resumeToolUseFromSnapshot,
} from '@agent/runtime/executeAgent';
import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { attachTerminalResultToast } from '@agent/runtime/terminalResultToast';
import {
  notifyFollowUpSent,
  sendFollowUp,
  type SendFollowUpResult,
} from '@agent/followUp/ToolUseFollowUp';
import type { FollowUpQueueInput } from '@agent/followUp/FollowUpQueue';
import { ToolUseFollowUpQueue } from '@agent/followUp/ToolUseFollowUpQueueManager';
import { type CliContext } from '@cli/runtime/cliContext';
import { approvalPromptsUnavailable } from '@cli/runtime/approvalPolicyAvailability';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { setCliHelperModel } from '@cli/runtime/initPlatform';
import { createCliRuntimeHost } from '@cli/runtime/runtimeHost';
import {
  explainNonResumable,
  resolveCliResumeSnapshot,
  type CliToolUseResumeResolution,
} from '@cli/runtime/sessionResume';
import {
  cliTerminalStatus,
  terminalStatusExitCode,
} from '@cli/runtime/terminalStatus';
import { CLI_UNAVAILABLE_TOOLS } from '@cli/runtime/unavailableTools';
import { toErrorMessage } from '@common/errors/errorMessage';
import {
  EXECUTION_STATUS,
  type ExecutionId,
  type StreamStatus,
  type StreamTabId,
  sumUsageStats,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { generateExecutionId } from '@utils/core/executionId';

import { chatAgentSupportsDelegation } from './tui/commands/handlers/agentModelCommands';
import { clearApprovals } from './tui/state/approvalQueue';
import { cliState, patchStream } from './tui/state/cliState';
import {
  chatTuiCanSelectModel,
  chatTuiCanStartRootRun,
  markChatTuiRunCompleted,
  markChatTuiRunPending,
  publishChatTuiRootRunStartAvailability,
  type TuiSession,
} from './tui/state/sessionRunState';
import { installTuiApprovals } from './tui/state/subscribeApprovals';
import { wrapRuntimeHost } from './tui/state/subscribeRuntimeHost';
import { notify } from './tui/notifications/terminalNotifier';
import {
  appendLocalErrorTranscript,
  appendLocalAssistantTranscript,
  clearLocalTranscript,
  moveLocalTranscriptToStream,
} from './tui/state/transcript';
import { projectStreamTranscript } from './tui/state/transcriptProjection';

// ---------------------------------------------------------------------------
// Reusable config builders & execution-registration helpers
// (moved from runChatTui.tsx — host-neutral, no Ink dependency)
// ---------------------------------------------------------------------------

export interface BuildInitialChatAgentConfigInput {
  readonly agent: string;
  readonly model: string;
  readonly instruction: string;
  readonly displayInstruction?: string;
  readonly workingDirectory: string;
  readonly mediaFiles?: readonly string[];
  readonly cliMultiAgentPresetId?: string;
}

export function buildInitialChatAgentConfig({
  agent,
  model,
  instruction,
  displayInstruction,
  workingDirectory,
  mediaFiles,
  cliMultiAgentPresetId,
}: BuildInitialChatAgentConfigInput): AgentConfigPayload {
  return {
    agent,
    model,
    instruction,
    ...(displayInstruction !== undefined ? { displayInstruction } : {}),
    agentCategory: AgentCategory.ToolUse,
    workingDirectory,
    ...(mediaFiles?.length ? { mediaFiles: [...mediaFiles] } : {}),
    ...(cliMultiAgentPresetId ? { cliMultiAgentPresetId } : {}),
  };
}

export async function registerFreshChatExecution(
  executionId: ExecutionId,
  configPayload: AgentConfigPayload,
): Promise<AgentConfig> {
  const config = AgentConfigSchema.parse(configPayload);
  await registerExecution(executionId, config, config.agent);
  return config;
}

export async function markRegisteredChatExecutionError(
  executionId: ExecutionId,
  options: {
    readonly executionRegistered: boolean;
    readonly agentSettled: boolean;
  },
): Promise<void> {
  if (!options.executionRegistered || options.agentSettled) return;
  await writeTerminalStatus(executionId, EXECUTION_STATUS.ERROR);
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * Narrow commands the chat-session controller exposes to the Ink component.
 * Every mutation to {@link TuiSession} flows through one of these methods so
 * the Ink layer never directly mutates session run-state fields.
 */
export interface ChatSessionController {
  /** Start a new root agent run from a fresh config. */
  startRootRun(config: AgentConfigPayload): void;

  /**
   * Resume a suspended tool-use session by execution id.
   *
   * Fire-and-forget from the Ink perspective — the returned promise settles
   * when the resume resolution and rehydration are complete, but the
   * continued run itself stays pending until the agent finishes or suspends.
   */
  resume(
    id: ExecutionId,
    preResolved?: CliToolUseResumeResolution,
  ): Promise<void>;

  /** Request stop of the active run (idempotent). */
  stop(): void;

  /** Request termination of a child execution shown by the TUI. */
  killExecution(executionId: string): void;

  /** Whether a new root run can be started right now. */
  canStartRootRun(): boolean;

  /** Whether the active model can be changed in the current run state. */
  canSelectModel(): boolean;

  /** Explain why a model is unavailable for the active tool-use flow. */
  getModelSwitchDisabledReason(candidateModel: string): string | undefined;

  /** Switch the active tool-use flow to a different model. */
  switchActiveModel(model: string): Promise<ChatModelSwitchResult>;

  /** Request manual compaction of the active tool-use flow. */
  requestCompaction(
    streamId: StreamTabId | undefined,
  ): ChatCompactionRequestResult;

  /** Clear queued follow-up deliveries that have not started yet. */
  clearPendingFollowUps(): void;

  /** Queue a follow-up for serialized delivery to the active stream. */
  submitFollowUp(input: ChatFollowUpInput): Promise<ChatFollowUpDeliveryResult>;

  /** Resolve once the queued follow-up delivery path is idle. */
  awaitFollowUpsIdle(): Promise<void>;
}

export interface ChatSessionControllerInit {
  /** Mutable session state the controller owns. */
  readonly session: TuiSession;

  /** Build a {@link CliContext} keyed on the current model. */
  readonly getSessionContext: (model: string) => CliContext;

  /** Disposer list shared with the TUI lifecycle. */
  readonly disposers: Array<() => void>;

  /** Per-stream sidecar persistence store. */
  readonly snapshotStore: StreamSnapshotStore;

  /** Runtime session that owns executions, coordinators, and subscriptions. */
  readonly runtimeSession?: SessionHandle;
}

export type ChatModelSwitchResult =
  | { readonly status: 'switched'; readonly model: string }
  | {
      readonly status: 'switched_default_update_failed';
      readonly model: string;
      readonly error: string;
    }
  | { readonly status: 'no_active_tool_use' };

export type ChatCompactionRequestResult =
  | { readonly status: 'requested' }
  | { readonly status: 'no_active_tool_use' }
  | { readonly status: 'unsupported' };

export interface ChatFollowUpInput {
  readonly targetStreamId?: StreamTabId;
  readonly followUp: string | FollowUpQueueInput;
  readonly mediaFiles?: readonly string[];
  readonly displayText?: string;
}

export type ChatFollowUpDeliveryResult =
  | SendFollowUpResult
  | { readonly status: 'not_delivered' };

export function createChatSessionController(
  init: ChatSessionControllerInit,
): ChatSessionController {
  const { session, getSessionContext, disposers, snapshotStore } = init;
  const followUpQueue = new PQueue({ concurrency: 1 });
  const runtimeSession = init.runtimeSession ?? defaultSession();

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  const interruptActiveRun = (): void => {
    clearApprovals();
    if (!session.streamId) return;
    runtimeSession.executions.stopAgentStream(session.streamId, {
      detachActiveChildren:
        tryPlatform()?.workspaceState.get<boolean>(
          WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
          false,
        ) === true,
      runtimeHost: session.runtimeHost,
    });
  };

  const activeToolUseFlow = () =>
    session.streamId
      ? runtimeSession.executions.getToolUseFlowContext(session.streamId)
      : undefined;

  const rootStreamStatus = (): StreamStatus | undefined =>
    session.streamId
      ? cliState.streams.get().get(session.streamId)?.status
      : undefined;

  const hasActiveToolUseFlow = (): boolean => Boolean(activeToolUseFlow());

  const canSelectModel = (): boolean =>
    chatTuiCanSelectModel({
      canStartRootRun: chatTuiCanStartRootRun(session),
      streamId: session.streamId,
      status: rootStreamStatus(),
      hasActiveToolUseFlow: hasActiveToolUseFlow(),
    });

  const getModelSwitchDisabledReason = (
    candidateModel: string,
  ): string | undefined => {
    if (chatTuiCanStartRootRun(session) || !canSelectModel()) {
      return undefined;
    }
    return activeToolUseFlow()?.modelSwitchDisabledReason(candidateModel);
  };

  const switchActiveModel = async (
    nextModel: string,
  ): Promise<ChatModelSwitchResult> => {
    const activeFlow = activeToolUseFlow();
    if (!activeFlow) return { status: 'no_active_tool_use' };

    await activeFlow.switchModel(nextModel);
    try {
      await setCliHelperModel(nextModel);
    } catch (error: unknown) {
      return {
        status: 'switched_default_update_failed',
        model: nextModel,
        error: toErrorMessage(error),
      };
    }
    return { status: 'switched', model: nextModel };
  };

  const requestCompaction = (
    streamId: StreamTabId | undefined,
  ): ChatCompactionRequestResult => {
    const flowContext = streamId
      ? runtimeSession.executions.getToolUseFlowContext(streamId)
      : undefined;
    if (!streamId || !flowContext) return { status: 'no_active_tool_use' };
    if (!flowContext.modelHandler.supportsManualCompaction) {
      return { status: 'unsupported' };
    }

    flowContext.requestImmediateCompaction();
    notifyFollowUpSent(streamId, flowContext.runtimeHost);
    return { status: 'requested' };
  };

  const deliverFollowUp = async (
    targetStreamId: StreamTabId,
    input: ChatFollowUpInput,
  ): Promise<SendFollowUpResult> => {
    if (typeof input.followUp === 'string') {
      return await sendFollowUp(
        targetStreamId,
        input.followUp,
        input.mediaFiles,
        input.displayText,
        runtimeSession,
      );
    }
    return await sendFollowUp(
      targetStreamId,
      input.followUp,
      undefined,
      undefined,
      runtimeSession,
    );
  };

  const submitFollowUp = async (
    input: ChatFollowUpInput,
  ): Promise<ChatFollowUpDeliveryResult> => {
    return await followUpQueue.add(async () => {
      let followUpTarget = input.targetStreamId;
      while (
        !followUpTarget &&
        !session.stopRequested &&
        !session.runCompleted
      ) {
        await sleep(25);
        followUpTarget = session.streamId;
      }
      if (!followUpTarget || session.stopRequested) {
        return { status: 'not_delivered' };
      }
      return await deliverFollowUp(followUpTarget, input);
    });
  };

  // -----------------------------------------------------------------------
  // startRootRun
  // -----------------------------------------------------------------------

  const startRootRun = (config: AgentConfigPayload): void => {
    const currentModel = config.model;
    const sessionContext = getSessionContext(currentModel);
    cliState.sessionMeta.set({
      ...cliState.sessionMeta.get(),
      agent: config.agent,
      model: config.model,
      canDelegate: chatAgentSupportsDelegation(config.agent),
    });
    const runtimeHost = createCliRuntimeHost(sessionContext);
    const wrapped = wrapRuntimeHost(runtimeHost, {
      getQueuedFollowUps: (streamId) => ToolUseFollowUpQueue.getAll(streamId),
    });
    const detachResultToast = attachTerminalResultToast(
      runtimeSession,
      wrapped,
    );
    const unbindApprovals = installTuiApprovals(
      wrapped,
      sessionContext,
      runtimeSession.coordinators,
    );
    disposers.push(unbindApprovals);
    const executionId = generateExecutionId();
    let waitingTurn = 0;
    let executionRegistered = false;
    let agentSettled = false;
    session.executionId = executionId;
    const approvalsUnavailable = approvalPromptsUnavailable(sessionContext);

    const runPromise = registerFreshChatExecution(executionId, config)
      .then((registeredConfig) => {
        executionRegistered = true;
        return executeAgent(registeredConfig, executionId, {
          runtimeHost: wrapped,
          enforceCategory: true,
          approvalPromptsUnavailable: approvalsUnavailable,
          runtimeUnavailableTools: CLI_UNAVAILABLE_TOOLS,
          session: runtimeSession,
          onStreamResolved: (resolvedStreamId) => {
            session.streamId = resolvedStreamId;
            cliState.rootStreamId.set(resolvedStreamId);
            moveLocalTranscriptToStream(resolvedStreamId);
            cliState.activeStreamId.set(resolvedStreamId);
            if (session.stopRequested) interruptActiveRun();
          },
          onBeforeWaiting: (lastResponse) => {
            if (!session.streamId) return;
            projectStreamTranscript(session.streamId, {
              fallbackAssistant: {
                text: lastResponse,
                idPrefix: `waiting:${executionId}:${waitingTurn++}`,
              },
              finalize: true,
            });
          },
        });
      })
      .then((result) => {
        agentSettled = true;
        session.runExitCode = terminalStatusExitCode(
          cliTerminalStatus(result),
          sessionContext,
        );
        if (result.streamId) {
          projectStreamTranscript(result.streamId, {
            finalize: true,
            ...(result.category === AgentCategory.ToolUse
              ? {
                  fallbackAssistant: {
                    text: result.lastResponse,
                    idPrefix: `final:${result.executionId}`,
                  },
                }
              : {}),
          });
        }
        notify({ kind: 'agentFinished' });
      })
      .catch(async (error: unknown) => {
        await markRegisteredChatExecutionError(executionId, {
          executionRegistered,
          agentSettled,
        });
        if (!session.stopRequested) {
          appendLocalErrorTranscript(toErrorMessage(error));
        }
        session.runExitCode = session.stopRequested
          ? CliExitCode.Success
          : CliExitCode.AgentError;
      })
      .finally(() => {
        detachResultToast();
        if (session.runtimeHost === wrapped) session.runtimeHost = undefined;
        markChatTuiRunCompleted(session);
        void runtimeHost.close();
      });
    markChatTuiRunPending(session, runPromise, wrapped);
  };

  // -----------------------------------------------------------------------
  // resume
  // -----------------------------------------------------------------------

  const resume = async (
    id: ExecutionId,
    preResolved?: CliToolUseResumeResolution,
  ): Promise<void> => {
    if (!chatTuiCanStartRootRun(session)) {
      appendLocalAssistantTranscript(
        'Finish the active chat before resuming a previous session.',
      );
      return;
    }

    const resolution = preResolved ?? (await resolveCliResumeSnapshot(id));
    if (resolution.kind !== 'toolUse') {
      appendLocalErrorTranscript(explainNonResumable(resolution, id));
      return;
    }

    clearLocalTranscript();
    followUpQueue.clear();
    session.runCompleted = false;
    publishChatTuiRootRunStartAvailability(session);
    session.stopRequested = false;
    session.runExitCode = CliExitCode.Success;
    session.streamId = resolution.streamId;
    session.executionId = resolution.snapshot.executionId;
    cliState.rootStreamId.set(resolution.streamId);

    const currentModel = resolution.config.model;
    const sessionContext = getSessionContext(currentModel);
    cliState.sessionMeta.set({
      ...cliState.sessionMeta.get(),
      agent: resolution.config.agent,
      model: resolution.config.model,
      modelSource: 'history',
      canDelegate: chatAgentSupportsDelegation(resolution.config.agent),
    });

    await getDefaultStreamLogStore().ensureLoaded(resolution.streamId);
    await snapshotStore.load([resolution.streamId]);
    const restored = await snapshotStore.read(resolution.streamId);
    patchStream(resolution.streamId, (slice) => {
      const runUsages = Object.values(restored.runUsage);
      return {
        ...slice,
        cumulativeUsage: runUsages.length
          ? sumUsageStats(runUsages)
          : slice.cumulativeUsage,
        todos: restored.todos,
        plan: restored.plan,
      };
    });
    projectStreamTranscript(resolution.streamId);
    cliState.activeStreamId.set(resolution.streamId);

    const runtimeHost = createCliRuntimeHost(sessionContext);
    const wrapped = wrapRuntimeHost(runtimeHost, {
      getQueuedFollowUps: (streamId) => ToolUseFollowUpQueue.getAll(streamId),
    });
    session.runtimeHost = wrapped;
    const detachResultToast = attachTerminalResultToast(
      runtimeSession,
      wrapped,
    );
    const unbindApprovals = installTuiApprovals(
      wrapped,
      sessionContext,
      runtimeSession.coordinators,
    );
    disposers.push(unbindApprovals);
    const approvalsUnavailable = approvalPromptsUnavailable(sessionContext);

    session.runPromise = setCliHelperModel(currentModel)
      .then(() =>
        resumeToolUseFromSnapshot(resolution.snapshot, wrapped, {
          approvalPromptsUnavailable: approvalsUnavailable,
          runtimeUnavailableTools: CLI_UNAVAILABLE_TOOLS,
          session: runtimeSession,
        }),
      )
      .then(() => {
        if (session.streamId) {
          projectStreamTranscript(session.streamId, { finalize: true });
        }
        session.runExitCode = CliExitCode.Success;
        notify({ kind: 'agentFinished' });
      })
      .catch((error: unknown) => {
        if (!session.stopRequested) {
          appendLocalErrorTranscript(toErrorMessage(error));
        }
        session.runExitCode = session.stopRequested
          ? CliExitCode.Success
          : CliExitCode.AgentError;
      })
      .finally(() => {
        detachResultToast();
        if (session.runtimeHost === wrapped) session.runtimeHost = undefined;
        markChatTuiRunCompleted(session);
        void runtimeHost.close();
      });
    publishChatTuiRootRunStartAvailability(session);
  };

  // -----------------------------------------------------------------------
  // stop
  // -----------------------------------------------------------------------

  const stop = (): void => {
    session.stopRequested = true;
    interruptActiveRun();
  };

  const killExecution = (executionId: string): void => {
    clearApprovals();
    runtimeSession.executions.kill(executionId, {
      detachActiveChildren:
        tryPlatform()?.workspaceState.get<boolean>(
          WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
          false,
        ) === true,
    });
  };

  return {
    startRootRun,
    resume,
    stop,
    killExecution,
    canStartRootRun: () => chatTuiCanStartRootRun(session),
    canSelectModel,
    getModelSwitchDisabledReason,
    switchActiveModel,
    requestCompaction,
    clearPendingFollowUps: () => followUpQueue.clear(),
    submitFollowUp,
    awaitFollowUpsIdle: () => followUpQueue.onIdle(),
  };
}
