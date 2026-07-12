// Chat-session controller: owns run start/resume/stop state-transition
// orchestration for the CLI chat session. Host-neutral (no Ink/TUI rendering
// dependencies) — the Ink component consumes narrow commands exposed here.
//
// Extracted from runChatTui.tsx per #6328 so that UI rendering, command
// parsing, runtime orchestration, and persistence rules evolve independently.

import PQueue from 'p-queue';

import { StreamSnapshotStore } from '@transcript';
import {
  getExecutionStore,
  registerExecution,
  writeTerminalStatus,
} from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfig,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { detachSubagentsOnStop } from '@agent/runtime/detachSubagentsOnStop';
import {
  executeAgent,
  resumeToolUseFromSnapshot,
} from '@agent/runtime/executeAgent';
import { resolveAndResumeStream } from '@agent/runtime/resolveAndResumeStream';
import { resumeQueuedToolUseSnapshot } from '@agent/runtime/resumeQueuedToolUse';
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
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
  sumUsageStats,
} from '@shared/schemas';
import { generateExecutionId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { chatAgentSupportsDelegation } from './tui/commands/handlers/agentModelCommands';
import { clearApprovals } from './tui/state/approvalQueue';
import {
  activeStreamId,
  rootStreamId,
  patchSessionMeta,
  patchStream,
} from './tui/state/cliState';
import {
  chatTuiCanStartRootRun,
  markChatTuiRunCompleted,
  markChatTuiRunPending,
  publishChatTuiRunState,
  tryClaimRootRunSlot,
  type TuiSession,
} from './tui/state/sessionRunState';
import { createTuiHostInteractions } from './tui/state/subscribeApprovals';
import { attachTuiRunFactSubscription } from './tui/state/subscribeRuntimeHost';
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

  /**
   * Attempt to resume a queued follow-up target from the CLI platform port.
   * Returns true only when this controller accepts the target resume.
   */
  tryResumeStream(streamId: StreamTabId): Promise<boolean>;

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
    defaultSession().executions.stopAgentStream(session.streamId, {
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

  // Build the runtime host shared by start and resume: attach the
  // terminal-result toast and the TUI approval pipeline, and return a
  // `finalize` teardown that both run promises invoke from their `.finally`.
  const setupRunHost = (
    sessionContext: CliContext,
  ): {
    readonly runtimeHost: CliRuntimeHost;
    readonly approvalsUnavailable: boolean;
    readonly finalize: () => void;
  } => {
    const runtimeHost = createCliRuntimeHost(sessionContext);
    const detachHostInteractions = defaultSession().useHostInteractions(
      createTuiHostInteractions(runtimeHost, sessionContext),
    );
    disposers.push(detachHostInteractions);
    const interactiveHost: CliRuntimeHost = {
      ...runtimeHost,
      interactions: defaultSession().interactions,
    };
    const detachResultToast = attachTerminalResultToast(
      defaultSession(),
      interactiveHost,
    );
    const detachTuiRunFacts = attachTuiRunFactSubscription(
      defaultSession().events,
    );
    return {
      runtimeHost: interactiveHost,
      approvalsUnavailable: approvalPromptsUnavailable(sessionContext),
      finalize: (): void => {
        detachResultToast();
        detachTuiRunFacts();
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
    const { runtimeHost, approvalsUnavailable, finalize } =
      setupRunHost(sessionContext);
    const executionId = generateExecutionId();
    let executionRegistered = false;
    let agentSettled = false;
    session.executionId = executionId;

    const runPromise = registerFreshChatExecution(executionId, config)
      .then((registeredConfig) => {
        executionRegistered = true;
        return executeAgent(registeredConfig, executionId, {
          runtimeHost,
          enforceCategory: true,
          approvalPromptsUnavailable: approvalsUnavailable,
          runtimeUnavailableTools: CLI_UNAVAILABLE_TOOLS,
          onStreamResolved: (resolvedStreamId) => {
            session.streamId = resolvedStreamId;
            publishChatTuiRunState(session);
            rootStreamId.set(resolvedStreamId);
            moveLocalTranscriptToStream(resolvedStreamId);
            activeStreamId.set(resolvedStreamId);
            if (session.stopRequested) interruptActiveRun();
          },
          onIdle: () => {
            if (!session.streamId) return;
            projectStreamTranscript(session.streamId, { finalize: true });
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
          projectStreamTranscript(result.streamId, { finalize: true });
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
    markChatTuiRunPending(session, runPromise, runtimeHost);
  };

  // -----------------------------------------------------------------------
  // resume
  // -----------------------------------------------------------------------

  const resume = async (
    id: ExecutionId,
    preResolved?: CliToolUseResumeResolution,
  ): Promise<void> => {
    // Claim the root-run slot as the FIRST statement, synchronously, before
    // any `await` below — see tryClaimRootRunSlot. This fuses the
    // availability check and the claim into one atomic step so a concurrent
    // tryResumeStream() (or another resume()) can never observe this call
    // suspended between "checked available" and "claimed", and race in to
    // claim the same slot out from under it.
    let resolveRunPromise: () => void = () => {};
    let rejectRunPromise: (error: unknown) => void = () => {};
    const claimedRunPromise = new Promise<void>((resolve, reject) => {
      resolveRunPromise = resolve;
      rejectRunPromise = reject;
    });
    if (!tryClaimRootRunSlot(session, claimedRunPromise)) {
      appendLocalAssistantTranscript(
        'Finish the active chat before resuming a previous session.',
      );
      return;
    }

    try {
      const resolution = preResolved ?? (await resolveCliResumeSnapshot(id));
      if (resolution.kind !== 'toolUse') {
        appendLocalErrorTranscript(explainNonResumable(resolution, id));
        markChatTuiRunCompleted(session);
        resolveRunPromise();
        return;
      }

      clearLocalTranscript();
      followUpQueue.clear();
      session.streamId = resolution.streamId;
      session.executionId = resolution.snapshot.executionId;
      publishChatTuiRunState(session);
      rootStreamId.set(resolution.streamId);

      const currentModel = resolution.config.model;
      const sessionContext = getSessionContext(currentModel);
      patchSessionMeta({
        agent: resolution.config.agent,
        model: resolution.config.model,
        modelSource: 'history',
        canDelegate: chatAgentSupportsDelegation(resolution.config.agent),
      });

      await defaultSession().transcripts.ensureLoaded(resolution.streamId);
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

      const { runtimeHost, approvalsUnavailable, finalize } =
        setupRunHost(sessionContext);
      session.runtimeHost = runtimeHost;

      // A Ctrl-C during the rehydration awaits above (`resolveCliResumeSnapshot`,
      // `ensureLoaded`, `snapshotStore.load`/`read`) lands here as
      // `session.stopRequested`. Honor it before starting the real run chain —
      // matching `tryResumeStream()`'s stop-check after its own preparatory
      // awaits — instead of starting an agent the user already cancelled.
      if (session.stopRequested) {
        finalize();
        resolveRunPromise();
        return;
      }

      const runChain = setCliHelperModel(currentModel)
        .then(() =>
          resumeToolUseFromSnapshot(resolution.snapshot, runtimeHost, {
            approvalPromptsUnavailable: approvalsUnavailable,
            runtimeUnavailableTools: CLI_UNAVAILABLE_TOOLS,
            isCancellationRequested: () => session.stopRequested,
          }),
        )
        .then((result) => {
          if (session.streamId) {
            projectStreamTranscript(session.streamId, { finalize: true });
          }
          session.runExitCode = terminalStatusExitCode(
            cliTerminalStatus(result),
            sessionContext,
          );
          notify({ kind: 'agentFinished' });
        })
        .catch(reportRunFailure)
        .finally(finalize);
      // `session.runPromise` was already claimed synchronously above with
      // `claimedRunPromise`; forward its settlement to the real run chain so
      // exit-drain's `await session.runPromise` blocks until the continued
      // run actually finishes (or is interrupted), not just until
      // rehydration completes. `resume()`'s own returned promise still
      // settles here, before the run finishes — fire-and-forget per the
      // interface contract.
      runChain.then(resolveRunPromise, rejectRunPromise);
    } catch (error: unknown) {
      reportRunFailure(error);
      markChatTuiRunCompleted(session);
      resolveRunPromise();
    }
  };

  const tryResumeStream = (streamId: StreamTabId): Promise<boolean> => {
    let resolveRun: (resumed: boolean) => void = () => {};
    let rejectRun: (error: unknown) => void = () => {};
    const runPromise = new Promise<boolean>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    // Claim the root-run slot as the FIRST statement, synchronously, before
    // any `await` below — see tryClaimRootRunSlot and the matching comment
    // in resume().
    if (
      !tryClaimRootRunSlot(
        session,
        runPromise.then(() => undefined),
      )
    ) {
      return Promise.resolve(false);
    }

    const runResume = async (): Promise<boolean> => {
      let finalize = (): void => markChatTuiRunCompleted(session);
      try {
        await snapshotStore.preload([streamId]);
        const executionId =
          snapshotStore.getExecutionId(streamId) ??
          (await snapshotStore.readPersistedExecutionId(streamId));
        if (!executionId) return false;

        const config =
          snapshotStore.getRunConfig(streamId) ??
          (await getExecutionStore(executionId).readConfig());
        if (!config) return false;
        if (session.stopRequested) return false;
        const parentStreamId = snapshotStore.getParentStreamId(streamId);

        const currentModel = config.model;
        const sessionContext = getSessionContext(currentModel);
        patchSessionMeta({
          agent: config.agent,
          model: config.model,
          modelSource: 'history',
          canDelegate: chatAgentSupportsDelegation(config.agent),
        });

        const runHost = setupRunHost(sessionContext);
        finalize = runHost.finalize;
        const { runtimeHost, approvalsUnavailable } = runHost;
        session.runtimeHost = runtimeHost;
        session.streamId = streamId;
        session.executionId = executionId;
        if (!parentStreamId) {
          rootStreamId.set(streamId);
        }
        activeStreamId.set(streamId);
        session.runCompleted = false;
        session.runExitCode = CliExitCode.Success;
        publishChatTuiRunState(session);

        let resumedToWaiting = false;
        const resumed = await setCliHelperModel(currentModel).then(() =>
          resolveAndResumeStream(streamId, {
            runtimeHost,
            streamStatus: defaultSession().status,
            isCancellationRequested: () => session.stopRequested,
            resolveResumeState: async () => ({
              runState: config,
              executionId,
              parentStreamId,
            }),
            resumeToolUseSnapshot: (snapshot) =>
              resumeQueuedToolUseSnapshot(streamId, snapshot, runtimeHost, {
                session: defaultSession(),
                approvalPromptsUnavailable: approvalsUnavailable,
                runtimeUnavailableTools: CLI_UNAVAILABLE_TOOLS,
                allowWaitingResult: true,
                isCancellationRequested: () => session.stopRequested,
                onResult: (result) => {
                  resumedToWaiting = result.outcome === STREAM_PHASE.WAITING;
                },
                onError: reportRunFailure,
              }),
            executeWorkflow: async () => {
              throw new Error(
                'CLI chat cannot auto-resume workflow streams from follow-up wake.',
              );
            },
            reportNoResumableSession: () => {
              appendLocalAssistantTranscript(
                'Message queued. Auto-resume found no resumable session state; resume the session manually or start a new agent task.',
                streamId,
              );
            },
            reportFailure: (_failedStream, error) => reportRunFailure(error),
          }),
        );

        if (resumed) {
          if (session.streamId) {
            projectStreamTranscript(session.streamId, { finalize: true });
          }
          session.runExitCode = CliExitCode.Success;
          if (!resumedToWaiting) {
            notify({ kind: 'agentFinished' });
          }
        } else if (session.stopRequested) {
          session.runExitCode = CliExitCode.Interrupted;
        }
        return resumed;
      } catch (error: unknown) {
        reportRunFailure(error);
        return false;
      } finally {
        finalize();
      }
    };

    void runResume().then(resolveRun, rejectRun);

    return runPromise;
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
    tryResumeStream,
    canStartRootRun: () => chatTuiCanStartRootRun(session),
  };
}
