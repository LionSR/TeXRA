// Chat-session controller: owns run start/resume/stop state-transition
// orchestration for the CLI chat session. Host-neutral (no Ink/TUI rendering
// dependencies) — the Ink component consumes narrow commands exposed here.
//
// Extracted from runChatTui.tsx per #6328 so that UI rendering, command
// parsing, runtime orchestration, and persistence rules evolve independently.

import PQueue from 'p-queue';

import { getDefaultStreamLogStore, StreamSnapshotStore } from '@transcript';
import { registerExecution, writeTerminalStatus } from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfig,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { detachSubagentsOnStop } from '@agent/runtime/detachSubagentsOnStop';
import { SharedExecutionRegistry } from '@agent/runtime/executionRegistry';
import {
  executeAgent,
  resumeToolUseFromSnapshot,
} from '@agent/runtime/executeAgent';
import { attachLegacyProgressEventProjection } from '@agent/runtime/LegacyProgressEventProjection';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { attachTerminalResultToast } from '@agent/runtime/terminalResultToast';
import { type CliContext } from '@cli/runtime/cliContext';
import { approvalPromptsUnavailable } from '@cli/runtime/approvalPolicyAvailability';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { setCliHelperModel } from '@cli/runtime/initPlatform';
import {
  createCliRuntimeHost,
  type CliRuntimeHost,
} from '@cli/runtime/runtimeHost';
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
import {
  EXECUTION_STATUS,
  type ExecutionId,
  sumUsageStats,
} from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { generateExecutionId } from '@utils/core/executionId';

import { chatAgentSupportsDelegation } from './tui/commands/handlers/agentModelCommands';
import { clearApprovals } from './tui/state/approvalQueue';
import { activeStreamId, rootStreamId } from './tui/state/cliState/focusSlice';
import { patchSessionMeta } from './tui/state/cliState/sessionSlice';
import { patchStream } from './tui/state/cliState/streamsSlice';
import {
  chatTuiCanStartRootRun,
  markChatTuiRunCompleted,
  markChatTuiRunPending,
  publishChatTuiRootRunStartAvailability,
  type TuiSession,
} from './tui/state/sessionRunState';
import { createTuiHostInteractions } from './tui/state/subscribeApprovals';
import {
  attachTuiWorkPlanRunFactSubscription,
  wrapRuntimeHost,
} from './tui/state/subscribeRuntimeHost';
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

  /** Whether a new root run can be started right now. */
  canStartRootRun(): boolean;
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

  const interruptActiveRun = (): void => {
    clearApprovals();
    if (!session.streamId) return;
    SharedExecutionRegistry.stopAgentStream(session.streamId, {
      detachActiveChildren: detachSubagentsOnStop(),
      runtimeHost: session.runtimeHost,
    });
  };

  // Shared tail of the run/resume `.catch()` handlers: surface the error to
  // the local transcript unless the run was stopped intentionally, and set
  // the exit code accordingly.
  const reportRunFailure = (error: unknown): void => {
    if (!session.stopRequested) {
      appendLocalErrorTranscript(toErrorMessage(error));
    }
    session.runExitCode = session.stopRequested
      ? CliExitCode.Success
      : CliExitCode.AgentError;
  };

  // Build the wrapped runtime host shared by start and resume: attach the
  // terminal-result toast and the TUI approval pipeline, and return a
  // `finalize` teardown that both run promises invoke from their `.finally`.
  const setupRunHost = (
    sessionContext: CliContext,
  ): {
    readonly wrapped: CliRuntimeHost;
    readonly approvalsUnavailable: boolean;
    readonly finalize: () => void;
  } => {
    const runtimeHost = createCliRuntimeHost(sessionContext);
    const wrapped = wrapRuntimeHost(runtimeHost, snapshotStore);
    const detachHostInteractions = defaultSession().useHostInteractions(
      createTuiHostInteractions(wrapped, sessionContext),
    );
    disposers.push(detachHostInteractions);
    const interactiveHost: CliRuntimeHost = {
      ...wrapped,
      interactions: defaultSession().interactions,
    };
    const detachResultToast = attachTerminalResultToast(
      defaultSession(),
      interactiveHost,
    );
    const detachTuiWorkPlanRunFacts = attachTuiWorkPlanRunFactSubscription(
      defaultSession().events,
    );
    const detachLegacyProgressProjection = attachLegacyProgressEventProjection(
      defaultSession().events,
      interactiveHost,
    );
    return {
      wrapped: interactiveHost,
      approvalsUnavailable: approvalPromptsUnavailable(sessionContext),
      finalize: (): void => {
        detachResultToast();
        detachTuiWorkPlanRunFacts();
        detachLegacyProgressProjection();
        detachHostInteractions();
        if (session.runtimeHost === interactiveHost) {
          session.runtimeHost = undefined;
        }
        markChatTuiRunCompleted(session);
        void runtimeHost.close();
      },
    };
  };

  // -----------------------------------------------------------------------
  // startRootRun
  // -----------------------------------------------------------------------

  const startRootRun = (config: AgentConfigPayload): void => {
    const currentModel = config.model;
    const sessionContext = getSessionContext(currentModel);
    patchSessionMeta({
      agent: config.agent,
      model: config.model,
      canDelegate: chatAgentSupportsDelegation(config.agent),
    });
    const { wrapped, approvalsUnavailable, finalize } =
      setupRunHost(sessionContext);
    const executionId = generateExecutionId();
    let waitingTurn = 0;
    let executionRegistered = false;
    let agentSettled = false;
    session.executionId = executionId;

    const runPromise = registerFreshChatExecution(executionId, config)
      .then((registeredConfig) => {
        executionRegistered = true;
        return executeAgent(registeredConfig, executionId, {
          runtimeHost: wrapped,
          enforceCategory: true,
          approvalPromptsUnavailable: approvalsUnavailable,
          runtimeUnavailableTools: CLI_UNAVAILABLE_TOOLS,
          onStreamResolved: (resolvedStreamId) => {
            session.streamId = resolvedStreamId;
            rootStreamId.set(resolvedStreamId);
            moveLocalTranscriptToStream(resolvedStreamId);
            activeStreamId.set(resolvedStreamId);
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
        reportRunFailure(error);
      })
      .finally(finalize);
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
    rootStreamId.set(resolution.streamId);

    const currentModel = resolution.config.model;
    const sessionContext = getSessionContext(currentModel);
    patchSessionMeta({
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
    activeStreamId.set(resolution.streamId);

    const { wrapped, approvalsUnavailable, finalize } =
      setupRunHost(sessionContext);
    session.runtimeHost = wrapped;

    session.runPromise = setCliHelperModel(currentModel)
      .then(() =>
        resumeToolUseFromSnapshot(resolution.snapshot, wrapped, {
          approvalPromptsUnavailable: approvalsUnavailable,
          runtimeUnavailableTools: CLI_UNAVAILABLE_TOOLS,
        }),
      )
      .then(() => {
        if (session.streamId) {
          projectStreamTranscript(session.streamId, { finalize: true });
        }
        session.runExitCode = CliExitCode.Success;
        notify({ kind: 'agentFinished' });
      })
      .catch(reportRunFailure)
      .finally(finalize);
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
  };
}
