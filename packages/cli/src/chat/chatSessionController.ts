// Chat-session controller: owns run start/resume/stop state-transition
// orchestration for the CLI chat session. Host-neutral (no Ink/TUI rendering
// dependencies) — the Ink component consumes narrow commands exposed here.

import pDefer from 'p-defer';
import PQueue from 'p-queue';

import { getExecutionStore } from '@agent/storage';
import {
  AgentConfigSchema,
  attachTerminalResultToast,
  describeResumeFailure,
  detachSubagentsOnStop,
  resolveAndResumeStream,
  resumeQueuedToolUseFromResumeData,
  resumeToolUseFromResumeData,
  runAgent,
  type AgentConfig,
  type AgentConfigPayload,
  type SessionHandle,
  type ToolUseResumeData,
} from '@agent/runtime';
import type {
  FollowUpQueueInput,
  FollowUpRecoveryLease,
} from '@agent/followUp';
import { chatAgentSupportsDelegation } from '@cli/runtime/agents';
import { type CliContext } from '@cli/runtime/cliContext';
import { warnApprovalDenied } from '@cli/runtime/approval/approvalPrompts';
import { cliApprovalPromptsUnavailable } from '@cli/runtime/approval/settleApprovals';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { readCliMultiAgentPresetName } from '@cli/runtime/multiAgentPresets';
import { setCliHelperModel } from '@cli/runtime/initPlatform';
import {
  createCliRuntimeHost,
  type CliRuntimeHost,
} from '@cli/runtime/cliPresentationHost';
import { readCliToolUseResumeData } from '@cli/runtime/toolUseResumeData';
import {
  runOutcomeExitCode,
  type TurnOutcome,
} from '@cli/runtime/terminalStatus';
import {
  hasErrorPresentationPending,
  hasErrorPresentedMarker,
} from '@common/errors/sdkError/errorMetadata';
import type { DisposableStore } from '@platform/disposable';
import type { RecoveryContinuation } from '@platform/interfaces';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
  sumUsageStats,
  AgentCategory,
} from '@shared/schemas';
import { getDefaultUnavailableToolNames } from '@tools/registry';
import { StreamSnapshotStore } from '@transcript';
import { generateExecutionId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { clearApprovals } from './tui/state/approvalQueue';
import {
  focusStream,
  rootStreamId,
  patchSessionMeta,
  patchStream,
} from './tui/state/cliState';
import {
  chatTuiCanStartRootRun,
  type TuiSession,
} from './tui/state/sessionRunState';
import { createTuiHostInteractions } from './tui/state/subscribeApprovals';
import { attachSessionSignalsAdapter } from './tui/state/sessionSignalsAdapter';
import { notify } from './tui/notifications/terminalNotifier';
import {
  appendLocalErrorTranscript,
  appendLocalAssistantTranscript,
  clearLocalTranscript,
  moveLocalTranscriptToStream,
} from './tui/state/transcript';
import { syncStreamLog } from './tui/state/subscribeStreamLog';
import {
  beginLoadedStreamsReconcile,
  markArtifactStreamHydrated,
} from './tui/state/subscribeStreamArtifacts';

type InterruptedFollowUp = Pick<
  FollowUpQueueInput,
  'text' | 'mediaFiles' | 'displayText'
>;

type InterruptedFollowUpAdmission =
  | { readonly kind: 'not_interrupted' }
  | {
      readonly kind: 'accepted';
      readonly streamId: StreamTabId;
      readonly completion: Promise<boolean>;
    };

interface InterruptedContinuationBatch {
  readonly streamId: StreamTabId;
  readonly followUps: InterruptedFollowUp[];
  completion: Promise<boolean>;
  superseded: boolean;
}

interface SupersededInterruptedRecovery {
  readonly streamId: StreamTabId;
  readonly followUps: readonly InterruptedFollowUp[];
}

interface AutoResumeOptions {
  readonly recovery?: RecoveryContinuation;
  readonly extraFollowUps?: readonly InterruptedFollowUp[];
  readonly onFollowUpQueueReady?: (recovery: FollowUpRecoveryLease) => void;
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
  resume(id: ExecutionId, preResolved?: ToolUseResumeData): Promise<void>;

  /** Request stop of the root run using the configured child policy. */
  stop(): void;

  /** Stop one user-focused stream while preserving other agent streams. */
  stopStream(streamId: StreamTabId): void;

  /**
   * Atomically admit a message into an interrupted root conversation.
   * Messages arriving during teardown share one resume and are replayed in
   * admission order.
   */
  admitInterruptedFollowUp(
    followUp: InterruptedFollowUp,
  ): InterruptedFollowUpAdmission;

  /** Discard controller-owned interruption recovery after an explicit reset. */
  clearInterruptedRecovery(): void;

  /**
   * Attempt to resume a queued follow-up target from the CLI platform port.
   * Returns true only when this controller accepts the target resume.
   */
  tryResumeStream(
    streamId: StreamTabId,
    recovery?: RecoveryContinuation,
  ): Promise<boolean>;

  /** Whether a new root run can be started right now. */
  canStartRootRun(): boolean;
}

export interface ChatSessionControllerInit {
  /** Mutable session state the controller owns. */
  readonly session: TuiSession;

  /** Runtime session that owns executions, storage, and interactions. */
  readonly runtimeSession: SessionHandle;

  /** Build a {@link CliContext} keyed on the current model. */
  readonly getSessionContext: (model: string) => CliContext;

  /** Disposable owner shared with the TUI session lifecycle. */
  readonly disposables: DisposableStore;

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
    runtimeSession,
    getSessionContext,
    disposables,
    followUpQueue,
    snapshotStore,
  } = init;
  let interruptedContinuation: InterruptedContinuationBatch | undefined;
  let pendingInterruptedFollowUps: InterruptedFollowUp[] = [];

  // Run facts belong to the TUI session, not to any one root turn. A stopped
  // root may leave detached children running, and those children must keep
  // projecting status, output, and approval-related facts after the root
  // promise settles. Installing this once also avoids duplicate projections
  // when another root starts while an earlier detached child is still alive.
  disposables.add(
    attachSessionSignalsAdapter({
      events: runtimeSession.events,
      session: runtimeSession,
      snapshots: snapshotStore,
    }),
  );

  // Shared prelude of the three run-starting paths (start, resume,
  // follow-up-wake resume): resolve the model-keyed session context and
  // activate the config into the session meta signals in one step.
  const beginRunContext = (
    config: Pick<
      AgentConfig,
      'agent' | 'model' | 'cliMultiAgentPresetId' | 'delegationAgentScope'
    >,
    modelSource?: 'history',
  ): CliContext => {
    const sessionContext = getSessionContext(config.model);
    patchSessionMeta({
      agent: config.agent,
      model: config.model,
      ...(modelSource ? { modelSource } : {}),
      canDelegate: chatAgentSupportsDelegation(config.agent),
      teamName: readCliMultiAgentPresetName(
        config.cliMultiAgentPresetId ?? undefined,
      ),
      cliMultiAgentPresetId: config.cliMultiAgentPresetId ?? undefined,
      delegationAgentScope: config.delegationAgentScope ?? undefined,
    });
    return sessionContext;
  };

  const supersedeInterruptedRecovery = ():
    SupersededInterruptedRecovery | undefined => {
    const streamId = session.interruptedStreamId;
    const followUps = [
      ...pendingInterruptedFollowUps,
      ...(interruptedContinuation?.followUps ?? []),
    ];
    pendingInterruptedFollowUps = [];
    if (interruptedContinuation) {
      interruptedContinuation.superseded = true;
      interruptedContinuation = undefined;
    }
    session.interruptedStreamId = undefined;
    return streamId ? { streamId, followUps } : undefined;
  };

  const restoreRecoveryFollowUps = (
    recovery: SupersededInterruptedRecovery | undefined,
    lease: FollowUpRecoveryLease,
  ): void => {
    runtimeSession.followUps.queue(lease).restore(recovery?.followUps ?? []);
    if (recovery?.followUps.length) {
      runtimeSession.events.emit({
        scope: 'session',
        event: {
          type: 'updateQueuedFollowUps',
          payload: { streamId: lease.streamId },
        },
      });
    }
  };

  const restoreInterruptedRecovery = (
    recovery: SupersededInterruptedRecovery | undefined,
  ): void => {
    const streamId = session.interruptedStreamId ?? recovery?.streamId;
    if (!streamId) return;
    session.interruptedStreamId = streamId;
    pendingInterruptedFollowUps = [
      ...(recovery?.followUps ?? []),
      ...pendingInterruptedFollowUps,
    ];
  };

  // A cancelled root can publish completion just before its run promise
  // settles. During that narrow interval its teardown can still overwrite a
  // successor's root-slot state. Retain every unsettled interrupted generation
  // so a later interruption cannot discard an earlier blocker.
  const recoveryBlockedByInterruptedRuns = new Set<Promise<void>>();
  const blockRecoveryUntilInterruptedRunSettles = (): void => {
    const interruptedRun = session.runPromise;
    if (
      !interruptedRun ||
      session.runCompleted ||
      recoveryBlockedByInterruptedRuns.has(interruptedRun)
    ) {
      return;
    }
    recoveryBlockedByInterruptedRuns.add(interruptedRun);
    const clearBlock = (): void => {
      recoveryBlockedByInterruptedRuns.delete(interruptedRun);
    };
    void interruptedRun.then(clearBlock, clearBlock);
  };

  // Cancellation of an admitted automatic resume is monotone for that
  // attempt. `/clear` may reset the shared session fields while asynchronous
  // preparation is still running, but it must not re-enable lease admission.
  let activeAutoResumeCancellation:
    { cancellationRequested: boolean } | undefined;

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  const interruptActiveRun = (): void => {
    clearApprovals();
    if (!session.streamId) return;
    session.interruptedStreamId = session.streamId;
    runtimeSession.executions.stopAgentStream(session.streamId, {
      detachActiveChildren: detachSubagentsOnStop(),
    });
  };

  // Shared tail of the run/resume `.catch()` handlers: surface the error to
  // the local transcript unless the run was stopped intentionally, and set
  // the exit code accordingly.
  const reportRunFailure = (error: unknown): void => {
    // A launch failure already rendered through a targeted presentation
    // (e.g. the model-not-recognized instruction) is marked -- skip the
    // generic transcript line so the TUI doesn't show the same failure twice.
    const resumeFailure = describeResumeFailure(error);
    if (
      !session.stopRequested &&
      !hasErrorPresentedMarker(error) &&
      !hasErrorPresentationPending(error)
    ) {
      appendLocalErrorTranscript(
        resumeFailure.kind === 'lease-active'
          ? resumeFailure.message
          : toErrorMessage(error),
      );
    }
    session.runExitCode = CliExitCode.AgentError;
    if (session.stopRequested) {
      session.runExitCode = CliExitCode.Success;
    } else if (resumeFailure.kind === 'lease-active') {
      session.runExitCode = CliExitCode.Usage;
    }
  };

  // Build the runtime host shared by start and resume. Root completion marks
  // the root row complete and detaches its terminal-result presenter
  // immediately. Host interactions remain attached until every execution that
  // inherited this runtime host settles, so detached children retain a visible,
  // answerable approval path without keeping the completed root turn pending.
  // The runtime owns that "still inherited" fact (see
  // `ExecutionRegistry.interactionOwnership`); this host only claims its root
  // run and reacts to the release.
  const setupRunHost = (
    sessionContext: CliContext,
  ): {
    readonly presentationHost: CliRuntimeHost;
    readonly approvalsUnavailable: boolean;
    readonly ownExecution: (executionId: ExecutionId) => void;
    readonly finalize: () => void;
  } => {
    const presentationHost = createCliRuntimeHost(sessionContext);
    const detachHostInteractions = runtimeSession.useHostInteractions(
      createTuiHostInteractions(presentationHost, sessionContext),
    );
    const detachResultToast = attachTerminalResultToast(
      runtimeSession,
      runtimeSession.interactions,
    );
    let resultToastAttached = true;
    const detachResultToastOnce = (): void => {
      if (!resultToastAttached) return;
      resultToastAttached = false;
      detachResultToast();
    };
    const ownership = runtimeSession.executions.interactionOwnership.open(
      (): void => {
        detachResultToastOnce();
        detachHostInteractions();
        if (session.presentationHost === presentationHost) {
          session.presentationHost = undefined;
        }
        void presentationHost.close();
      },
    );
    disposables.add(() => ownership.release());

    return {
      presentationHost,
      approvalsUnavailable: cliApprovalPromptsUnavailable(
        sessionContext,
        runtimeSession.approvalPolicy,
      ),
      ownExecution: (executionId): void => ownership.claim(executionId),
      finalize: (): void => {
        // The root terminal result is published before its run promise
        // settles. Children retain `isSubagent: true` and never produce a
        // terminal toast, so this session-wide listener has no work after the
        // root finalizes and must not overlap a later root's listener.
        detachResultToastOnce();
        session.markRunCompleted();
        ownership.finish();
      },
    };
  };

  // -----------------------------------------------------------------------
  // startRootRun
  // -----------------------------------------------------------------------

  const startRootRun = (config: AgentConfigPayload): void => {
    void supersedeInterruptedRecovery();
    const sessionContext = beginRunContext(config);
    const { presentationHost, approvalsUnavailable, ownExecution, finalize } =
      setupRunHost(sessionContext);
    const executionId = generateExecutionId();
    ownExecution(executionId);
    session.executionId = executionId;

    const runPromise = Promise.resolve()
      .then(() => AgentConfigSchema.parse(config))
      .then((registeredConfig) =>
        runAgent(
          { kind: 'fresh', config: registeredConfig, executionId },
          {
            enforceCategory: true,
            approvalPromptsUnavailable: approvalsUnavailable,
            onApprovalPolicyDenial: () =>
              warnApprovalDenied(sessionContext, 'Tool or edit approval'),
            runtimeUnavailableTools: getDefaultUnavailableToolNames('cli'),
            onStreamResolved: (resolvedStreamId) => {
              // Each chat round mints a fresh root StreamTabId (new
              // executionId), so bash/tool-edit/super-YOLO bypass — which is
              // keyed per stream — would otherwise reset every round even
              // though the user is continuing the same conversation. Link the
              // new round's stream to the previous one so bypass resolution
              // (see `registerStreamParent`) falls through to whatever the
              // prior round had, unless this round sets its own explicit value.
              const previousRootStreamId = rootStreamId.get();
              if (
                previousRootStreamId &&
                previousRootStreamId !== resolvedStreamId
              ) {
                runtimeSession.approvals.registerStreamParent(
                  resolvedStreamId,
                  previousRootStreamId,
                );
              }
              session.streamId = resolvedStreamId;
              rootStreamId.set(resolvedStreamId);
              moveLocalTranscriptToStream(resolvedStreamId);
              focusStream(resolvedStreamId);
              if (session.stopRequested) interruptActiveRun();
            },
            onIdle: () => {
              if (!session.streamId) return;
              syncStreamLog(session.streamId, { forceFinal: true });
            },
          },
        ),
      )
      .then((result) => {
        session.runExitCode = runOutcomeExitCode(result.outcome);
        if (result.streamId) {
          syncStreamLog(result.streamId, { forceFinal: true });
        }
        notify('agentFinished');
      })
      .catch(reportRunFailure)
      .finally(finalize);
    session.markRunPending(runPromise, presentationHost);
  };

  // -----------------------------------------------------------------------
  // resume
  // -----------------------------------------------------------------------

  const resume = async (
    id: ExecutionId,
    preResolved?: ToolUseResumeData,
  ): Promise<void> => {
    // Claim the root-run slot as the FIRST statement, synchronously, before
    // any `await` below — see tryClaimRootRunSlot. This fuses the
    // availability check and the claim into one atomic step so a concurrent
    // tryResumeStream() (or another resume()) can never observe this call
    // suspended between "checked available" and "claimed", and race in to
    // claim the same slot out from under it.
    const {
      promise: claimedRunPromise,
      resolve: resolveRunPromise,
      reject: rejectRunPromise,
    } = pDefer<void>();
    if (!session.tryClaimRootRunSlot(claimedRunPromise)) {
      appendLocalAssistantTranscript(
        'Finish the active chat before resuming a previous session.',
      );
      return;
    }

    const supersededRecovery = supersedeInterruptedRecovery();
    try {
      // Inline resolution over the shared retrieval (the durable record plus
      // `retrieveSessionResumeData` via the FK-stamped stream id). Workflow
      // runs resume headless through `texra resume`, not inside a chat.
      let resolution = preResolved;
      if (!resolution) {
        const config = await getExecutionStore(id).readConfig();
        let failure: string | undefined;
        if (!config) {
          failure = `Execution not found: ${id}`;
        } else if (config.agentCategory !== AgentCategory.ToolUse) {
          failure = `Execution ${id} is a workflow; resume it with \`texra resume ${id}\`.`;
        } else {
          resolution =
            (await readCliToolUseResumeData(id, config)) ?? undefined;
        }
        if (!resolution) {
          restoreInterruptedRecovery(supersededRecovery);
          appendLocalErrorTranscript(
            failure ??
              `Execution ${id} has no resumable session state (it completed or was cleared).`,
          );
          session.markRunCompleted();
          resolveRunPromise();
          return;
        }
      }

      clearLocalTranscript();
      followUpQueue.clear();
      session.streamId = resolution.streamId;
      session.executionId = resolution.executionId;
      rootStreamId.set(resolution.streamId);

      const sessionContext = beginRunContext(resolution.agentConfig, 'history');

      const loadedStreamsReconcile = beginLoadedStreamsReconcile([
        resolution.streamId,
      ]);

      await runtimeSession.transcripts.ensureLoaded(resolution.streamId);
      try {
        await snapshotStore.load([resolution.streamId]);
      } catch (error) {
        // `load` evicts synchronously before its async seed, so on rejection the
        // evicted markers are stale while the retained root was never seeded.
        loadedStreamsReconcile.dropStale();
        throw error;
      }
      // Drop the markers `load` evicted and mark the retained root before the
      // awaited read/patch can render a stale pre-resume projection.
      loadedStreamsReconcile.reconcile();
      const restored = await snapshotStore.read(resolution.streamId);
      // A rehydrated stream never re-emits `run.start`, so its identity is
      // seeded from the durable store (ExecutionMeta by FK) on this cold
      // read — mirroring `tryResumeStream()`'s seeding.
      const restoredIdentity = snapshotStore.getRunMetadata(
        resolution.streamId,
      ).identity;
      patchStream(resolution.streamId, (slice) => {
        const runUsages = Object.values(restored.runUsage);
        return {
          ...slice,
          ...(restoredIdentity && !slice.identity
            ? { identity: restoredIdentity }
            : {}),
          cumulativeUsage: runUsages.length
            ? sumUsageStats(runUsages)
            : slice.cumulativeUsage,
          todos: restored.todos,
          plan: restored.plan,
        };
      });
      syncStreamLog(resolution.streamId);
      focusStream(resolution.streamId);
      // Re-reconcile now that focus has moved: a stale in-flight preload for the
      // previous stream that re-added it during the awaited read above is cleared
      // again, while any stream preloaded in the meantime is preserved. Later
      // hydrations for the old stream also fail requestIsCurrent.
      loadedStreamsReconcile.reconcile();

      const { presentationHost, approvalsUnavailable, ownExecution, finalize } =
        setupRunHost(sessionContext);
      ownExecution(resolution.executionId);
      session.presentationHost = presentationHost;

      // A Ctrl-C during the rehydration awaits above (resume resolution,
      // `ensureLoaded`, `snapshotStore.load`/`read`) lands here as
      // `session.stopRequested`. Honor it before starting the real run chain —
      // matching `tryResumeStream()`'s stop-check after its own preparatory
      // awaits — instead of starting an agent the user already cancelled.
      if (session.stopRequested) {
        restoreInterruptedRecovery(supersededRecovery);
        finalize();
        resolveRunPromise();
        return;
      }

      const runChain = setCliHelperModel(resolution.agentConfig.model)
        .then(() =>
          resumeToolUseFromResumeData(resolution, {
            approvalPromptsUnavailable: approvalsUnavailable,
            onApprovalPolicyDenial: () =>
              warnApprovalDenied(sessionContext, 'Tool or edit approval'),
            runtimeUnavailableTools: getDefaultUnavailableToolNames('cli'),
            drainedFollowUps: supersededRecovery?.followUps.map((followUp) => ({
              ...followUp,
              origin: 'user' as const,
            })),
            isCancellationRequested: () => session.stopRequested,
          }),
        )
        .then((result) => settleResumedTurn(result.outcome))
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
      restoreInterruptedRecovery(supersededRecovery);
      reportRunFailure(error);
      session.markRunCompleted();
      resolveRunPromise();
    }
  };

  /**
   * One settlement site for a successfully resumed turn: finalize the
   * transcript projection, map the outcome to the exit code, and announce
   * completion. A subagent parking back to WAITING is a completed turn, not
   * a finished agent, so it never fires `agentFinished`.
   */
  const settleResumedTurn = (outcome: TurnOutcome): void => {
    if (session.streamId) {
      syncStreamLog(session.streamId, { forceFinal: true });
    }
    session.runExitCode = runOutcomeExitCode(outcome);
    if (outcome !== STREAM_PHASE.WAITING) {
      notify('agentFinished');
    }
  };

  const tryResumeStream = (
    streamId: StreamTabId,
    options: AutoResumeOptions = {},
  ): Promise<boolean> => {
    // Do not let a recovery wake claim the slot after the interrupted root
    // publishes completion but before that root's teardown settles. The
    // captured promise remains authoritative even if `/clear` resets the
    // mutable session state in the meantime.
    if (options.recovery && recoveryBlockedByInterruptedRuns.size > 0) {
      return Promise.resolve(false);
    }
    const {
      promise: runPromise,
      resolve: resolveRun,
      reject: rejectRun,
    } = pDefer<boolean>();
    // Claim the root-run slot as the FIRST statement, synchronously, before
    // any `await` below — see tryClaimRootRunSlot and the matching comment
    // in resume().
    if (!session.tryClaimRootRunSlot(runPromise.then(() => undefined))) {
      return Promise.resolve(false);
    }
    const attemptCancellation = { cancellationRequested: false };
    activeAutoResumeCancellation = attemptCancellation;
    const isCancellationRequested = (): boolean =>
      attemptCancellation.cancellationRequested || session.stopRequested;

    const runResume = async (): Promise<boolean> => {
      let finalize = (): void => session.markRunCompleted();
      try {
        await snapshotStore.preload([streamId]);
        // Invalidate the memo immediately after the direct seed, before the
        // awaited metadata/patch/focus below can render a stale projection.
        markArtifactStreamHydrated(streamId);
        const runMetadata = snapshotStore.getRunMetadata(streamId);
        const executionId =
          runMetadata.executionId ??
          (await snapshotStore.readPersistedExecutionId(streamId));
        if (!executionId) return false;

        const config =
          runMetadata.config ??
          (await getExecutionStore(executionId).readConfig());
        if (!config) return false;
        if (isCancellationRequested()) return false;
        const parentStreamId = snapshotStore.getParentStreamId(streamId);

        const sessionContext = beginRunContext(config, 'history');

        const runHost = setupRunHost(sessionContext);
        finalize = runHost.finalize;
        const { presentationHost, approvalsUnavailable, ownExecution } =
          runHost;
        ownExecution(executionId);
        session.presentationHost = presentationHost;
        session.streamId = streamId;
        session.executionId = executionId;
        if (!parentStreamId) {
          rootStreamId.set(streamId);
        }
        // A follow-up wake may target a stream the user /clear-ed;
        // resuming it un-retires it (patchStream drops the retired mark),
        // matching the explicit resume path, or focusStream would refuse
        // and the resumed run would stay invisible. A rehydrated stream never
        // re-emits `run.start`, so its identity is seeded from the durable
        // store (ExecutionMeta by FK) on this cold read.
        patchStream(streamId, (slice) =>
          runMetadata.identity && !slice.identity
            ? { ...slice, identity: runMetadata.identity }
            : slice,
        );
        focusStream(streamId);
        session.runExitCode = CliExitCode.Success;

        let resumedOutcome: TurnOutcome = RUN_OUTCOME.COMPLETED;
        const resumed = await setCliHelperModel(config.model).then(() =>
          resolveAndResumeStream(
            streamId,
            {
              streamStatus: runtimeSession.status,
              isCancellationRequested,
              resolveResumeState: async () => ({
                status: 'resolved',
                state: { runState: config, executionId, parentStreamId },
              }),
              resumeToolUse: (resume, claimedRecovery) =>
                resumeQueuedToolUseFromResumeData(streamId, resume, {
                  session: runtimeSession,
                  recovery: claimedRecovery,
                  approvalPromptsUnavailable: approvalsUnavailable,
                  onApprovalPolicyDenial: () =>
                    warnApprovalDenied(sessionContext, 'Tool or edit approval'),
                  runtimeUnavailableTools:
                    getDefaultUnavailableToolNames('cli'),
                  extraFollowUps: options.extraFollowUps,
                  onFollowUpQueueReady: (lease) => {
                    if (options.onFollowUpQueueReady) {
                      options.onFollowUpQueueReady(lease);
                    } else {
                      const recovery = supersedeInterruptedRecovery();
                      restoreRecoveryFollowUps(recovery, lease);
                    }
                  },
                  isCancellationRequested,
                  onResult: (result) => {
                    resumedOutcome = result.outcome;
                  },
                  onError: reportRunFailure,
                  canAcquireResumeLease: () => !isCancellationRequested(),
                }),
              executeWorkflow: async () => {
                throw new Error(
                  'CLI chat cannot auto-resume workflow streams from follow-up wake.',
                );
              },
              reportNoResumableSession: () => {
                appendLocalAssistantTranscript(
                  'Message queued, but that session could not be continued automatically. Resume it with /resume, or start a new task.',
                  streamId,
                );
              },
              reportFailure: (_failedStream, error) => reportRunFailure(error),
            },
            options.recovery,
          ),
        );

        if (resumed) {
          settleResumedTurn(resumedOutcome);
        } else if (isCancellationRequested()) {
          session.runExitCode = CliExitCode.Interrupted;
        }
        return resumed;
      } catch (error: unknown) {
        reportRunFailure(error);
        return false;
      } finally {
        finalize();
        if (activeAutoResumeCancellation === attemptCancellation) {
          activeAutoResumeCancellation = undefined;
        }
      }
    };

    void runResume().then(resolveRun, rejectRun);

    return runPromise;
  };

  const admitInterruptedFollowUp = (
    followUp: InterruptedFollowUp,
  ): InterruptedFollowUpAdmission => {
    if (interruptedContinuation) {
      interruptedContinuation.followUps.push(followUp);
      return {
        kind: 'accepted',
        streamId: interruptedContinuation.streamId,
        completion: interruptedContinuation.completion,
      };
    }

    if (!session.interruptedStreamId) {
      return { kind: 'not_interrupted' };
    }

    const batch: InterruptedContinuationBatch = {
      streamId: session.interruptedStreamId,
      followUps: [...pendingInterruptedFollowUps, followUp],
      completion: Promise.resolve(false),
      superseded: false,
    };
    pendingInterruptedFollowUps = [];
    batch.completion = (async () => {
      await session.runPromise?.catch(() => undefined);
      if (batch.superseded) return true;
      let followUpQueueReady = false;
      try {
        const resumed = await tryResumeStream(batch.streamId, {
          extraFollowUps: batch.followUps,
          onFollowUpQueueReady: () => {
            followUpQueueReady = true;
            session.interruptedStreamId = undefined;
            if (interruptedContinuation === batch) {
              interruptedContinuation = undefined;
            }
          },
        });
        if (!resumed && !batch.superseded && !followUpQueueReady) {
          session.interruptedStreamId = batch.streamId;
          pendingInterruptedFollowUps.push(...batch.followUps);
        }
        return resumed;
      } finally {
        if (interruptedContinuation === batch) {
          interruptedContinuation = undefined;
        }
      }
    })();
    interruptedContinuation = batch;
    return {
      kind: 'accepted',
      streamId: batch.streamId,
      completion: batch.completion,
    };
  };

  // -----------------------------------------------------------------------
  // stop
  // -----------------------------------------------------------------------

  const stop = (): void => {
    blockRecoveryUntilInterruptedRunSettles();
    if (activeAutoResumeCancellation) {
      activeAutoResumeCancellation.cancellationRequested = true;
    }
    session.stopRequested = true;
    interruptActiveRun();
  };

  const stopStream = (streamId: StreamTabId): void => {
    runtimeSession.interactions.cancel({
      streamId,
      cause: 'Run interrupted.',
    });
    if (streamId === session.streamId) {
      blockRecoveryUntilInterruptedRunSettles();
      if (activeAutoResumeCancellation) {
        activeAutoResumeCancellation.cancellationRequested = true;
      }
      session.stopRequested = true;
      session.interruptedStreamId = streamId;
    }
    runtimeSession.executions.stopAgentStream(streamId, {
      detachActiveChildren: true,
    });
  };

  return {
    startRootRun,
    resume,
    stop,
    stopStream,
    admitInterruptedFollowUp,
    clearInterruptedRecovery: () => {
      void supersedeInterruptedRecovery();
    },
    tryResumeStream: (streamId, recovery) =>
      tryResumeStream(streamId, recovery ? { recovery } : {}),
    canStartRootRun: () => chatTuiCanStartRootRun(session),
  };
}
