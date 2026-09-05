// Chat-session controller: owns run start/resume/stop state-transition
// orchestration and the composer's submit path for the CLI chat session.
// Host-neutral (no Ink/TUI rendering dependencies): the Ink component
// consumes narrow commands exposed here.

import { Effect, Option, Stream, SubscriptionRef } from 'effect';
import pDefer from 'p-defer';
import PQueue from 'p-queue';

import { ExecutionLeaseActiveError, getExecutionStore } from '@agent/storage';
import {
  AgentConfigSchema,
  attachTerminalResultToast,
  describeFollowUpFailure,
  detachSubagentsOnStop,
  lookupStreamExecutionId,
  resumeRun,
  runAgent,
  type AgentConfig,
  type AgentConfigPayload,
  type ResumeRunOptions,
  type SessionHandle,
} from '@agent/runtime';
import {
  describeFollowUpFailure as describeFollowUpFailureReason,
  presentFollowUpResult,
  type FollowUpQueueInput,
  type FollowUpRecoveryLease,
} from '@agent/followUp';
import { chatAgentSupportsDelegation } from '@cli/runtime/agents';
import { type CliContext } from '@cli/runtime/cliContext';
import { warnApprovalDenied } from '@cli/runtime/approval/approvalPrompts';
import { cliApprovalPromptsUnavailable } from '@cli/runtime/approval/settleApprovals';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { readCliMultiAgentPresetName } from '@cli/runtime/multiAgentPresets';
import { setCliHelperModel } from '@cli/runtime/initPlatform';
import {
  formatCliNoAvailableModelsRecovery,
  selectCliRunnableModel,
} from '@cli/runtime/modelAccess';
import { createCliRuntimeHost } from '@cli/runtime/cliPresentationHost';
import {
  runOutcomeExitCode,
  type TurnOutcome,
} from '@cli/runtime/terminalStatus';
import { hasErrorPresentationClaimed } from '@common/errors/sdkError/errorMetadata';
import type { RunModelDecisionReason } from '@model/runModelDecision';
import type { DisposableStore } from '@platform/disposable';
import type { RecoveryContinuation } from '@platform/interfaces';
import { effectRuntime } from '@platform/processRuntime';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
  AgentCategory,
} from '@shared/schemas';
import { FOCUSED_BACKGROUND_TASK } from '@shared/copy/nestedRuns';
import type { RuntimeRequest } from '@shared/session/runtimeRequest';
import { escapeText } from '@shared/utils/xmlEscape';
import { getDefaultUnavailableToolNames } from '@tools/registry';
import { StreamSnapshotStore } from '@transcript';
import { generateExecutionId, throwAggregated } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { handleTuiSlashCommand } from './tui/commands/handleSlashCommand';
import {
  CHAT_API_MODE_MODEL_RECOVERY,
  type SlashCommandContext,
} from './tui/commands/handlers/slashContext';
import {
  activeStreamId as activeStreamIdSignal,
  focusStream,
  rootStreamId,
  patchSessionMeta,
  requestDraftRestore,
  sessionMeta as sessionMetaSignal,
  setTransientNotice,
} from './tui/state/cliState';
import {
  chatTuiCanStartRootRun,
  type TuiSession,
} from './tui/state/sessionRunState';
import {
  currentView,
  streamViewOf,
  focusedChildAcceptsFollowUps,
} from './tui/state/sessionView';
import { createTuiHostInteractions } from './tui/state/subscribeApprovals';
import { notify } from './tui/notifications/terminalNotifier';
import {
  appendLocalErrorTranscript,
  appendLocalAssistantTranscript,
  appendLocalUserTranscript,
  clearLocalTranscript,
  describeRequestError,
  moveLocalTranscriptToStream,
} from './tui/state/transcript';
import type { SkillActivation } from './tui/forms/SkillsListForm';
import type { PastedImageEntry } from './tui/input/draftAttachments';

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
   * Fire-and-forget from the Ink perspective, the returned promise settles
   * when the resume resolution and rehydration are complete, but the
   * continued run itself stays pending until the agent finishes or suspends.
   */
  resume(id: ExecutionId): Promise<void>;

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
  /**
   * The composer's submit path (PRD 10.1): a slash command, the first
   * instruction of a fresh root run, a message into an interrupted root, or
   * a `followUp.send` request onto the focused stream.
   */
  submit(
    line: string,
    mediaFiles?: readonly string[],
    images?: readonly PastedImageEntry[],
  ): Promise<void>;
  /** Reserve a skill activation for the next submitted message. */
  activateSkill(selection: SkillActivation): void;
  /** Drop every reserved skill activation. */
  clearPendingSkills(): void;
}

export interface ChatSessionControllerInit {
  /** Mutable session state the controller owns. */
  readonly session: TuiSession;

  /** Runtime session that owns executions, storage, and interactions. */
  readonly runtimeSession: SessionHandle;

  /** Mint a fresh {@link CliContext} for one run (see the identity-keyed
   *  approval-denial dedupe in `warnApprovalDenied`). */
  readonly getSessionContext: () => CliContext;

  /** Disposable owner shared with the TUI session lifecycle. */
  readonly disposables: DisposableStore;

  /** Serial queue for follow-up message delivery (cleared on resume). */
  readonly followUpQueue: PQueue;

  /** Per-stream sidecar persistence store. */
  readonly snapshotStore: StreamSnapshotStore;
  readonly initialAgent: string;
  readonly initialModel: string;
  readonly initialModelSource: RunModelDecisionReason;
  readonly cwd: string;
  readonly getSlashCommandContext: () => SlashCommandContext;
}

interface PreparedChatInstruction {
  readonly instruction: string;
  readonly displayInstruction?: string;
  readonly reservedSkillActivations: readonly SkillActivation[];
}

function takePendingSkillActivations(
  pendingSkillActivations: Map<string, string>,
  line: string,
): PreparedChatInstruction {
  if (pendingSkillActivations.size === 0) {
    return { instruction: line, reservedSkillActivations: [] };
  }
  const entries = [...pendingSkillActivations.entries()].map(
    ([name, activationPrompt]) => ({ name, activationPrompt }),
  );
  pendingSkillActivations.clear();
  const activations = entries
    .map(({ activationPrompt }) => activationPrompt)
    .join('\n\n');
  return {
    instruction: [
      activations,
      '<user_request>',
      escapeText(line),
      '</user_request>',
    ].join('\n'),
    displayInstruction: line,
    reservedSkillActivations: entries,
  };
}

function restorePendingSkillActivations(
  pendingSkillActivations: Map<string, string>,
  activations: readonly SkillActivation[],
): void {
  for (const { name, activationPrompt } of activations) {
    if (!pendingSkillActivations.has(name)) {
      pendingSkillActivations.set(name, activationPrompt);
    }
  }
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
    initialAgent,
    initialModel,
    initialModelSource,
    cwd,
    getSlashCommandContext,
  } = init;
  let interruptedContinuation: InterruptedContinuationBatch | undefined;
  let pendingInterruptedFollowUps: InterruptedFollowUp[] = [];
  const pendingSkillActivations = new Map<string, string>();
  let pendingSkillActivationClearEpoch = 0;

  /** The stream of `executionId`, from the first view level that holds it. */
  const rootStreamOf = (
    executionId: string | undefined,
  ): Promise<StreamTabId | undefined> =>
    executionId === undefined
      ? Promise.resolve(undefined)
      : effectRuntime().runPromise(
          Stream.concat(
            Stream.make(SubscriptionRef.getUnsafe(runtimeSession.view)),
            SubscriptionRef.changes(runtimeSession.view),
          ).pipe(
            Stream.map(
              (view) =>
                [...view.streams.values()].find(
                  (stream) =>
                    stream.parentId === null &&
                    stream.executionId === executionId,
                )?.id,
            ),
            Stream.filter((id): id is StreamTabId => id !== undefined),
            Stream.runHead,
            Effect.map(Option.getOrUndefined),
          ),
        );

  /** Issue one request to the session's runtime and read its Effect result
   *  as the response (PRD 7.6): the refusal text, or undefined on success. */
  const request = (req: RuntimeRequest): Promise<string | undefined> =>
    effectRuntime().runPromise(
      runtimeSession.requests.request(req).pipe(
        Effect.match({
          onFailure: describeRequestError,
          onSuccess: () => undefined,
        }),
      ),
    );

  // Shared prelude of the three run-starting paths (start, resume,
  // follow-up-wake resume): resolve the model-keyed session context and
  // activate the config into the session meta signals in one step.
  const beginRunContext = (
    config: Pick<
      AgentConfig,
      'agent' | 'model' | 'cli' | 'delegationAgentScope'
    >,
    modelSource?: 'history',
  ): CliContext => {
    const sessionContext = getSessionContext();
    const cliMultiAgentPresetId = config.cli?.multiAgentPresetId ?? undefined;
    patchSessionMeta({
      agent: config.agent,
      model: config.model,
      ...(modelSource ? { modelSource } : {}),
      canDelegate: chatAgentSupportsDelegation(config.agent),
      teamName: readCliMultiAgentPresetName(cliMultiAgentPresetId),
      cliMultiAgentPresetId,
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

  /** One owner of the "claimed but never handed off" invariant: a recovery
   *  lease this controller took and never passed to a run must go back as
   *  `'recoverable'`, or the follow-ups typed during the interruption are
   *  lost. Every resume path calls this on its way out. */
  const handBackUnusedRecovery = (
    recovery: FollowUpRecoveryLease | undefined,
    handedOff: boolean,
  ): void => {
    if (
      recovery &&
      !handedOff &&
      runtimeSession.followUps.useRecovery(recovery)
    ) {
      runtimeSession.followUps.release(recovery, 'recoverable');
    }
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

  const requestStop = (): void => {
    blockRecoveryUntilInterruptedRunSettles();
    if (activeAutoResumeCancellation) {
      activeAutoResumeCancellation.cancellationRequested = true;
    }
    session.stopRequested = true;
  };

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  const interruptActiveRun = (): void => {
    runtimeSession.interactions.cancel({ cause: 'Session interrupted.' });
    if (!session.streamId) return;
    session.interruptedStreamId = session.streamId;
    // Ctrl-C is a configured stop surface: the user stopped the root run, so
    // the detach-on-stop toggle decides whether active subagents survive it.
    // `stopStream` below is the other gesture and answers deliberately
    // differently.
    void request({
      kind: 'stream.stop',
      streamId: session.streamId,
      detachActiveChildren: detachSubagentsOnStop(),
    });
  };

  // Shared tail of the run/resume `.catch()` handlers: surface the error to
  // the local transcript unless the run was stopped intentionally, and set
  // the exit code accordingly.
  const reportRunFailure = (error: unknown): void => {
    if (session.stopRequested) {
      session.runExitCode = CliExitCode.Success;
      return;
    }
    // A launch failure already rendered through a targeted presentation
    // (e.g. the model-not-recognized instruction) is marked -- skip the
    // generic transcript line so the TUI doesn't show the same failure twice.
    if (!hasErrorPresentationClaimed(error)) {
      appendLocalErrorTranscript(toErrorMessage(error));
    }
    if (error instanceof ExecutionLeaseActiveError) {
      session.runExitCode = CliExitCode.Usage;
    } else {
      session.runExitCode = CliExitCode.AgentError;
    }
  };

  /** The CLI chat's tool-use run policy, shared by every resume path. */
  const toolUseResumeOptions = (
    sessionContext: CliContext,
    approvalsUnavailable: boolean,
  ): Pick<
    ResumeRunOptions,
    | 'session'
    | 'approvalPromptsUnavailable'
    | 'onApprovalPolicyDenial'
    | 'runtimeUnavailableTools'
    | 'executeWorkflow'
  > => ({
    session: runtimeSession,
    approvalPromptsUnavailable: approvalsUnavailable,
    onApprovalPolicyDenial: () =>
      warnApprovalDenied(sessionContext, 'Tool or edit approval'),
    runtimeUnavailableTools: getDefaultUnavailableToolNames('cli'),
    executeWorkflow: async (_config, executionId) => {
      throw new Error(
        `Execution ${executionId} is a workflow; resume it with \`texra resume ${executionId}\`.`,
      );
    },
  });

  // Every host generation still holding interaction ownership. A generation
  // leaves on release, so session exit releases only the live ones instead of
  // parking one dead closure per root turn in the session store for the
  // process lifetime.
  const liveOwnerships = new Set<{ readonly release: () => void }>();
  disposables.add(() => {
    const failures: unknown[] = [];
    for (const ownership of liveOwnerships) {
      try {
        ownership.release();
      } catch (error) {
        failures.push(error);
      }
    }
    throwAggregated(failures, 'Multiple interaction owners failed to release');
  });

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
    readonly approvalsUnavailable: boolean;
    readonly ownExecution: (executionId: ExecutionId) => void;
    readonly finalize: () => void;
  } => {
    const presentationHost = createCliRuntimeHost(sessionContext);
    const detachHostInteractions = runtimeSession.interactions.use(
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
        liveOwnerships.delete(ownership);
        detachResultToastOnce();
        detachHostInteractions();
        void presentationHost.close();
      },
    );
    liveOwnerships.add(ownership);

    return {
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
    const { approvalsUnavailable, ownExecution, finalize } =
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
              // executionId), so bash/tool-edit/super-YOLO bypass, which is
              // keyed per stream, would otherwise reset every round even
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
          },
        ),
      )
      .then((result) => {
        session.runExitCode = runOutcomeExitCode(result.outcome);
        notify('agentFinished');
      })
      .catch(reportRunFailure)
      .finally(finalize);
    session.markRunPending(runPromise);
  };

  // -----------------------------------------------------------------------
  // resume
  // -----------------------------------------------------------------------

  const resume = async (id: ExecutionId): Promise<void> => {
    // Claim the root-run slot as the FIRST statement, synchronously, before
    // any `await` below, see tryClaimRootRunSlot. This fuses the
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
    let recovery: FollowUpRecoveryLease | undefined;
    let recoveryHandedOff = false;
    try {
      // The durable record names the stream (FK stamped at registration) and
      // the config the TUI adopts before the run. Workflow runs resume
      // headless through `texra resume`, not inside a chat.
      const store = getExecutionStore(id);
      const [config, meta] = await Promise.all([
        store.readConfig(),
        store.readMeta(),
      ]);
      const streamId = meta?.streamId;
      let failure: string | undefined;
      if (!config || !streamId) {
        failure = `Execution not found: ${id}`;
      } else if (config.agentCategory !== AgentCategory.ToolUse) {
        failure = `Execution ${id} is a workflow; resume it with \`texra resume ${id}\`.`;
      }
      if (failure || !config || !streamId) {
        restoreInterruptedRecovery(supersededRecovery);
        appendLocalErrorTranscript(failure ?? `Execution not found: ${id}`);
        session.markRunCompleted();
        resolveRunPromise();
        return;
      }

      recovery = runtimeSession.followUps.claimRecovery(streamId, true);
      if (!recovery) {
        restoreInterruptedRecovery(supersededRecovery);
        appendLocalErrorTranscript(describeFollowUpFailure('not_resumable'));
        session.markRunCompleted();
        resolveRunPromise();
        return;
      }

      const sessionContext = beginRunContext(config, 'history');
      const { approvalsUnavailable, ownExecution, finalize } =
        setupRunHost(sessionContext);
      ownExecution(id);

      // Adopting the resumed stream is the mutation a refusal must not cost.
      // A history row is advertised from its checkpoint file alone (one
      // `stat`, no parse), so a run whose saved state cannot be loaded is
      // offered and refused; `resumeRun` calls this only once that state
      // loaded, so the refusal reaches the chat the user is looking at
      // instead of a cleared transcript switched onto a dead stream. A Ctrl-C
      // during the awaits below lands as `session.stopRequested` and is
      // honored by `isCancellationRequested`, which `resumeRun` re-reads once
      // this returns, rather than starting an agent the user cancelled.
      const adoptResumedStream = async (): Promise<void> => {
        clearLocalTranscript();
        followUpQueue.clear();
        session.streamId = streamId;
        session.executionId = id;
        rootStreamId.set(streamId);
        // The session held no stream until the line above: `markRunPending`,
        // inside the synchronous slot claim at the top of `resume`, dropped
        // the pre-resume one, so a Ctrl-C in the window before adoption could
        // not fabricate an interrupted marker on a stream this resume is
        // leaving behind. It also found nothing to interrupt, so re-read the
        // request here, the way `startRootRun`'s `onStreamResolved` does -
        // and let it land on the run the user asked to continue. `resumeRun`
        // re-reads `isCancellationRequested` once this hook returns, so the
        // stop still refuses the launch; this only decides which stream it
        // marks recoverable.
        if (session.stopRequested) interruptActiveRun();

        await runtimeSession.transcripts.ensureLoaded(streamId);
        // `load` evicts every other record synchronously before its async
        // seed, and the store reports no provenance for an evicted record, so
        // nothing projects an evicted/unseeded stream (or re-emits
        // warnIfUnseeded) mid-seed without any marker bookkeeping here. A
        // previously seeded retained root deliberately keeps its provenance
        // during reseeding: this keeps its canonical pre-resume projection
        // visible at the cost of bounded warnIfUnseeded notices until the seed
        // completes.
        await snapshotStore.load([streamId]);
        // The load re-establishes this stream's work-plan provenance in the
        // store, which is what an open `/plan` reader re-reads to clear its
        // failure-time mask. The transcript itself is the fold's: the TUI
        // subscribes the stream's aggregate and renders `transcript.rows`.
        focusStream(streamId);
      };

      // The seeded batch stays this call's until the stream queue takes it
      // over. Every refusal before that point (the stream already active
      // here, a lost recovery claim, no resumable state, a storage error)
      // hands it back, and `supersedeInterruptedRecovery()` above already
      // cleared the interrupted stream, so the follow-ups typed during the
      // interruption are lost unless both go back where they came from.
      let followUpQueueReady = false;
      const runChain = setCliHelperModel(config.model)
        .then(() => {
          recoveryHandedOff = true;
          return resumeRun(id, {
            ...toolUseResumeOptions(sessionContext, approvalsUnavailable),
            recovery,
            extraFollowUps: supersededRecovery?.followUps,
            onResumeResolved: adoptResumedStream,
            onFollowUpQueueReady: () => {
              followUpQueueReady = true;
            },
            isCancellationRequested: () => session.stopRequested,
          });
        })
        .then((result) => {
          if ('started' in result) {
            settleResumedTurn(result.outcome ?? RUN_OUTCOME.COMPLETED);
          } else if (session.stopRequested) {
            session.runExitCode = CliExitCode.Interrupted;
          } else {
            appendLocalErrorTranscript(describeFollowUpFailure(result.failed));
            session.runExitCode = CliExitCode.Usage;
          }
        })
        .catch(reportRunFailure)
        .finally(() => {
          handBackUnusedRecovery(recovery, recoveryHandedOff);
          if (!followUpQueueReady) {
            restoreInterruptedRecovery(supersededRecovery);
          }
          finalize();
        });
      // `session.runPromise` was already claimed synchronously above with
      // `claimedRunPromise`; forward its settlement to the real run chain so
      // exit-drain's `await session.runPromise` blocks until the continued
      // run actually finishes (or is interrupted), not just until
      // rehydration completes. `resume()`'s own returned promise still
      // settles here, before the run finishes, fire-and-forget per the
      // interface contract.
      runChain.then(resolveRunPromise, rejectRunPromise);
    } catch (error: unknown) {
      handBackUnusedRecovery(recovery, recoveryHandedOff);
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
    // any `await` below, see tryClaimRootRunSlot and the matching comment
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
      let recovery: FollowUpRecoveryLease | undefined;
      let recoveryHandedOff = false;
      try {
        recovery = options.recovery
          ? runtimeSession.followUps.useRecovery(options.recovery)
          : runtimeSession.followUps.claimRecovery(streamId, true);
        if (!recovery) return false;
        await snapshotStore.preload([streamId]);
        const runMetadata = snapshotStore.getRunMetadata(streamId);
        const executionId =
          runMetadata.executionId ??
          (await lookupStreamExecutionId(streamId, runtimeSession));
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
        const { approvalsUnavailable, ownExecution } = runHost;
        ownExecution(executionId);
        session.streamId = streamId;
        session.executionId = executionId;
        if (!parentStreamId) {
          rootStreamId.set(streamId);
        }
        // A follow-up wake may target a stream the user /clear-ed;
        // resuming it un-retires it (the empty patch drops the retired mark),
        // matching the explicit resume path, or focusStream would refuse
        // and the resumed run would stay invisible.
        focusStream(streamId);
        session.runExitCode = CliExitCode.Success;

        const result = await setCliHelperModel(config.model).then(() => {
          recoveryHandedOff = true;
          return resumeRun(executionId, {
            ...toolUseResumeOptions(sessionContext, approvalsUnavailable),
            recovery,
            extraFollowUps: options.extraFollowUps,
            onFollowUpQueueReady: (lease) => {
              if (options.onFollowUpQueueReady) {
                options.onFollowUpQueueReady(lease);
                return;
              }
              const recovery = supersedeInterruptedRecovery();
              runtimeSession.followUps
                .queue(lease)
                .restore(recovery?.followUps ?? []);
              if (recovery?.followUps.length) {
                runtimeSession.followUps.notifySent(lease.streamId);
              }
            },
            isCancellationRequested,
          });
        });

        if ('started' in result && result.delivered) {
          settleResumedTurn(result.outcome ?? RUN_OUTCOME.COMPLETED);
          return true;
        }
        if (isCancellationRequested()) {
          session.runExitCode = CliExitCode.Interrupted;
        }
        return false;
      } catch (error: unknown) {
        reportRunFailure(error);
        return false;
      } finally {
        handBackUnusedRecovery(recovery, recoveryHandedOff);
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
    requestStop();
    interruptActiveRun();
  };

  const stopStream = (streamId: StreamTabId): void => {
    runtimeSession.interactions.cancel({
      streamId,
      cause: 'Run interrupted.',
    });
    if (streamId === session.streamId) {
      requestStop();
      session.interruptedStreamId = streamId;
    }
    void request({ kind: 'stream.stop', streamId, detachActiveChildren: true });
  };

  const startSession = async (
    instruction: string,
    mediaFiles?: readonly string[],
    displayInstruction?: string,
  ): Promise<boolean> => {
    followUpQueue.clear();
    session.executionId = undefined;
    let started = false;
    const pendingStart = Promise.resolve().then(async (): Promise<void> => {
      try {
        const meta = sessionMetaSignal.get();
        const currentAgent = meta.agent || initialAgent;
        const currentModel = meta.model || initialModel;
        const selection = await selectCliRunnableModel(currentModel, {
          fallbackReason: meta.model ? meta.modelSource : initialModelSource,
          noAvailableModelsMessage: formatCliNoAvailableModelsRecovery(
            CHAT_API_MODE_MODEL_RECOVERY,
          ),
        });
        await setCliHelperModel(selection.model);
        if (session.stopRequested) {
          session.markRunCompleted();
          return;
        }
        startRootRun({
          agent: currentAgent,
          model: selection.model,
          instruction,
          ...(displayInstruction !== undefined ? { displayInstruction } : {}),
          agentCategory: AgentCategory.ToolUse,
          workingDirectory: cwd,
          ...(mediaFiles?.length ? { mediaFiles: [...mediaFiles] } : {}),
          ...(meta.cliMultiAgentPresetId
            ? { cli: { multiAgentPresetId: meta.cliMultiAgentPresetId } }
            : {}),
          ...(meta.delegationAgentScope
            ? { delegationAgentScope: meta.delegationAgentScope }
            : {}),
        });
        started = true;
      } catch (error: unknown) {
        if (!session.stopRequested) {
          appendLocalUserTranscript(displayInstruction ?? instruction);
          appendLocalErrorTranscript(toErrorMessage(error));
        }
        session.runExitCode = session.stopRequested
          ? CliExitCode.Success
          : CliExitCode.AgentError;
        session.markRunCompleted();
      }
    });
    session.markRunPending(pendingStart);
    await pendingStart;
    return started;
  };

  /** The focused child, when the composer addresses one: the fold says
   *  whether it takes follow-ups; a rejecting child is announced. */
  const focusedChildTarget = ():
    | { readonly kind: 'none' }
    | {
        readonly kind: 'accept' | 'reject';
        readonly streamId: StreamTabId;
      } => {
    const streamId = activeStreamIdSignal.get();
    const stream = streamViewOf(currentView(), streamId);
    if (!stream || stream.parentId === null) return { kind: 'none' };
    return {
      kind: focusedChildAcceptsFollowUps(stream) ? 'accept' : 'reject',
      streamId: stream.id,
    };
  };

  const submitChatMessage = async (
    line: string,
    mediaFiles?: readonly string[],
    images?: readonly PastedImageEntry[],
  ): Promise<void> => {
    const focusedChild = focusedChildTarget();
    if (focusedChild.kind === 'reject') {
      appendLocalAssistantTranscript(
        FOCUSED_BACKGROUND_TASK.selectedNoLongerAccepting,
        focusedChild.streamId,
      );
      return;
    }
    const childFollowUpTarget =
      focusedChild.kind === 'accept' ? focusedChild.streamId : undefined;
    const prepared = takePendingSkillActivations(pendingSkillActivations, line);
    const skillActivationClearEpoch = pendingSkillActivationClearEpoch;
    const restoreReservedSkillActivations = (): void => {
      if (skillActivationClearEpoch !== pendingSkillActivationClearEpoch) {
        return;
      }
      restorePendingSkillActivations(
        pendingSkillActivations,
        prepared.reservedSkillActivations,
      );
    };
    if (!childFollowUpTarget) {
      const interruptedAdmission = admitInterruptedFollowUp({
        text: prepared.instruction,
        mediaFiles,
        displayText: prepared.displayInstruction,
      });
      if (interruptedAdmission.kind === 'accepted') {
        const resumed = await interruptedAdmission.completion;
        if (resumed) return;
        restoreReservedSkillActivations();
        appendLocalAssistantTranscript(
          'The interrupted conversation could not be restored. Use /resume to retry it, or /clear to start a new conversation.',
          interruptedAdmission.streamId,
        );
        return;
      }
    }
    if (!childFollowUpTarget && chatTuiCanStartRootRun(session)) {
      const started = await startSession(
        prepared.instruction,
        mediaFiles,
        prepared.displayInstruction,
      );
      if (!started) restoreReservedSkillActivations();
      return;
    }
    void followUpQueue.add(async () => {
      let delivered = false;
      let followUpTarget = childFollowUpTarget;
      try {
        // The fold states when the pending run's stream exists: the first
        // view level holding the stream of the execution this controller
        // minted, unless the run settles first.
        followUpTarget ??= await Promise.race([
          rootStreamOf(session.executionId),
          session.runPromise?.then(() => undefined),
        ]);
        if (session.stopRequested) {
          requestDraftRestore(line, images);
          return;
        }
        if (!followUpTarget) {
          requestDraftRestore(line, images);
          setTransientNotice(
            'The conversation ended before the message could be sent. The message has been restored to the input.',
            { ttlMs: Infinity },
          );
          return;
        }
        const outcome = await effectRuntime().runPromise(
          runtimeSession.requests
            .request({
              kind: 'followUp.send',
              streamId: followUpTarget,
              text: prepared.instruction,
              displayText: prepared.displayInstruction,
              mediaFiles: mediaFiles ? [...mediaFiles] : undefined,
            })
            .pipe(
              Effect.match({
                onFailure: (error) => ({
                  refused: describeRequestError(error),
                }),
                onSuccess: (value) => ({ refused: undefined, value }),
              }),
            ),
        );
        if (
          outcome.refused === undefined &&
          outcome.value.kind === 'followUp'
        ) {
          runtimeSession.followUps.notifySent(followUpTarget);
          delivered = true;
          const presentation = presentFollowUpResult(
            outcome.value.status === 'sent'
              ? { status: 'sent' }
              : { status: 'queued', wake: outcome.value.wake ?? undefined },
          );
          if (presentation.severity !== 'none') {
            appendLocalAssistantTranscript(
              presentation.message,
              followUpTarget,
            );
          }
        } else {
          requestDraftRestore(line, images);
          setTransientNotice(
            `${outcome.refused ?? describeFollowUpFailureReason('not_resumable')} The message has been restored to the input.`,
            { ttlMs: Infinity },
          );
          if (followUpTarget === session.streamId) {
            session.stopRequested = true;
          } else {
            appendLocalAssistantTranscript(
              FOCUSED_BACKGROUND_TASK.selectedNoLongerAccepting,
              followUpTarget,
            );
          }
        }
      } finally {
        if (!delivered) restoreReservedSkillActivations();
      }
    });
  };

  const submit = async (
    line: string,
    mediaFiles?: readonly string[],
    images?: readonly PastedImageEntry[],
  ): Promise<void> => {
    if (await handleTuiSlashCommand(line, getSlashCommandContext())) return;
    await submitChatMessage(line, mediaFiles, images);
  };

  const activateSkill = (selection: SkillActivation): void => {
    const wasPending = pendingSkillActivations.has(selection.name);
    pendingSkillActivations.set(selection.name, selection.activationPrompt);
    appendLocalAssistantTranscript(
      [
        `Skill ${wasPending ? 'refreshed' : 'activated'}: ${selection.name}.`,
        'It will be applied to your next message.',
      ].join(' '),
    );
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
    submit,
    activateSkill,
    clearPendingSkills: () => {
      pendingSkillActivationClearEpoch += 1;
      pendingSkillActivations.clear();
    },
  };
}
