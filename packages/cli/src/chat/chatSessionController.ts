// Chat-session controller: owns run start/resume/stop state-transition
// orchestration and the composer's submit path for the CLI chat session.
// Host-neutral (no Ink/TUI rendering dependencies): the Ink component
// consumes narrow commands exposed here.

import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Schema,
  Scope,
  Stream,
} from 'effect';

import {
  describeFollowUpFailure,
  hasErrorPresentationClaimed,
  heldElsewhereBy,
  presentFollowUpResult,
  type PerKeyLane,
  type PlatformSecrets,
  type ProcessRuntime,
  type ProcessServices,
  type RunStopReason,
  type Session,
  withPerKeyLane,
} from '@texra-ai/harness';
import {
  type RuntimeRequest,
  type RunView,
  type SessionView,
  AgentConfigSchema,
  type AgentConfig,
  type AgentConfigPayload,
  escapeText,
  generateRunId,
  isTaskConfig,
  type RunId,
  acceptsFollowUp,
  RUN_PHASE,
  isLiveRun,
  isTerminalOutcomePhase,
  toErrorMessage,
} from '@texra-ai/harness/schemas';
import { runOutcomeExitCode } from '@cli/runtime/terminalStatus';
import { createCliRuntimeHost } from '@cli/runtime/cliPresentationHost';
import {
  formatCliNoAvailableModelsRecovery,
  selectCliRunnableModel,
} from '@cli/runtime/modelAccess';
import { setCliHelperModel } from '@cli/runtime/initPlatform';
import { readCliTeamName } from '@cli/runtime/cliTeams';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { launchApproval, type CliContext } from '@cli/runtime/cliContext';
import type { DisposableStore } from '@texra/platform/disposable';
import { requestErrorText } from '@ui/copy/requestErrors';
import { handleTuiSlashCommand } from './tui/commands/handleSlashCommand';
import {
  CHAT_API_MODE_MODEL_RECOVERY,
  type SlashCommandContext,
} from './tui/commands/handlers/slashContext';
import {
  selectedRunId as selectedRunIdSignal,
  focusRun,
  rootRunId,
  patchSessionMeta,
  requestDraftRestore,
  sessionMeta as sessionMetaSignal,
  setTransientNotice,
} from './tui/state/cliState';
import {
  chatTuiRunPending,
  type RootRunSettled,
  type TuiSession,
} from './tui/state/sessionRunState';
import { currentView, runViewOf } from './tui/state/sessionView';
import { createTuiHostInteractions } from './tui/state/subscribeApprovals';
import {
  appendLocalErrorTranscript,
  appendLocalNotice,
  appendLocalUserTranscript,
  clearLocalTranscript,
  moveLocalTranscriptToRun,
  reportRequestDefect,
} from './tui/state/transcript';
import type { ApprovalPolicy } from '@texra-ai/harness/schemas';
import type { SessionRequests } from './tui/state/approvalQueue';
import type { SkillActivation } from './tui/forms/SkillsListForm';
import type { PastedImageEntry } from './tui/input/draftAttachments';
import type { SettingsStores } from '@texra-ai/harness';

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * A chat-session host call this controller drives faulted. The model
 * selection reads the process stores, which does not report a normal outcome
 * this way.
 */
class ChatSessionCallFailed extends Schema.TaggedError<ChatSessionCallFailed>()(
  'ChatSessionCallFailed',
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

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
        Effect.sync(() => Deferred.doneUnsafe(claim, exit)),
      ),
    );

/**
 * The recovery tail every run/resume program below shares. A typed failure
 * from a host call and a throw from the imperative body alike reach
 * `recover` with the original value, which is exactly what the `try`/`catch`
 * around these bodies did before they became programs. Interruption is not
 * folded in: a fiber the runtime is tearing down is not a run failure to
 * report, and the caller's own settlement still sees it.
 */
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
  /** Start a new root agent run from a fresh config. The program completes
   *  once the session holds the run, or its launch failed. */
  startRootRun(config: AgentConfigPayload): Effect.Effect<void>;

  /**
   * Resume a suspended tool-use session by run id.
   *
   * Fire-and-forget from the Ink perspective, the returned program completes
   * when the resume resolution and rehydration are complete, but the
   * continued run itself stays pending until the agent finishes or suspends.
   */
  resume(id: RunId): Effect.Effect<void, Error>;

  /** Request stop of the root run using the configured child policy, for
   *  `reason`: a `user` stop also cancels its remote background work. */
  stop(reason: RunStopReason): void;

  /**
   * The composer's submit path (PRD 10.1): a slash command, the first
   * instruction of a fresh root run, or a `followUp.send` request onto the
   * focused run or the conversation's root, which the session continues if
   * the user stopped it.
   */
  submit(
    line: string,
    attachments?: ChatAttachments,
  ): Effect.Effect<void, Error, ProcessServices>;
  /** Succeeds once every message submitted so far has been sent, or has
   *  started its run. */
  readonly submitted: Effect.Effect<void>;
  /** Reserve a skill activation for the next submitted message. */
  activateSkill(selection: SkillActivation): void;
  /** Drop every reserved skill activation. */
  clearPendingSkills(): void;
}

/** What rides along with a submitted line: files and pasted images, and
 *  `holdUntil: 'turn'` for a message the run reads when its current turn
 *  ends rather than at the turn's next model request. */
interface ChatAttachments {
  readonly mediaFiles?: readonly string[];
  readonly images?: readonly PastedImageEntry[];
  readonly holdUntil?: 'turn';
}

export interface ChatSessionControllerInit {
  /** Mutable session state the controller owns. */
  readonly session: TuiSession;

  /** The chat's session, here or in the background service: its runs are
   *  launched and resumed, its requests land and its view is read there,
   *  and the chat's host attaches to it. */
  readonly runSession: Session;
  /** The chat is a client of the background service, whose view also holds
   *  other terminals' conversations. */
  readonly served: boolean;
  /** A run's records (its saved setup, whether it exists), read from this
   *  process's store. */
  readonly records: (runId: RunId) => ChatRunRecords;

  /** The chat session's {@link CliContext}, read once: the controller
   *  attaches one interaction host for the session's lifetime. */
  readonly getSessionContext: () => CliContext;

  /** Disposable owner shared with the TUI session lifecycle. */
  readonly disposables: DisposableStore;

  /** The process's shutdown scope: the interaction host closes there, so
   *  every exit path, signal or graceful, awaits its close. */
  readonly shutdownScope: Scope.Scope;

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
  /** The policy the chat asked for itself (its flag, then `/approval`),
   *  which each launch carries (`launchApproval`); none follows the
   *  project's. */
  readonly approvalPolicy: () => ApprovalPolicy | undefined;
}

/** What the chat reads of a run's records: its saved setup, and whether
 *  it exists. */
interface ChatRunRecords {
  readonly readConfig: () => Effect.Effect<AgentConfig | null, Error>;
  readonly exists: () => Effect.Effect<boolean, Error>;
}

/** How a submitted message ends, once: sent (or handed to a fresh run), or
 *  back in the input, naming why when there is a reason. */
interface MessageSettlement {
  readonly sent: () => void;
  readonly undelivered: (reason?: string) => void;
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

export function createChatSessionController(
  init: ChatSessionControllerInit,
): ChatSessionController {
  const {
    session,
    runSession,
    served,
    getSessionContext,
    disposables,
    shutdownScope,
    cwd,
    getSlashCommandContext,
    secrets,
    stores,
    runtime,
  } = init;
  const requests: SessionRequests = runSession;
  // The fold the chat's runs appear in: the service's, or this session's.
  const viewChanges: Stream.Stream<SessionView> = runSession.view.changes;
  /** A run that is no longer live here: its generation let go. */
  const settledHere = (runId: RunId): Effect.Effect<void> =>
    viewChanges.pipe(
      Stream.filter((view) => {
        const run = view.runs.get(runId);
        return run === undefined || !run.ownedHere || !isLiveRun(run);
      }),
      Stream.runHead,
      Effect.asVoid,
    );
  const pendingSkillActivations = new Map<string, string>();
  let pendingSkillActivationClearEpoch = 0;

  /** A level that shows `runId` continued since `before`, its level when
   *  the message was sent: live here, or already parked or ended again.
   *  The activation folds after the session answered, and a turn that ends
   *  before this looks leaves no live level to see, only its park or end. */
  const continuedSince = (
    runId: RunId,
    before: RunView | undefined,
  ): Effect.Effect<void> =>
    viewChanges.pipe(
      Stream.filter((view) => {
        const run = view.runs.get(runId);
        if (run === undefined) return false;
        if (run.ownedHere && isLiveRun(run)) return true;
        return (
          before !== undefined &&
          (run.forkPoint !== before.forkPoint ||
            run.durableOutcome !== before.durableOutcome)
        );
      }),
      Stream.runHead,
      Effect.asVoid,
    );

  /** Issue one request to the session's runtime and read its Effect result
   *  as the response (PRD 7.6): the refusal text, or undefined on success. */
  const request = (req: RuntimeRequest): Effect.Effect<string | undefined> =>
    requests.request(req).pipe(
      Effect.match({
        onFailure: requestErrorText,
        onSuccess: () => undefined,
      }),
    );

  /** Publish the configuration of the conversation the TUI adopts. */
  const adoptRunConfig = (
    config: Pick<
      AgentConfig,
      'agent' | 'agentSource' | 'model' | 'cli' | 'delegationAgentScope'
    >,
    modelSource?: 'history',
  ) =>
    Effect.gen(function* () {
      const cliTeamId = config.cli?.teamId ?? undefined;
      const teamName = yield* readCliTeamName(
        runSession.roots.repoState,
        cliTeamId,
      );
      patchSessionMeta({
        agent: config.agent,
        agentSource: config.agentSource ?? undefined,
        model: config.model,
        ...(modelSource ? { modelSource } : {}),
        teamName,
        cliTeamId,
        delegationAgentScope: config.delegationAgentScope ?? undefined,
      });
    });

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /** Stop the chat's run. A stop lands only on a run the session holds:
   *  one the view shows, or `admitted`, which the session has just admitted
   *  whether or not the view has folded it yet (admission re-reads
   *  `stopRequested` for a stop asked in the launch gap). The stop is a
   *  shutdown while the chat is leaving and a user stop otherwise; why the
   *  run then stops is the run registry's fact. */
  const interruptActiveRun = (admitted?: RunId): void => {
    const runId = session.runId;
    if (!runId) return;
    if (runId !== admitted && !runViewOf(currentView(), runId)) return;
    // Ctrl-C leaves the child policy unset, so the session's request handler
    // applies the configured "Keep agents running".
    const reason: RunStopReason = session.leaving ? 'shutdown' : 'user';
    runtime.runFork(request({ kind: 'run.stop', runId, reason }));
  };

  // Shared tail of the run/resume failure recovery: surface the error to
  // the local transcript unless the run was stopped intentionally, and set
  // the exit code accordingly. A run whose claim the slot no longer holds
  // (a fork or a new task replaced it) says nothing to the chat.
  const reportRunFailure = (error: unknown, claim: RootRunSettled): void => {
    if (!session.holdsClaim(claim)) return;
    if (session.stopRequested) {
      session.runExitCode = CliExitCode.Success;
      return;
    }
    // A launch failure already rendered through a targeted presentation
    // (e.g. the model-not-recognized instruction), or presented already (by
    // the service, to this chat) is marked -- skip the generic transcript
    // line so the TUI doesn't show the same failure twice.
    if (!hasErrorPresentationClaimed(error)) {
      appendLocalErrorTranscript(toErrorMessage(error));
    }
    // Another live process holds the run: it refused the claim, or took it
    // after its owner was proved dead.
    session.runExitCode =
      heldElsewhereBy(error) !== null
        ? CliExitCode.Usage
        : CliExitCode.AgentError;
  };

  // One interaction host for the chat session's lifetime, as the extension
  // and desktop attach theirs. The session routes every request to its last
  // attachment, so a detached child of an earlier turn keeps an answerable
  // approval path after its root finalizes, with no per-turn generation.
  const sessionContext = getSessionContext();
  const presentationHost = createCliRuntimeHost(sessionContext);
  runtime.runSync(
    Scope.addFinalizer(
      shutdownScope,
      Effect.suspend(() => presentationHost.close()),
    ),
  );
  const interactions = createTuiHostInteractions(
    presentationHost,
    sessionContext,
    {
      requests,
      preview: !served
        ? undefined
        : (runId, requestId) =>
            requests
              .request({ kind: 'request.preview', runId, requestId })
              .pipe(
                // `request.preview` answers with a preview, null included;
                // any other outcome is a broken protocol, not a missing one.
                Effect.flatMap((outcome) =>
                  outcome.kind === 'preview'
                    ? Effect.succeed(outcome.preview)
                    : Effect.die(
                        new Error(
                          `request.preview answered with a ${outcome.kind} outcome`,
                        ),
                      ),
                ),
              ),
      secrets,
      settings: stores,
      runtime,
    },
  );
  // Attached to the chat's session for its lifetime: here, its requests'
  // host; in the service, one of its project's windows, whose notices its
  // tasks raise here.
  const attached = runtime.runSync(Scope.make());
  runtime.runFork(
    runSession.attach(interactions).pipe(Scope.provide(attached)),
  );
  disposables.add(() => {
    interactions.dispose?.();
    runtime.runFork(Scope.close(attached, Exit.void));
  });

  // -----------------------------------------------------------------------
  // startRootRun
  // -----------------------------------------------------------------------

  const startRootRun = (
    config: AgentConfigPayload,
    runId: RunId = generateRunId(),
  ): Effect.Effect<void> =>
    Effect.suspend(() => {
      // The slot has to be claimed before the chain that settles it exists, so
      // the claim holds the `await` of a `Deferred` the run chain completes.
      // Awaiting the deferred is a plain suspension, so a run parked at the WAIT
      // node leaves the slot pending exactly as before.
      const claimedRun = Deferred.makeUnsafe<void, Error>();
      const claim = Deferred.await(claimedRun);
      // Native launch may resolve its stream on this turn. Claim first so
      // marking the run pending cannot erase that run or a reentrant stop.
      session.markRunPending(claim, runId);
      // Done once the session holds the run (or the launch failed): a message
      // typed meanwhile waits for it, so it reaches a run that exists.
      const launched = Deferred.makeUnsafe<void>();
      const markLaunched = Effect.sync(() =>
        Deferred.doneUnsafe(launched, Effect.void),
      );
      runtime.runFork(
        recoverRun(
          Effect.gen(function* () {
            yield* adoptRunConfig(config);
            const registeredConfig =
              yield* Schema.decodeUnknownEffect(AgentConfigSchema)(config);
            // Each chat round mints a fresh root run id, so bash/tool-edit/
            // super-YOLO bypass, which is keyed per stream, would otherwise
            // reset every round even though the user is continuing the same
            // conversation. The new round continues the previous one, so bypass
            // resolution falls through to whatever the prior round had, unless
            // this round sets its own explicit value.
            const approval = launchApproval(init.approvalPolicy());
            const run = yield* runSession.start({
              config: registeredConfig,
              runId,
              continues: rootRunId.get(),
              approval: {
                policy: approval.approvalPolicy,
                delegated: approval.approveDelegatedWork,
              },
              interactive: true,
            });
            rootRunId.set(run.runId);
            moveLocalTranscriptToRun(run.runId);
            focusRun(run.runId);
            if (session.stopRequested) interruptActiveRun(run.runId);
            yield* markLaunched;
            const { outcome } = yield* run.result;
            session.settleExitCode(claim, runOutcomeExitCode(outcome));
          }),
          (error) => reportRunFailure(error, claim),
        ).pipe(
          Effect.ensuring(
            Effect.andThen(
              markLaunched,
              Effect.sync(() => session.markRunCompleted(claim)),
            ),
          ),
          // The claim settles with the run's own exit, so a waiter reads what
          // the run did rather than what a promise adapter made of it.
          settleClaimOnExit(claimedRun),
        ),
      );
      return Deferred.await(launched);
    });

  // -----------------------------------------------------------------------
  // resume
  // -----------------------------------------------------------------------

  // The user's resume of a conversation they pick. Config is adopted once
  // the session admitted the resumed run.
  const resume = (id: RunId): Effect.Effect<void, Error> =>
    // `Effect.suspend` is what keeps the claim handshake synchronous: its
    // body is this program's first step, so the availability check and the
    // claim are one uninterrupted synchronous callback (see
    // tryClaimRootRunSlot) that no other fiber can land between, and a
    // root the session resumes (or another resume()) can never observe this
    // call suspended between "checked available" and "claimed".
    Effect.suspend(() => {
      const claimedRun = Deferred.makeUnsafe<void, Error>();
      const claim = Deferred.await(claimedRun);
      if (!session.tryClaimRootRunSlot(claim)) {
        // The slot is taken, so the deferred this attempt made is dropped
        // unsettled: nothing holds it, and no fiber is parked on it.
        appendLocalNotice(
          'Finish the active task before resuming a previous one.',
        );
        return Effect.void;
      }

      /** The end of a resume that never reached its run: announce, complete,
       *  settle. */
      const endResumeUnstarted = (announce: () => void): void => {
        announce();
        session.markRunCompleted(claim);
        Deferred.doneUnsafe(claimedRun, Effect.void);
      };
      const attemptResume = Effect.gen(function* () {
        // The durable record carries the config the TUI adopts before the run.
        const store = init.records(id);
        const [config, exists] = yield* Effect.all([
          store.readConfig(),
          store.exists(),
        ]);
        const refuseResume = (reason: string): void =>
          endResumeUnstarted(() => appendLocalErrorTranscript(reason));
        if (!config || !exists) {
          refuseResume(`Task not found: ${id}`);
          return;
        }
        // A document task takes no chat: it resumes beside this one, as
        // `/resume all` resumes it, and joins the agent list.
        if (isTaskConfig(config)) {
          endResumeUnstarted(() =>
            appendLocalNotice(`Resuming document task ${id}. Tab lists it.`),
          );
          yield* Effect.forkDetach(
            runSession
              .resume(id, { interactive: true })
              .pipe(
                Effect.catch((refused) =>
                  Effect.sync(() =>
                    appendLocalErrorTranscript(toErrorMessage(refused)),
                  ),
                ),
              ),
          );
          return;
        }

        // Adopting the resumed stream is the mutation a refusal must not cost:
        // it runs only once the session admitted the run, so a refusal
        // reaches the chat the user is looking at instead of a cleared
        // transcript switched onto a dead stream. The run resumed is the one
        // asked for, or the parent that owns it.
        const adoptResumedRun = Effect.fn('adoptResumedRun')(function* (
          resumed: RunId,
        ) {
          const adoptedConfig =
            resumed === id ? config : yield* init.records(resumed).readConfig();
          if (adoptedConfig === null)
            return yield* Effect.fail(
              new Error(`Run ${resumed} has no configuration to resume`),
            );
          yield* setCliHelperModel(stores.globalState, adoptedConfig.model);
          yield* adoptRunConfig(adoptedConfig, 'history');
          clearLocalTranscript();
          session.runId = resumed;
          rootRunId.set(resumed);
          // The pre-resume stream was dropped by the synchronous slot claim
          // above, so a Ctrl-C before adoption had nothing to interrupt;
          // re-read the request here and let it land on the run the user
          // asked to continue.
          if (session.stopRequested) interruptActiveRun(resumed);

          // The transcript and the work plan are the fold's: the TUI
          // subscribes the run's aggregate and renders `transcript.rows`, and
          // an open `/plan` reader reads the same `RunView`.
          focusRun(resumed);
        });

        runtime.runFork(
          Effect.gen(function* () {
            const run = yield* runSession
              .resume(id, { interactive: true })
              .pipe(
                // A refusal is the resume's answer, not a failure: the chat
                // says it in the session's words and exits as a usage error.
                Effect.catchTag('ResumeRefused', (refusal) =>
                  Effect.sync(() => {
                    if (session.stopRequested) {
                      session.settleExitCode(claim, CliExitCode.Interrupted);
                    } else {
                      appendLocalErrorTranscript(refusal.message);
                      session.settleExitCode(claim, CliExitCode.Usage);
                    }
                    return undefined;
                  }),
                ),
              );
            if (run === undefined) return;
            yield* adoptResumedRun(run.runId);
            // A root acknowledges at idle, so its result holds this chain,
            // and the root-run slot it settles, until the run ends.
            const { outcome } = yield* run.result;
            session.settleExitCode(claim, runOutcomeExitCode(outcome));
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() => reportRunFailure(error, claim)),
            ),
            Effect.ensuring(Effect.sync(() => session.markRunCompleted(claim))),
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
        endResumeUnstarted(() => reportRunFailure(error, claim));
      });
    });

  /** Adopt a resumed run's configuration and helper model. A failure is the
   *  chat's own line (the TUI's log sink is silent): the run goes on, but the
   *  chat's model and settings may not be the run's. */
  const adoptRunRecord = (runId: RunId) =>
    Effect.gen(function* () {
      const config = yield* init.records(runId).readConfig();
      if (!config)
        return yield* Effect.fail(new Error('it has no stored configuration'));
      yield* adoptRunConfig(config, 'history');
      yield* setCliHelperModel(stores.globalState, config.model);
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() =>
          appendLocalErrorTranscript(
            `Resumed run ${runId}: its configuration could not be adopted: ${toErrorMessage(error)}`,
          ),
        ),
      ),
    );

  /**
   * A top-level run the session resumed in this process (a follow-up wake,
   * the stopped conversation's continuation among them) is this chat's root
   * the way its own launch is. While the root-run slot is free the chat
   * adopts it: focus and configuration, and the slot held until the session's
   * registry has let the generation go, its fiber settled and its queue
   * released. The resume itself is the session's; the chat only reacts. A run
   * counts from the level where it is live both in the registry and in the
   * view, so neither a child detached while running (live already) nor a
   * stale terminal row is adopted. A message that continued the stopped
   * conversation adopts its run the same way once the session answered (a
   * served chat observes no resumes): `resumed` waits until the view shows
   * that the run continued.
   */
  const adoptResumedRoot = (
    runId: RunId,
    resumed: Effect.Effect<void> = Effect.void,
  ): void => {
    const adopted = Deferred.makeUnsafe<void, Error>();
    const claim = Deferred.await(adopted);
    if (!session.tryClaimRootRunSlot(claim, runId)) return;
    rootRunId.set(runId);
    focusRun(runId);
    runtime.runFork(
      Effect.gen(function* () {
        yield* adoptRunRecord(runId);
        yield* resumed;
        yield* settledHere(runId);
        const status = runSession.view.current().runs.get(runId)?.status;
        session.settleExitCode(
          claim,
          isTerminalOutcomePhase(status)
            ? runOutcomeExitCode(status)
            : CliExitCode.Success,
        );
      }).pipe(
        Effect.ensuring(Effect.sync(() => session.markRunCompleted(claim))),
        settleClaimOnExit(adopted),
      ),
    );
  };
  let liveHere = new Set<RunId>();
  const observeResumedRoots = (view: SessionView): Effect.Effect<void> =>
    Effect.sync(() => {
      const previous = liveHere;
      liveHere = new Set(
        [...view.runs.values()]
          .filter((run) => isLiveRun(run) && run.ownedHere)
          .map((run) => run.id),
      );
      for (const id of liveHere) {
        const run = view.runs.get(id);
        if (!previous.has(id) && run?.parentId === null) adoptResumedRoot(id);
      }
    });
  // A chat of the service adopts only the runs it launches or resumes: the
  // service's view also holds other terminals' conversations.
  if (!served) {
    const resumedRoots = runtime.runFork(
      Stream.runForEach(viewChanges, observeResumedRoots),
    );
    disposables.add(() => {
      runtime.runFork(Fiber.interrupt(resumedRoots));
    });
  }

  // -----------------------------------------------------------------------
  // stop
  // -----------------------------------------------------------------------

  const stop = (reason: RunStopReason): void => {
    // A chat of the background service leaves its task running when the
    // terminal goes: only the user's own stop reaches it.
    if (reason === 'shutdown' && served) return;
    session.askStop(reason);
    interruptActiveRun();
  };

  const startSession = (
    instruction: string,
    mediaFiles?: readonly string[],
    displayInstruction?: string,
  ): Effect.Effect<boolean, Error, ProcessServices> =>
    Effect.suspend(() => {
      let started = false;
      // The slot is claimed before the program runs, the way every other launch
      // path claims it: `startRootRun` below re-claims it for the run, whose
      // id is minted here so the claim names it from the first instant, and a
      // refusal on the way there settles this deferred instead.
      const runId = generateRunId();
      const startSettled = Deferred.makeUnsafe<void, Error>();
      const claim = Deferred.await(startSettled);
      session.markRunPending(claim, runId);
      return recoverRun(
        Effect.gen(function* () {
          const meta = sessionMetaSignal.get();
          const selection = yield* selectCliRunnableModel(
            [{ model: meta.model, reason: meta.modelSource }],
            {
              stores: { ...stores, secrets, runtime },
              noAvailableModelsMessage: formatCliNoAvailableModelsRecovery(
                CHAT_API_MODE_MODEL_RECOVERY,
              ),
            },
          ).pipe(
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
          yield* setCliHelperModel(stores.globalState, selection.model);
          if (session.stopRequested) {
            session.markRunCompleted(claim);
            return;
          }
          yield* startRootRun(
            {
              agent: meta.agent,
              agentSource: meta.agentSource,
              model: selection.model,
              instruction,
              ...(displayInstruction !== undefined
                ? { displayInstruction }
                : {}),
              workingDirectory: cwd,
              ...(mediaFiles?.length ? { mediaFiles: [...mediaFiles] } : {}),
              ...(meta.cliTeamId ? { cli: { teamId: meta.cliTeamId } } : {}),
              ...(meta.delegationAgentScope
                ? { delegationAgentScope: meta.delegationAgentScope }
                : {}),
            },
            runId,
          );
          started = true;
        }),
        (error) => {
          if (!session.stopRequested) {
            appendLocalUserTranscript(displayInstruction ?? instruction);
          }
          reportRunFailure(error, claim);
          session.markRunCompleted(claim);
        },
      ).pipe(
        settleClaimOnExit(startSettled),
        Effect.map(() => started),
      );
    });

  // Where each message goes is decided one at a time, in the order typed,
  // so a message typed while the chat starts its run waits until the
  // session holds that run. The send itself runs outside: the session keeps
  // a run's messages in order.
  const submissionLanes = new Map<'chat', PerKeyLane>();
  const inOrder = withPerKeyLane(submissionLanes, 'chat');
  // The sends in flight, which a graceful exit waits for.
  const sending = runtime.runSync(
    FiberSet.make<void>().pipe(Scope.provide(shutdownScope)),
  );

  /**
   * Send `prepared` to `target`. The session decides everything about the
   * message: whether the run takes it, waiting for a run that is stopping
   * to finish, and resuming a run that is not running. `continuing`: the
   * chat holds no running claim on `target`, its root, so once the session
   * answered the chat adopts the run.
   */
  const sendMessage = Effect.fn('sendMessage')(function* (
    target: RunId,
    continuing: boolean,
    prepared: PreparedChatInstruction,
    { mediaFiles, holdUntil }: ChatAttachments,
    message: MessageSettlement,
  ) {
    const before = runSession.view.current().runs.get(target);
    // The claim of the stopped run, while the chat still holds it.
    const stoppedClaim = chatTuiRunPending(session)
      ? session.runSettled
      : undefined;
    // The request and the state it settles (the notice, or the restored
    // draft) are one uninterruptible step: a request that committed is
    // always followed by its presentation, and a message is never both
    // queued on the run and lost from the input.
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const outcome = yield* requests
          .request({
            kind: 'followUp.send',
            runId: target,
            text: prepared.instruction,
            displayText: prepared.displayInstruction,
            mediaFiles: mediaFiles ? [...mediaFiles] : undefined,
            holdUntil,
          })
          .pipe(
            Effect.match({
              onFailure: (error) => ({
                kind: 'refused' as const,
                reason: requestErrorText(error),
              }),
              onSuccess: (value) =>
                value.kind === 'followUp'
                  ? { kind: 'sent' as const, value }
                  : {
                      kind: 'refused' as const,
                      reason: describeFollowUpFailure('not_resumable'),
                    },
            }),
            // `match` recovers only the typed refusal; a defect is read the
            // way `SessionBridge` answers `Internal`: logged and worded.
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                if (Cause.hasInterruptsOnly(cause)) {
                  return { kind: 'interrupted' as const };
                }
                const reason = yield* reportRequestDefect(cause);
                return { kind: 'defect' as const, reason };
              }),
            ),
          );
        if (outcome.kind !== 'sent') {
          // Teardown mid-send is not a verdict on the message: it goes back
          // to the input without a reason.
          message.undelivered(
            outcome.kind === 'interrupted' ? undefined : outcome.reason,
          );
          return;
        }
        message.sent();
        // The session resumed the stopped conversation: the slot passes to
        // it once the stopped run's claim lets go, so the next message goes
        // to it rather than starting a second root beside it.
        if (continuing && outcome.value.wake == null)
          runtime.runFork(
            Effect.ignoreCause(stoppedClaim ?? Effect.void).pipe(
              Effect.andThen(
                Effect.sync(() =>
                  adoptResumedRoot(target, continuedSince(target, before)),
                ),
              ),
            ),
          );
        const presentation = presentFollowUpResult(
          outcome.value.status === 'sent'
            ? { status: 'sent' }
            : { status: 'queued', wake: outcome.value.wake ?? undefined },
        );
        if (presentation.severity !== 'none') {
          appendLocalNotice(presentation.message, target);
        }
      }),
    );
  });

  const submitChatMessage = Effect.fn('submitChatMessage')(function* (
    line: string,
    attachments: ChatAttachments = {},
  ) {
    const prepared = takePendingSkillActivations(pendingSkillActivations, line);
    const skillActivationClearEpoch = pendingSkillActivationClearEpoch;
    const restoreReservedSkillActivations = (): void => {
      if (skillActivationClearEpoch !== pendingSkillActivationClearEpoch) {
        return;
      }
      for (const reserved of prepared.reservedSkillActivations) {
        if (!pendingSkillActivations.has(reserved.name)) {
          pendingSkillActivations.set(reserved.name, reserved.activationPrompt);
        }
      }
    };
    // Sent, or handed back to the input: a message settles once.
    let settled = false;
    const message: MessageSettlement = {
      sent: () => {
        settled = true;
      },
      undelivered: (reason) => {
        if (settled) return;
        settled = true;
        requestDraftRestore(line, attachments.images);
        if (reason !== undefined) {
          setTransientNotice(
            `${reason} The message has been restored to the input.`,
            { ttlMs: Infinity },
          );
        }
        restoreReservedSkillActivations();
      },
    };
    const send = (target: RunId, continuing: boolean) =>
      FiberSet.run(
        sending,
        sendMessage(target, continuing, prepared, attachments, message),
      );
    const route = Effect.gen(function* () {
      if (session.leaving) return message.undelivered();
      // The focused agent below the root takes the message.
      const focused = runViewOf(currentView(), selectedRunIdSignal.get());
      if (focused !== undefined && focused.parentId !== null)
        return yield* send(focused.id, false);
      // The root run the chat holds, stopping or not.
      if (chatTuiRunPending(session)) {
        const held = session.runId;
        if (held === undefined)
          return message.undelivered(
            'The conversation is still being resumed.',
          );
        return yield* send(held, session.stopRequested);
      }
      // The conversation's root while it runs without the chat holding it
      // (the session resumed it), or one the user stopped, which the session
      // continues; anything else (none yet, or one that failed) starts a
      // fresh run, which picks its model again.
      const root = runViewOf(currentView(), rootRunId.get());
      if (
        root !== undefined &&
        (isLiveRun(root) || root.status === RUN_PHASE.CANCELLED) &&
        acceptsFollowUp(root)
      )
        return yield* send(root.id, true);
      message.sent();
      const started = yield* startSession(
        prepared.instruction,
        attachments.mediaFiles,
        prepared.displayInstruction,
      );
      if (!started) restoreReservedSkillActivations();
    });
    // A failure or a throw is reported to the transcript; a bare
    // interruption is the runtime closing, not a failed submission. Either
    // way an unsent message goes back to the input.
    yield* Effect.gen(function* () {
      const sent = yield* inOrder(route);
      if (sent) yield* Fiber.join(sent);
    }).pipe(
      Effect.ensuring(Effect.sync(() => message.undelivered())),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.sync(() =>
              appendLocalErrorTranscript(toErrorMessage(Cause.squash(cause))),
            ),
      ),
    );
  });

  const submit = Effect.fn('chatSubmit')(function* (
    line: string,
    attachments?: ChatAttachments,
  ) {
    if (yield* handleTuiSlashCommand(line, getSlashCommandContext())) return;
    yield* submitChatMessage(line, attachments);
  });

  const activateSkill = (selection: SkillActivation): void => {
    const wasPending = pendingSkillActivations.has(selection.name);
    pendingSkillActivations.set(selection.name, selection.activationPrompt);
    appendLocalNotice(
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
    submit,
    submitted: Effect.andThen(
      inOrder(Effect.void),
      FiberSet.awaitEmpty(sending),
    ),
    activateSkill,
    clearPendingSkills: () => {
      pendingSkillActivationClearEpoch += 1;
      pendingSkillActivations.clear();
    },
  };
}
