// Chat-session controller: owns run start/resume/stop state-transition
// orchestration and the composer's submit path for the CLI chat session.
// Host-neutral (no Ink/TUI rendering dependencies): the Ink component
// consumes narrow commands exposed here.

import {
  Cause,
  Data,
  Deferred,
  Effect,
  Exit,
  Option,
  Stream,
  SubscriptionRef,
} from 'effect';

import { getRunRecords } from '@agent/storage';
import {
  AgentConfigSchema,
  attachTerminalResultToast,
  describeFollowUpFailure,
  detachSubagentsOnStop,
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
import {
  AgentResumeFailed,
  StateWriteFailed,
  type AgentResumePort,
  type RecoveryContinuation,
  type StateStore,
} from '@platform/interfaces';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  RUN_OUTCOME,
  RUN_PHASE,
  type RunId,
  AgentCategory,
} from '@shared/schemas';
import {
  DatabaseClaimRefused,
  DatabaseWriteFailed,
} from '@shared/session/database';
import type { RuntimeRequest } from '@shared/session/runtimeRequest';
import { escapeText } from '@shared/utils/xmlEscape';
import { getDefaultUnavailableToolNames } from '@tools/registry';
import { FOCUSED_BACKGROUND_TASK } from '@ui/copy/nestedRuns';
import { generateRunId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { handleTuiSlashCommand } from './tui/commands/handleSlashCommand';
import {
  CHAT_API_MODE_MODEL_RECOVERY,
  type SlashCommandContext,
} from './tui/commands/handlers/slashContext';
import {
  activeRunId as activeRunIdSignal,
  focusRun,
  rootRunId,
  patchSessionMeta,
  requestDraftRestore,
  sessionMeta as sessionMetaSignal,
  setTransientNotice,
} from './tui/state/cliState';
import {
  chatTuiCanStartRootRun,
  type RootRunSettled,
  type TuiSession,
} from './tui/state/sessionRunState';
import {
  currentView,
  runViewOf,
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
  moveLocalTranscriptToRun,
  reportRequestDefect,
} from './tui/state/transcript';
import type { FollowUpDeliveryQueue } from './followUpDeliveryQueue';
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
      readonly runId: RunId;
      readonly completion: Deferred.Deferred<boolean, AgentResumeFailed>;
    };

interface InterruptedContinuationBatch {
  readonly runId: RunId;
  readonly followUps: InterruptedFollowUp[];
  /** Settled with the continuation's own exit, so a waiter reads what the
   *  resume did rather than what a promise adapter made of it. */
  readonly completion: Deferred.Deferred<boolean, AgentResumeFailed>;
  superseded: boolean;
}

interface SupersededInterruptedRecovery {
  readonly runId: RunId;
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
 * The recovery tail every run/resume program below shares. A typed failure
 * from a host call and a throw from the imperative body alike reach
 * `recover` with the original value, which is exactly what the `try`/`catch`
 * around these bodies did before they became programs. Interruption is not
 * folded in: a fiber the runtime is tearing down is not a run failure to
 * report, and the caller's own settlement still sees it.
 */
/**
 * A chat-session host call this controller drives faulted. The model
 * selection reads the process stores, which does not report a normal outcome
 * this way.
 */
class ChatSessionCallFailed extends Data.TaggedError('ChatSessionCallFailed')<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/**
 * Hand a run program's own exit to the deferred the root-run slot holds. The
 * slot is claimed before the program that settles it exists, so every launch
 * and resume path ends the same way: success, failure, defect and
 * interruption reach the waiters unchanged, with no promise in between.
 */
const settleClaimOnExit =
  <A, E>(claim: Deferred.Deferred<A, E>) =>
  <R>(program: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    program.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          Deferred.doneUnsafe(claim, exit);
        }),
      ),
    );

const recoverRun = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  recover: (error: unknown) => A,
): Effect.Effect<A, E, R> =>
  program.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.sync(() => recover(Cause.squash(cause))),
    ),
  );

/**
 * Narrow commands the chat-session controller exposes to the Ink component.
 * Every mutation to {@link TuiSession} flows through one of these methods so
 * the Ink layer never directly mutates session run-state fields.
 */
export interface ChatSessionController {
  /** Start a new root agent run from a fresh config. */
  startRootRun(config: AgentConfigPayload): void;

  /**
   * Resume a suspended tool-use session by run id.
   *
   * Fire-and-forget from the Ink perspective, the returned program completes
   * when the resume resolution and rehydration are complete, but the
   * continued run itself stays pending until the agent finishes or suspends.
   */
  resume(id: RunId): Effect.Effect<void, unknown>;

  /** Request stop of the root run using the configured child policy. */
  stop(): void;

  /** Stop one user-focused stream while preserving other agent runs. */
  stopRun(runId: RunId): void;

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
   * Attempt to resume a queued follow-up target. This is the CLI's
   * agent-resume port while a chat is mounted, so it is the port's own
   * program: it answers true only when this controller accepts the target
   * resume, and it claims the root-run slot in its first synchronous step.
   */
  readonly tryResumeRun: AgentResumePort['tryResumeRun'];
  /**
   * The composer's submit path (PRD 10.1): a slash command, the first
   * instruction of a fresh root run, a message into an interrupted root, or
   * a `followUp.send` request onto the focused stream.
   */
  submit(
    line: string,
    mediaFiles?: readonly string[],
    images?: readonly PastedImageEntry[],
  ): Effect.Effect<void, unknown, ProcessServices>;
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

  /** The chat session's {@link CliContext}, read once: the controller
   *  attaches one interaction host for the session's lifetime. */
  readonly getSessionContext: () => CliContext;

  /** Disposable owner shared with the TUI session lifecycle. */
  readonly disposables: DisposableStore;

  /** Serial queue for follow-up message delivery (cleared on resume). */
  readonly followUpQueue: FollowUpDeliveryQueue;

  readonly initialAgent: string;
  readonly initialModel: string;
  readonly initialModelSource: RunModelDecisionReason;
  readonly cwd: string;
  readonly getSlashCommandContext: () => SlashCommandContext;
  /**
   * The process secret store and the three setting slots a retry's credential
   * work reads, threaded from the `CliPlatformServices` the chat entry point
   * already holds rather than looked up again here.
   */
  readonly secrets: PlatformSecrets;
  readonly stores: SettingsStores;
  /** The process runtime this controller runs its programs on, captured once
   *  here: the controller lives for the length of the chat session, and its
   *  Promise-facing methods are that session's run edge. */
  readonly runtime: ProcessRuntime;
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
    initialAgent,
    initialModel,
    initialModelSource,
    cwd,
    getSlashCommandContext,
    secrets,
    stores,
    runtime,
  } = init;
  let interruptedContinuation: InterruptedContinuationBatch | undefined;
  let pendingInterruptedFollowUps: InterruptedFollowUp[] = [];
  const pendingSkillActivations = new Map<string, string>();
  let pendingSkillActivationClearEpoch = 0;

  /** `runId` once the fold holds it, from the first view level that does. */
  const awaitRunFolded = (
    runId: RunId | undefined,
  ): Effect.Effect<RunId | undefined> =>
    runId === undefined
      ? Effect.succeed(undefined)
      : Stream.concat(
          Stream.make(SubscriptionRef.getUnsafe(runtimeSession.view)),
          SubscriptionRef.changes(runtimeSession.view),
        ).pipe(
          Stream.filter((view) => view.runs.has(runId)),
          Stream.runHead,
          Effect.map((head) => (Option.isSome(head) ? runId : undefined)),
        );

  /** Issue one request to the session's runtime and read its Effect result
   *  as the response (PRD 7.6): the refusal text, or undefined on success. */
  const request = (req: RuntimeRequest): Effect.Effect<string | undefined> =>
    runtimeSession.requests.request(req).pipe(
      Effect.match({
        onFailure: describeRequestError,
        onSuccess: () => undefined,
      }),
    );

  /** Publish the configuration of the conversation the TUI adopts. */
  const adoptRunConfig = (
    config: Pick<
      AgentConfig,
      'agent' | 'model' | 'cli' | 'delegationAgentScope'
    >,
    modelSource?: 'history',
  ): void => {
    const cliMultiAgentPresetId = config.cli?.multiAgentPresetId ?? undefined;
    patchSessionMeta({
      agent: config.agent,
      model: config.model,
      ...(modelSource ? { modelSource } : {}),
      teamName: readCliMultiAgentPresetName(
        runtimeSession.roots.workspaceState,
        cliMultiAgentPresetId,
      ),
      cliMultiAgentPresetId,
      delegationAgentScope: config.delegationAgentScope ?? undefined,
    });
  };

  const supersedeInterruptedRecovery = ():
    SupersededInterruptedRecovery | undefined => {
    const runId = session.interruptedRunId;
    const followUps = [
      ...pendingInterruptedFollowUps,
      ...(interruptedContinuation?.followUps ?? []),
    ];
    pendingInterruptedFollowUps = [];
    if (interruptedContinuation) {
      interruptedContinuation.superseded = true;
      interruptedContinuation = undefined;
    }
    session.interruptedRunId = undefined;
    return runId ? { runId, followUps } : undefined;
  };

  const restoreInterruptedRecovery = (
    recovery: SupersededInterruptedRecovery | undefined,
  ): void => {
    const runId = session.interruptedRunId ?? recovery?.runId;
    if (!runId) return;
    session.interruptedRunId = runId;
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

  // A cancelled root can publish completion just before its run settles.
  // During that narrow interval its teardown can still overwrite a
  // successor's root-slot state. Retain every unsettled interrupted generation
  // so a later interruption cannot discard an earlier blocker.
  const recoveryBlockedByInterruptedRuns = new Set<RootRunSettled>();
  const blockRecoveryUntilInterruptedRunSettles = (): void => {
    const interruptedRun = session.runSettled;
    if (
      !interruptedRun ||
      session.runCompleted ||
      recoveryBlockedByInterruptedRuns.has(interruptedRun)
    ) {
      return;
    }
    recoveryBlockedByInterruptedRuns.add(interruptedRun);
    runtime.runFork(
      interruptedRun.pipe(
        Effect.exit,
        Effect.map(() => {
          recoveryBlockedByInterruptedRuns.delete(interruptedRun);
        }),
      ),
    );
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
    // The run id is known from the mint, but a stop can only land on a run
    // the fold holds; `onRunResolved` re-reads `stopRequested` for a stop
    // asked in the launch gap.
    const runId = session.runId;
    if (!runId || !runViewOf(currentView(), runId)) return;
    session.interruptedRunId = runId;
    // Ctrl-C is a configured stop surface: the user stopped the root run, so
    // the detach-on-stop toggle decides whether active subagents survive it.
    // `stopRun` below is the other gesture and answers deliberately
    // differently.
    runtime.runFork(
      request({
        kind: 'run.stop',
        runId,
        detachActiveChildren: detachSubagentsOnStop(runtimeSession.roots),
      }),
    );
  };

  // Shared tail of the run/resume failure recovery: surface the error to
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
    if (
      error instanceof DatabaseWriteFailed &&
      error.cause instanceof DatabaseClaimRefused
    ) {
      session.runExitCode = CliExitCode.Usage;
    } else {
      session.runExitCode = CliExitCode.AgentError;
    }
  };

  // One interaction host for the chat session's lifetime, as the extension
  // and desktop attach theirs. The session routes every request to its last
  // attachment, so a detached child of an earlier turn keeps an answerable
  // approval path after its root finalizes, with no per-turn generation.
  const sessionContext = getSessionContext();
  const presentationHost = createCliRuntimeHost(runtime, sessionContext);
  disposables.add(() => {
    runtime.runFork(presentationHost.close());
  });
  disposables.add(
    runtime.runSync(
      runtimeSession.interactions.use(
        createTuiHostInteractions(presentationHost, sessionContext, {
          session: runtimeSession,
          secrets,
          settings: stores,
          runtime,
        }),
      ),
    ),
  );

  /** The CLI chat's tool-use run policy, shared by every resume path. */
  const toolUseResumeOptions = (
    launchRunId: RunId,
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
      warnApprovalDenied(
        runtimeSession,
        sessionContext,
        'Tool or edit approval',
        launchRunId,
      ),
    runtimeUnavailableTools: getDefaultUnavailableToolNames('cli'),
    executeWorkflow: (_config, runId) =>
      Effect.fail(
        new Error(
          `Run ${runId} is a workflow; resume it with \`texra resume ${runId}\`.`,
        ),
      ),
  });

  // Per launch: attach the root's terminal-result presenter until it
  // finalizes. The root terminal result is
  // published before its run promise settles, and children (runs with a
  // parent) never toast, so the listener has no work after the root finalizes
  // and must not overlap a later root's listener.
  const setupRunHost = (): {
    readonly approvalsUnavailable: boolean;
    readonly finalize: () => void;
  } => {
    const detachResultToast = attachTerminalResultToast(
      runtimeSession,
      runtimeSession.interactions,
    );
    return {
      approvalsUnavailable: cliApprovalPromptsUnavailable(
        sessionContext,
        runtimeSession.approvalPolicy,
      ),
      finalize: (): void => {
        detachResultToast();
        session.markRunCompleted();
      },
    };
  };

  // -----------------------------------------------------------------------
  // startRootRun
  // -----------------------------------------------------------------------

  const startRootRun = (config: AgentConfigPayload): void => {
    void supersedeInterruptedRecovery();
    adoptRunConfig(config);
    const { approvalsUnavailable, finalize } = setupRunHost();
    const runId = generateRunId();

    // The slot has to be claimed before the chain that settles it exists, so
    // the claim holds the `await` of a `Deferred` the run chain completes.
    // Awaiting the deferred is a plain suspension, so a run parked at the WAIT
    // node leaves the slot pending exactly as before.
    const claimedRun = Deferred.makeUnsafe<void, unknown>();
    // Native launch may resolve its stream on this turn. Claim first so
    // marking the run pending cannot erase that run or a reentrant stop.
    session.markRunPending(Deferred.await(claimedRun));
    session.runId = runId;
    runtime.runFork(
      recoverRun(
        Effect.try(() => AgentConfigSchema.parse(config)).pipe(
          Effect.flatMap((registeredConfig) =>
            runAgent(
              { kind: 'fresh', config: registeredConfig, runId },
              {
                session: runtimeSession,
                enforceCategory: true,
                approvalPromptsUnavailable: approvalsUnavailable,
                onApprovalPolicyDenial: () =>
                  warnApprovalDenied(
                    runtimeSession,
                    sessionContext,
                    'Tool or edit approval',
                    runId,
                  ),
                runtimeUnavailableTools: getDefaultUnavailableToolNames('cli'),
                onRunResolved: (resolvedRunId) => {
                  // Each chat round mints a fresh root run id, so
                  // bash/tool-edit/super-YOLO bypass, which is
                  // keyed per stream, would otherwise reset every round even
                  // though the user is continuing the same conversation. Link the
                  // new round's stream to the previous one so bypass resolution
                  // (see `registerRunParent`) falls through to whatever the
                  // prior round had, unless this round sets its own explicit value.
                  const previousRootRunId = rootRunId.get();
                  if (
                    previousRootRunId &&
                    previousRootRunId !== resolvedRunId
                  ) {
                    runtimeSession.approvals.registerRunParent(
                      resolvedRunId,
                      previousRootRunId,
                    );
                  }
                  rootRunId.set(resolvedRunId);
                  moveLocalTranscriptToRun(resolvedRunId);
                  focusRun(resolvedRunId);
                  if (session.stopRequested) interruptActiveRun();
                },
              },
            ),
          ),
          Effect.map((result) => {
            session.runExitCode = runOutcomeExitCode(result.outcome);
            notify('agentFinished');
          }),
        ),
        reportRunFailure,
      ).pipe(
        Effect.ensuring(Effect.sync(finalize)),
        // The claim settles with the run's own exit, so a waiter reads what
        // the run did rather than what a promise adapter made of it.
        settleClaimOnExit(claimedRun),
      ),
    );
  };

  // -----------------------------------------------------------------------
  // resume
  // -----------------------------------------------------------------------

  // Deliberately not folded together with `tryResumeRun` below. The two read
  // as near-duplicates because they call the same helpers in a similar order,
  // but every step that touches the recovery lease differs, and the
  // differences are the contracts, not incidental drift:
  //  - Completion contract. This program forks the run chain and completes at
  //    rehydration (fire-and-forget, per the interface docstring); the port
  //    awaits its deferred so its caller reads a boolean, and classifies a
  //    defect into `AgentResumeFailed` for the caller's retry decision.
  //  - Recovery transfer. A manual resume supersedes unconditionally in its
  //    synchronous prologue, seeds the batch into `resumeRun` as
  //    `extraFollowUps`, and restores it whenever the stream queue never took
  //    over. A wake supersedes only when the caller passed no queue-ready
  //    callback, writes the batch through `submitBatch` before resuming, and
  //    restores only when that one write fails or is refused. Two protocols,
  //    two restore predicates.
  //  - Adoption point. Config is adopted inside `onResumeResolved`, which
  //    `resumeRun` calls after it claims ownership and only once the saved
  //    state loaded, so a row advertised from its checkpoint `stat` alone can
  //    still be refused into the chat the user is looking at. A wake adopts
  //    before the call and leaves the local transcript alone.
  //  - Refusals. A manual resume names its reason in the transcript (missing
  //    run, workflow category, lost recovery claim) and leaves the exit code
  //    untouched; a wake answers `false` silently and has no category check.
  // Unifying them takes one knob per bullet, and those knobs would sit on the
  // `handBackUnusedRecovery` / `restoreInterruptedRecovery` pairing, where a
  // double hand-back or a missed restore silently loses the follow-ups typed
  // during an interruption. The shared parts are already named helpers
  // (`setupRunHost`, `toolUseResumeOptions`, `settleResumedTurn`,
  // `recoverRun`, the two lease helpers above); what is left here genuinely
  // differs. Don't merge these two bodies.
  const resume = (id: RunId): Effect.Effect<void, unknown> =>
    // `Effect.suspend` is what keeps the claim handshake synchronous: its
    // body is this program's first step, so the availability check and the
    // claim are one uninterrupted synchronous callback (see
    // tryClaimRootRunSlot) that no other fiber can land between, and a
    // concurrent tryResumeRun() (or another resume()) can never observe this
    // call suspended between "checked available" and "claimed".
    Effect.suspend(() => {
      const claimedRun = Deferred.makeUnsafe<void, unknown>();
      if (!session.tryClaimRootRunSlot(Deferred.await(claimedRun))) {
        // The slot is taken, so the deferred this attempt made is dropped
        // unsettled: nothing holds it, and no fiber is parked on it.
        appendLocalAssistantTranscript(
          'Finish the active chat before resuming a previous session.',
        );
        return Effect.void;
      }

      const supersededRecovery = supersedeInterruptedRecovery();
      let recovery: FollowUpRecoveryLease | undefined;
      let recoveryHandedOff = false;
      /** The end of a resume that never reached its run: hand back an untaken
       *  lease, restore the superseded recovery, announce, complete, settle. */
      const endResumeUnstarted = (announce: () => void): void => {
        handBackUnusedRecovery(recovery, recoveryHandedOff);
        restoreInterruptedRecovery(supersededRecovery);
        announce();
        session.markRunCompleted();
        Deferred.doneUnsafe(claimedRun, Effect.void);
      };
      const attemptResume = Effect.gen(function* () {
        // The durable record carries the config the TUI adopts before the run.
        // Workflow runs resume headless through `texra resume`, not inside a
        // chat.
        const store = getRunRecords(runtimeSession, id);
        const [config, exists] = yield* Effect.all([
          store.readConfig(),
          store.exists(),
        ]);
        const refuseResume = (reason: string): void =>
          endResumeUnstarted(() => appendLocalErrorTranscript(reason));
        if (!config || !exists) {
          refuseResume(`Run not found: ${id}`);
          return;
        }
        if (config.agentCategory !== AgentCategory.ToolUse) {
          refuseResume(
            `Run ${id} is a workflow; resume it with \`texra resume ${id}\`.`,
          );
          return;
        }

        recovery = runtimeSession.followUps.claimRecovery(id, true);
        if (!recovery) {
          refuseResume(describeFollowUpFailure('not_resumable'));
          return;
        }

        const { approvalsUnavailable, finalize } = setupRunHost();

        // Adopting the resumed stream is the mutation a refusal must not cost.
        // A history row is advertised from its checkpoint file alone (one
        // `stat`, no parse), so a run whose saved state cannot be loaded is
        // offered and refused; `resumeRun` calls this only once that state
        // loaded, so the refusal reaches the chat the user is looking at
        // instead of a cleared transcript switched onto a dead stream. A Ctrl-C
        // during the steps below lands as `session.stopRequested` and is
        // honored by `isCancellationRequested`, which `resumeRun` re-reads once
        // this returns, rather than starting an agent the user cancelled.
        const adoptResumedRun = Effect.fn('adoptResumedRun')(function* () {
          yield* setCliHelperModel(stores.globalState, config.model);
          adoptRunConfig(config, 'history');
          clearLocalTranscript();
          followUpQueue.clear();
          session.runId = id;
          rootRunId.set(id);
          // The session held no stream until the line above: `markRunPending`,
          // inside the synchronous slot claim at the top of `resume`, dropped
          // the pre-resume one, so a Ctrl-C in the window before adoption could
          // not fabricate an interrupted marker on a stream this resume is
          // leaving behind. It also found nothing to interrupt, so re-read the
          // request here, the way `startRootRun`'s `onRunResolved` does -
          // and let it land on the run the user asked to continue. `resumeRun`
          // re-reads `isCancellationRequested` once this hook returns, so the
          // stop still refuses the launch; this only decides which stream it
          // marks recoverable.
          if (session.stopRequested) interruptActiveRun();

          yield* runtimeSession.transcripts.ensureLoaded(id);
          // The transcript and the work plan are the fold's: the TUI
          // subscribes the run's aggregate and renders `transcript.rows`, and
          // an open `/plan` reader reads the same `RunView`.
          focusRun(id);
        });

        // The seeded batch stays this call's until the stream queue takes it
        // over. Every refusal before that point (the stream already active
        // here, a lost recovery claim, no resumable state, a storage error)
        // hands it back, and `supersedeInterruptedRecovery()` above already
        // cleared the interrupted stream, so the follow-ups typed during the
        // interruption are lost unless both go back where they came from.
        let followUpQueueReady = false;
        runtime.runFork(
          Effect.gen(function* () {
            recoveryHandedOff = true;
            const result = yield* resumeRun(id, {
              ...toolUseResumeOptions(id, approvalsUnavailable),
              recovery,
              extraFollowUps: supersededRecovery?.followUps,
              onResumeResolved: adoptResumedRun,
              onFollowUpQueueReady: () => {
                followUpQueueReady = true;
              },
              isCancellationRequested: () => session.stopRequested,
            });
            if ('started' in result) {
              settleResumedTurn(result.outcome ?? RUN_OUTCOME.COMPLETED);
            } else if (session.stopRequested) {
              session.runExitCode = CliExitCode.Interrupted;
            } else {
              appendLocalErrorTranscript(
                describeFollowUpFailure(result.failed),
              );
              session.runExitCode = CliExitCode.Usage;
            }
          }).pipe(
            Effect.catch((error) => Effect.sync(() => reportRunFailure(error))),
            Effect.ensuring(
              Effect.sync(() => {
                handBackUnusedRecovery(recovery, recoveryHandedOff);
                if (!followUpQueueReady) {
                  restoreInterruptedRecovery(supersededRecovery);
                }
                finalize();
              }),
            ),
            // The slot was claimed synchronously above; it settles with this
            // chain, so the exit drain blocks until the continued run actually
            // finishes (or is interrupted), not just until rehydration
            // completes. `resume()`'s own program still completes here, before
            // the run finishes, fire-and-forget per the interface contract.
            settleClaimOnExit(claimedRun),
          ),
        );
      });
      return recoverRun(attemptResume, (error) => {
        endResumeUnstarted(() => reportRunFailure(error));
      });
    });

  /**
   * One settlement site for a successfully resumed turn: finalize the
   * transcript projection, map the outcome to the exit code, and announce
   * completion. A subagent parking back to WAITING is a completed turn, not
   * a finished agent, so it never fires `agentFinished`.
   */
  const settleResumedTurn = (outcome: TurnOutcome): void => {
    session.runExitCode = runOutcomeExitCode(outcome);
    if (outcome !== RUN_PHASE.WAITING) {
      notify('agentFinished');
    }
  };

  /**
   * The controller's implementation of the CLI's agent-resume port.
   *
   * `Effect.suspend` is what keeps the claim handshake synchronous: its body
   * is the program's first step, so the availability check and the claim are
   * one uninterrupted synchronous callback that no other fiber can land
   * between. The program then suspends on the deferred the detached run
   * chain settles, so the caller's own fiber never carries the resumed turn
   * and an interrupted caller cannot interrupt a started resume.
   */
  const tryResumeRun = (
    runId: RunId,
    options: AutoResumeOptions = {},
  ): Effect.Effect<boolean, AgentResumeFailed> =>
    Effect.suspend(() => {
      // Do not let a recovery wake claim the slot after the interrupted root
      // publishes completion but before that root's teardown settles. The
      // captured settlement remains authoritative even if `/clear` resets the
      // mutable session state in the meantime.
      if (options.recovery && recoveryBlockedByInterruptedRuns.size > 0) {
        return Effect.succeed(false);
      }
      const autoResumeRun = Deferred.makeUnsafe<boolean, AgentResumeFailed>();
      // Claim the root-run slot as the FIRST statement of this step, before
      // the program suspends below, see tryClaimRootRunSlot and the matching
      // comment in resume().
      if (
        !session.tryClaimRootRunSlot(
          Effect.asVoid(Deferred.await(autoResumeRun)),
        )
      ) {
        // Same as in resume(): the deferred this attempt made is dropped
        // unsettled, since no resume path will complete it now.
        return Effect.succeed(false);
      }
      const attemptCancellation = { cancellationRequested: false };
      activeAutoResumeCancellation = attemptCancellation;
      const isCancellationRequested = (): boolean =>
        attemptCancellation.cancellationRequested || session.stopRequested;

      let finalize = (): void => session.markRunCompleted();
      let recovery: FollowUpRecoveryLease | undefined;
      let recoveryHandedOff = false;
      const attempt = Effect.gen(function* () {
        recovery = options.recovery
          ? runtimeSession.followUps.useRecovery(options.recovery)
          : runtimeSession.followUps.claimRecovery(runId, true);
        if (!recovery) return false;
        // Transfer accepted input before hydration yields. A waiting admission
        // must see the new queue owner before it can attempt a second resume.
        if (!options.onFollowUpQueueReady) {
          const previous = supersedeInterruptedRecovery();
          if (previous?.followUps.length) {
            // One admission, one transaction: the batch is queued whole, or
            // nothing was written and it stays this controller's.
            const submitted = yield* runtimeSession.followUps
              .submitBatch(runId, previous.followUps, 'live_owner')
              .pipe(
                Effect.tapError(() =>
                  Effect.sync(() => restoreInterruptedRecovery(previous)),
                ),
              );
            if (submitted.kind === 'refused') {
              restoreInterruptedRecovery(previous);
              return false;
            }
            runtimeSession.followUps.notifySent(recovery.runId);
          }
        }

        const config = yield* getRunRecords(runtimeSession, runId).readConfig();
        if (!config) return false;
        if (isCancellationRequested()) return false;
        // The parent edge as the fold holds it, read cold: a resume at
        // startup must not race the live fold's first replay.
        const parentRunId = (yield* runtimeSession.readView([])).runs.get(
          runId,
        )?.parentId;

        adoptRunConfig(config, 'history');

        const runHost = setupRunHost();
        finalize = runHost.finalize;
        const { approvalsUnavailable } = runHost;
        session.runId = runId;
        if (!parentRunId) {
          rootRunId.set(runId);
        }
        // A follow-up wake may target a stream the user /clear-ed;
        // resuming it un-retires it (the empty patch drops the retired mark),
        // matching the explicit resume path, or focusRun would refuse
        // and the resumed run would stay invisible.
        focusRun(runId);
        session.runExitCode = CliExitCode.Success;

        yield* setCliHelperModel(stores.globalState, config.model).pipe(
          Effect.mapError(
            (cause) =>
              new StateWriteFailed({
                key: GlobalStateKey.HELPER_MODEL,
                message: `The helper model could not be recorded: ${toErrorMessage(cause)}`,
                cause,
              }),
          ),
        );
        recoveryHandedOff = true;
        const result = yield* resumeRun(runId, {
          ...toolUseResumeOptions(runId, approvalsUnavailable),
          recovery,
          extraFollowUps: options.extraFollowUps,
          onFollowUpQueueReady: options.onFollowUpQueueReady,
          isCancellationRequested,
        });

        if ('started' in result && result.delivered) {
          settleResumedTurn(result.outcome ?? RUN_OUTCOME.COMPLETED);
          return true;
        }
        if (isCancellationRequested()) {
          session.runExitCode = CliExitCode.Interrupted;
        }
        return false;
      });
      // Detached on the process runtime, as the wake's own chain: the port's
      // caller reads the answer off the deferred instead of hosting the run.
      runtime.runFork(
        recoverRun(attempt, (error) => {
          reportRunFailure(error);
          return false;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              handBackUnusedRecovery(recovery, recoveryHandedOff);
              finalize();
              if (activeAutoResumeCancellation === attemptCancellation) {
                activeAutoResumeCancellation = undefined;
              }
            }),
          ),
          // The one place a resume attempt is classified: an answer is the
          // port's boolean, and anything else -- a defect, an interrupted
          // chain -- is the port's fault, which is what the caller's retry
          // decision reads.
          Effect.onExit((exit) =>
            Effect.sync(() => {
              const answer: Effect.Effect<boolean, AgentResumeFailed> =
                Exit.isSuccess(exit)
                  ? Effect.succeed(exit.value)
                  : Effect.fail(
                      new AgentResumeFailed({
                        runId,
                        message: toErrorMessage(Cause.squash(exit.cause)),
                        cause: Cause.squash(exit.cause),
                      }),
                    );
              Deferred.doneUnsafe(autoResumeRun, answer);
            }),
          ),
        ),
      );

      return Deferred.await(autoResumeRun);
    });

  const admitInterruptedFollowUp = (
    followUp: InterruptedFollowUp,
  ): InterruptedFollowUpAdmission => {
    if (interruptedContinuation) {
      interruptedContinuation.followUps.push(followUp);
      return {
        kind: 'accepted',
        runId: interruptedContinuation.runId,
        completion: interruptedContinuation.completion,
      };
    }

    if (!session.interruptedRunId) {
      return { kind: 'not_interrupted' };
    }

    const batch: InterruptedContinuationBatch = {
      runId: session.interruptedRunId,
      followUps: [...pendingInterruptedFollowUps, followUp],
      completion: Deferred.makeUnsafe<boolean, AgentResumeFailed>(),
      superseded: false,
    };
    pendingInterruptedFollowUps = [];
    runtime.runFork(
      Effect.gen(function* () {
        // Best-effort settle-wait on the interrupted run: its outcome
        // (including any failure) is already reported by the run's own
        // recovery.
        yield* Effect.ignoreCause(session.runSettled ?? Effect.void);
        if (batch.superseded) return true;
        let followUpQueueReady = false;
        const resumed = yield* tryResumeRun(batch.runId, {
          extraFollowUps: batch.followUps,
          onFollowUpQueueReady: () => {
            followUpQueueReady = true;
            session.interruptedRunId = undefined;
            if (interruptedContinuation === batch) {
              interruptedContinuation = undefined;
            }
          },
        });
        if (!resumed && !batch.superseded && !followUpQueueReady) {
          session.interruptedRunId = batch.runId;
          pendingInterruptedFollowUps.push(...batch.followUps);
        }
        return resumed;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (interruptedContinuation === batch) {
              interruptedContinuation = undefined;
            }
          }),
        ),
        settleClaimOnExit(batch.completion),
      ),
    );
    interruptedContinuation = batch;
    return {
      kind: 'accepted',
      runId: batch.runId,
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

  const stopRun = (runId: RunId): void => {
    if (runId === session.runId) {
      requestStop();
      session.interruptedRunId = runId;
    }
    runtime.runFork(
      request({ kind: 'run.stop', runId, detachActiveChildren: true }),
    );
  };

  const startSession = (
    instruction: string,
    mediaFiles?: readonly string[],
    displayInstruction?: string,
  ): Effect.Effect<boolean, unknown, ProcessServices> =>
    Effect.suspend(() => {
      followUpQueue.clear();
      let started = false;
      // The slot is claimed before the program runs, the way every other launch
      // path claims it: `startRootRun` below re-claims it for the run it mints,
      // and a refusal on the way there settles this deferred instead.
      const startSettled = Deferred.makeUnsafe<void, unknown>();
      session.markRunPending(Deferred.await(startSettled));
      return recoverRun(
        Effect.gen(function* () {
          const meta = sessionMetaSignal.get();
          const currentModel = meta.model || initialModel;
          const selection = yield* selectCliRunnableModel(currentModel, {
            stores: { ...stores, secrets, runtime },
            fallbackReason: meta.model ? meta.modelSource : initialModelSource,
            noAvailableModelsMessage: formatCliNoAvailableModelsRecovery(
              CHAT_API_MODE_MODEL_RECOVERY,
            ),
          }).pipe(
            Effect.mapError(
              (cause) =>
                // The selection's own failure is the user-facing text: it
                // names the model, its availability status and the `/key`
                // recovery. The tag carries that message verbatim, because the
                // transcript renders `toErrorMessage` of this failure.
                new ChatSessionCallFailed({
                  message: toErrorMessage(cause),
                  cause,
                }),
            ),
          );
          yield* setCliHelperModel(stores.globalState, selection.model).pipe(
            Effect.mapError(
              (cause) =>
                new StateWriteFailed({
                  key: GlobalStateKey.HELPER_MODEL,
                  message: `The helper model could not be recorded: ${toErrorMessage(cause)}`,
                  cause,
                }),
            ),
          );
          if (session.stopRequested) {
            session.markRunCompleted();
            return;
          }
          startRootRun({
            agent: meta.agent || initialAgent,
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
        }),
        (error) => {
          if (!session.stopRequested) {
            appendLocalUserTranscript(displayInstruction ?? instruction);
            appendLocalErrorTranscript(toErrorMessage(error));
          }
          session.runExitCode = session.stopRequested
            ? CliExitCode.Success
            : CliExitCode.AgentError;
          session.markRunCompleted();
        },
      ).pipe(
        settleClaimOnExit(startSettled),
        Effect.map(() => started),
      );
    });

  /** The focused child, when the composer addresses one: the fold says
   *  whether it takes follow-ups; a rejecting child is announced. */
  const focusedChildTarget = ():
    | { readonly kind: 'none' }
    | {
        readonly kind: 'accept' | 'reject';
        readonly runId: RunId;
      } => {
    const stream = runViewOf(currentView(), activeRunIdSignal.get());
    if (!stream || stream.parentId === null) return { kind: 'none' };
    return {
      kind: focusedChildAcceptsFollowUps(stream) ? 'accept' : 'reject',
      runId: stream.id,
    };
  };

  const submitChatMessage = Effect.fn('submitChatMessage')(function* (
    line: string,
    mediaFiles?: readonly string[],
    images?: readonly PastedImageEntry[],
  ) {
    const focusedChild = focusedChildTarget();
    if (focusedChild.kind === 'reject') {
      appendLocalAssistantTranscript(
        FOCUSED_BACKGROUND_TASK.selectedNoLongerAccepting,
        focusedChild.runId,
      );
      return;
    }
    const childFollowUpTarget =
      focusedChild.kind === 'accept' ? focusedChild.runId : undefined;
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
        const resumed = yield* Deferred.await(interruptedAdmission.completion);
        if (resumed) return;
        restoreReservedSkillActivations();
        appendLocalAssistantTranscript(
          'The interrupted conversation could not be restored. Use /resume to retry it, or /clear to start a new conversation.',
          interruptedAdmission.runId,
        );
        return;
      }
    }
    if (!childFollowUpTarget && chatTuiCanStartRootRun(session)) {
      const started = yield* startSession(
        prepared.instruction,
        mediaFiles,
        prepared.displayInstruction,
      );
      if (!started) restoreReservedSkillActivations();
      return;
    }
    let delivered = false;
    /**
     * The delivery is an Effect program so the queue's scope reaches it: an
     * interrupted delivery stops at its next step instead of mutating the
     * transcript or the session after teardown began. The `followUp.send`
     * request and the state it settles (the sent notice, or the restored
     * draft and the stop) are one uninterruptible step: a request that
     * committed is always followed by its presentation, and a message is never
     * both queued on the run and lost from the input.
     */
    const deliverFollowUp = Effect.gen(function* () {
      // The fold states when the pending run exists: the first view level
      // holding the run this controller minted, unless the run settles
      // first. Both are read when the delivery starts, not when it queued.
      const runSettled = session.runSettled;
      const followUpTarget =
        childFollowUpTarget ??
        (yield* Effect.raceFirst(
          awaitRunFolded(session.runId),
          runSettled === undefined
            ? Effect.succeed(undefined)
            : runSettled.pipe(Effect.as(undefined)),
        ));
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
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const outcome = yield* runtimeSession.requests
            .request({
              kind: 'followUp.send',
              runId: followUpTarget,
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
              // `match` recovers only the typed refusal; a collaborator that
              // rejects defects. Read the defect the way `SessionBridge`
              // answers `Internal`: logged, worded, the message handed back.
              Effect.catchCause((cause) =>
                Effect.sync(() =>
                  Cause.hasInterruptsOnly(cause)
                    ? { interrupted: true as const }
                    : { defect: reportRequestDefect(cause) },
                ),
              ),
            );
          if ('value' in outcome && outcome.value.kind === 'followUp') {
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
          } else if ('interrupted' in outcome) {
            // Teardown mid-send is not a verdict on the message; hand it back.
            requestDraftRestore(line, images);
          } else if ('defect' in outcome) {
            // The run may be healthy; a defect is no refusal, so it neither
            // stops the stream nor retargets the conversation.
            requestDraftRestore(line, images);
            setTransientNotice(
              `${outcome.defect} The message has been restored to the input.`,
              { ttlMs: Infinity },
            );
          } else {
            requestDraftRestore(line, images);
            setTransientNotice(
              `${outcome.refused ?? describeFollowUpFailureReason('not_resumable')} The message has been restored to the input.`,
              { ttlMs: Infinity },
            );
            if (followUpTarget === session.runId) {
              session.stopRequested = true;
            } else {
              appendLocalAssistantTranscript(
                FOCUSED_BACKGROUND_TASK.selectedNoLongerAccepting,
                followUpTarget,
              );
            }
          }
        }),
      );
    });
    // Recovery is attached before the delivery enters the queue. A failure or
    // a throw from the body is reported to the transcript; an interruption is
    // the queue's scope closing, which is not a delivery failure.
    followUpQueue.enqueue(
      deliverFollowUp.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (!delivered) restoreReservedSkillActivations();
          }),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.sync(() =>
                appendLocalErrorTranscript(toErrorMessage(Cause.squash(cause))),
              ),
        ),
      ),
    );
  });

  const submit = Effect.fn('chatSubmit')(function* (
    line: string,
    mediaFiles?: readonly string[],
    images?: readonly PastedImageEntry[],
  ) {
    if (yield* handleTuiSlashCommand(line, getSlashCommandContext())) return;
    yield* submitChatMessage(line, mediaFiles, images);
  });

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
    stopRun,
    admitInterruptedFollowUp,
    clearInterruptedRecovery: () => {
      void supersedeInterruptedRecovery();
    },
    tryResumeRun: (runId, recovery) =>
      tryResumeRun(runId, recovery ? { recovery } : {}),
    submit,
    activateSkill,
    clearPendingSkills: () => {
      pendingSkillActivationClearEpoch += 1;
      pendingSkillActivations.clear();
    },
  };
}
