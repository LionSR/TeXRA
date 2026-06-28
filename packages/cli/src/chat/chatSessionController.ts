// Chat-session controller: owns run start/resume/stop state-transition
// orchestration for the CLI chat session. Host-neutral (no Ink/TUI rendering
// dependencies) — the Ink component consumes narrow commands exposed here.
//
// Extracted from runChatTui.tsx per #6328 so that UI rendering, command
// parsing, runtime orchestration, and persistence rules evolve independently.

import { setTimeout as sleep } from 'node:timers/promises';

import PQueue from 'p-queue';

import { tryPlatform } from '@platform/platform';
import { getDefaultStreamLogStore, StreamSnapshotStore } from '@transcript';
import {
  parseRuntimeToolUseAgentConfig,
  type RuntimeAgentConfigPayload,
} from '@agent/runtime/executionRequests';
import { requestRuntimeFollowUp } from '@agent/runtime/followUpCommands';
import { requestManualCompaction } from '@agent/runtime/manualCompaction';
import {
  getRuntimeModelSwitchState,
  requestRuntimeModelSwitch,
} from '@agent/runtime/modelSwitch';
import { requestRuntimeToolUseSnapshotResume } from '@agent/runtime/resumeCommands';
import { runAgent } from '@agent/runtime/runAgent';
import { repairRuntimeHistoryTerminalStatus } from '@agent/runtime/historyCommands';
import {
  requestKillExecution,
  requestRuntimeStreamStop,
} from '@agent/runtime/streamControl';
import { attachDefaultTerminalResultToast } from '@agent/runtime/terminalResultToast';
import { type CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { setCliHelperModel } from '@cli/runtime/initPlatform';
import { createCliRuntimeHost } from '@cli/runtime/runtimeHost';
import { resolveCliRuntimeCapabilities } from '@cli/runtime/runtimeCapabilities';
import { formatCliNoAvailableModelsRecovery } from '@cli/runtime/modelAccess';
import { selectCliRootModel } from '@cli/runtime/rootModelSelection';
import {
  explainNonResumable,
  resolveCliResumeSnapshot,
  type CliToolUseResumeResolution,
} from '@cli/runtime/sessionResume';
import {
  cliTerminalStatus,
  terminalStatusExitCode,
} from '@cli/runtime/terminalStatus';
import { toErrorMessage } from '@common/errors/errorMessage';
import {
  EXECUTION_STATUS,
  type ExecutionId,
  type StreamStatus,
  type StreamTabId,
  sumUsageStats,
} from '@shared/schemas';
import { AgentCategory } from '@shared/schemas/agent';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

import { CHAT_API_MODE_MODEL_RECOVERY } from './chatModelRecovery';
import { chatAgentSupportsDelegation } from './tui/commands/handlers/agentModelCommands';
import { clearApprovals } from './tui/state/approvalQueue';
import {
  cliState,
  patchStream,
  setCliSessionModelOverride,
} from './tui/state/cliState';
import { stoppedFocusedChildFollowUpMessage as focusedChildStoppedMessage } from './tui/state/focusedChildFollowUp';
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
}: BuildInitialChatAgentConfigInput): RuntimeAgentConfigPayload {
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
  startRootRun(config: RuntimeAgentConfigPayload): void;

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

  /** Whether a new root run can be started right now. */
  canStartRootRun(): boolean;

  /** Whether the current chat state accepts a model selection. */
  canSelectModel(): boolean;

  /** Runtime-provided reason a candidate model cannot be selected now. */
  getModelSwitchDisabledReason(candidateModel: string): string | undefined;

  /** Select the initial root model or switch the active tool-use model. */
  switchModel(model: string): Promise<void>;

  /** Send a follow-up to the active root stream or an explicitly focused child. */
  sendFollowUp(request: ChatFollowUpRequest): Promise<boolean>;

  /** Request context compaction for the active stream, if available. */
  requestCompaction(): void;

  /** Kill a visible child execution from the session controller boundary. */
  killExecution(executionId: ExecutionId): void;
}

export interface ChatFollowUpRequest {
  readonly targetStreamId?: StreamTabId | undefined;
  readonly text: string;
  readonly mediaFiles?: readonly string[] | undefined;
  readonly displayText?: string | undefined;
}

export interface ChatSessionControllerInit {
  /** Mutable session state the controller owns. */
  readonly session: TuiSession;

  /** Build a {@link CliContext} keyed on the current model. */
  readonly getSessionContext: (model: string) => CliContext;

  /** Disposer list shared with the TUI lifecycle. */
  readonly disposers: Array<() => void>;

  /** Serial queue for follow-up message delivery (cleared on resume). */
  readonly followUpQueue: PQueue;

  /** Per-stream sidecar persistence store. */
  readonly snapshotStore: StreamSnapshotStore;
}

export function createChatSessionController(
  init: ChatSessionControllerInit,
): ChatSessionController {
  const {
    session,
    getSessionContext,
    disposers,
    followUpQueue,
    snapshotStore,
  } = init;

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  const stopPolicy = (): { readonly detachActiveChildren: boolean } => {
    clearApprovals();
    return {
      detachActiveChildren:
        tryPlatform()?.workspaceState.get<boolean>(
          WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
          false,
        ) === true,
    };
  };

  const interruptActiveRun = (): void => {
    const policy = stopPolicy();
    if (!session.streamId) return;
    requestRuntimeStreamStop({
      streamId: session.streamId,
      clearRetryRequest: true,
      detachActiveChildren: policy.detachActiveChildren,
      runtimeHost: session.runtimeHost,
    });
  };

  const killExecution = (executionId: ExecutionId): void => {
    const policy = stopPolicy();
    requestKillExecution({
      executionId,
      detachActiveChildren: policy.detachActiveChildren,
    });
  };

  const rootStreamStatus = (): StreamStatus | undefined =>
    session.streamId
      ? cliState.streams.get().get(session.streamId)?.status
      : undefined;

  const hasActiveToolUseFlow = (): boolean =>
    session.streamId
      ? getRuntimeModelSwitchState({ streamId: session.streamId }).status ===
        'target'
      : false;

  const stoppedFocusedChildFollowUpMessage = (streamId: StreamTabId): string =>
    focusedChildStoppedMessage({
      parentStream: cliState.parentStream.get(),
      streamId,
      streams: cliState.streams.get(),
    });

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
    if (!session.streamId) return undefined;
    const state = getRuntimeModelSwitchState({
      streamId: session.streamId,
      candidateModel,
    });
    return state.status === 'target' ? state.disabledReason : undefined;
  };

  const switchModel = async (model: string): Promise<void> => {
    const nextModel = model.trim();
    const toolUseOnlyMessage =
      'Model switching is only available for an active tool-use chat. Start a new chat with texra chat --model=<name> to choose a different root model.';
    if (chatTuiCanStartRootRun(session)) {
      try {
        const { apiMode } = cliState.sessionMeta.get();
        const selection = await selectCliRootModel({
          model: nextModel,
          modelSource: 'override',
          apiMode,
          noAvailableModelsMessage: formatCliNoAvailableModelsRecovery(
            apiMode,
            CHAT_API_MODE_MODEL_RECOVERY,
          ),
        });
        setCliSessionModelOverride(selection.model);
        appendLocalAssistantTranscript(`Root model set to ${selection.model}.`);
      } catch (error: unknown) {
        appendLocalAssistantTranscript(toErrorMessage(error));
      }
      return;
    }

    if (!canSelectModel()) {
      appendLocalAssistantTranscript(
        'Finish the active response before switching models.',
      );
      return;
    }

    if (!session.streamId) {
      appendLocalAssistantTranscript(toolUseOnlyMessage);
      return;
    }

    try {
      const result = await requestRuntimeModelSwitch({
        streamId: session.streamId,
        model: nextModel,
      });
      switch (result.status) {
        case 'no_target':
          appendLocalAssistantTranscript(toolUseOnlyMessage);
          return;
        case 'disabled':
          appendLocalAssistantTranscript(result.reason);
          return;
        case 'switched':
          setCliSessionModelOverride(nextModel);
          break;
      }
    } catch (error: unknown) {
      appendLocalAssistantTranscript(toErrorMessage(error));
      return;
    }

    try {
      await setCliHelperModel(nextModel);
    } catch (error: unknown) {
      appendLocalAssistantTranscript(
        `Model switched to ${nextModel}. Could not persist it as the default helper model: ${toErrorMessage(error)}`,
      );
      return;
    }

    appendLocalAssistantTranscript(
      `Model switched to ${nextModel}. Future turns will use it.`,
    );
  };

  const sendFollowUp = async ({
    targetStreamId,
    text,
    mediaFiles,
    displayText,
  }: ChatFollowUpRequest): Promise<boolean> =>
    followUpQueue.add(async () => {
      // Follow-ups must not be silently dropped when the user submits before
      // onStreamResolved has populated session.streamId. PQueue serializes
      // delivery; the queue task waits for the missing stream id.
      let followUpTarget = targetStreamId;
      while (
        !followUpTarget &&
        !session.stopRequested &&
        !session.runCompleted
      ) {
        await sleep(25);
        followUpTarget = session.streamId;
      }
      if (!followUpTarget) {
        if (!session.stopRequested) {
          appendLocalAssistantTranscript(
            'No active session. Start a new agent task to continue.',
          );
        }
        return false;
      }
      if (session.stopRequested) return false;

      const result = await requestRuntimeFollowUp({
        streamId: followUpTarget,
        text,
        ...(mediaFiles !== undefined ? { mediaFiles } : {}),
        ...(displayText !== undefined ? { displayText } : {}),
        ...(session.runtimeHost !== undefined
          ? { runtimeHost: session.runtimeHost }
          : {}),
      });
      if (result.accepted) {
        return true;
      }

      // Child stream ids are keys in parentStream; the root session id is not.
      if (followUpTarget === session.streamId) {
        if (result.notice?.message) {
          appendLocalAssistantTranscript(result.notice.message, followUpTarget);
        }
        session.stopRequested = true;
      } else {
        appendLocalAssistantTranscript(
          stoppedFocusedChildFollowUpMessage(followUpTarget),
          followUpTarget,
        );
      }
      return false;
    });

  const requestCompaction = (): void => {
    const streamId = cliState.activeStreamId.get();
    const result = requestManualCompaction(streamId);
    appendLocalAssistantTranscript(result.message, streamId);
  };

  // -----------------------------------------------------------------------
  // startRootRun
  // -----------------------------------------------------------------------

  const startRootRun = (config: RuntimeAgentConfigPayload): void => {
    const currentModel = config.model;
    const sessionContext = getSessionContext(currentModel);
    cliState.sessionMeta.set({
      ...cliState.sessionMeta.get(),
      agent: config.agent,
      model: config.model,
      canDelegate: chatAgentSupportsDelegation(config.agent),
    });
    const runtimeHost = createCliRuntimeHost(sessionContext);
    const wrapped = wrapRuntimeHost(runtimeHost);
    const detachResultToast = attachDefaultTerminalResultToast(wrapped);
    const unbindApprovals = installTuiApprovals(wrapped, sessionContext);
    disposers.push(unbindApprovals);
    let executionId: ExecutionId | undefined;
    let waitingTurn = 0;
    const runtimeCapabilities = resolveCliRuntimeCapabilities(sessionContext);

    const runPromise = Promise.resolve()
      .then(() => {
        const registeredConfig = parseRuntimeToolUseAgentConfig(config);
        return runAgent(
          { config: registeredConfig },
          {
            runtimeHost: wrapped,
            enforceCategory: true,
            approvalPromptsUnavailable:
              runtimeCapabilities.approvalPromptsUnavailable,
            runtimeUnavailableTools:
              runtimeCapabilities.runtimeUnavailableTools,
            onExecutionIdAllocated: (allocatedExecutionId) => {
              executionId = allocatedExecutionId;
              session.executionId = allocatedExecutionId;
            },
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
                  idPrefix: `waiting:${executionId ?? 'pending'}:${waitingTurn++}`,
                },
                finalize: true,
              });
            },
          },
        );
      })
      .then((result) => {
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
        if (!session.stopRequested) {
          if (executionId) {
            await repairRuntimeHistoryTerminalStatus(
              executionId,
              EXECUTION_STATUS.ERROR,
            );
          }
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
    const wrapped = wrapRuntimeHost(runtimeHost);
    session.runtimeHost = wrapped;
    const detachResultToast = attachDefaultTerminalResultToast(wrapped);
    const unbindApprovals = installTuiApprovals(wrapped, sessionContext);
    disposers.push(unbindApprovals);
    const runtimeCapabilities = resolveCliRuntimeCapabilities(sessionContext);

    session.runPromise = setCliHelperModel(currentModel)
      .then(async () => {
        const resumed = await requestRuntimeToolUseSnapshotResume({
          snapshot: resolution.snapshot,
          runtimeHost: wrapped,
          approvalPromptsUnavailable:
            runtimeCapabilities.approvalPromptsUnavailable,
          runtimeUnavailableTools: runtimeCapabilities.runtimeUnavailableTools,
        });
        if (!resumed) {
          throw new Error(
            'The selected session is already active or resuming.',
          );
        }
      })
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

  return {
    startRootRun,
    resume,
    stop,
    canStartRootRun: () => chatTuiCanStartRootRun(session),
    canSelectModel,
    getModelSwitchDisabledReason,
    switchModel,
    sendFollowUp,
    requestCompaction,
    killExecution,
  };
}
