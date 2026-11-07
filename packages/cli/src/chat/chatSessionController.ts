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
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect';

import {
  isRequestRefusal,
  type RunStopReason,
  type Session,
} from '@texra-ai/harness';
import {
  launchNoticeOf,
  normalizeProviderError,
  presentFollowUpResult,
  type ProcessRuntime,
  type ProcessServices,
} from '@texra-ai/harness/host';
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
import { resumeRun } from '@texra/controllers/session/runActionPolicy';
import { modelFailureText } from '@ui/copy/modelAccess';
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
  appendLocalRequestRefusal,
  appendLocalUserTranscript,
  clearLocalTranscript,
  moveLocalTranscriptToRun,
  reportRequestDefect,
} from './tui/state/transcript';
import type { ApprovalPolicy } from '@texra-ai/harness/schemas';
import type { SessionRequests } from './tui/state/approvalQueue';
import {
  EMPTY_DRAFT,
  expandText,
  resolveImages,
  restoreDraft,
  withSkill,
  type Draft,
} from './tui/input/draftAttachments';
import type { ModelConnection } from './tui/modelConnection';
import type { SkillActivation } from './tui/forms/SkillsListForm';
import type { SettingsStores } from '@texra-ai/harness/host';

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
  <R, E1 extends E>(
    program: Effect.Effect<A, E1, R>,
  ): Effect.Effect<A, E1, R> =>
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
): Effect.Effect<A, never, R> =>
  program.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
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
    draft: Draft,
    holdUntil?: 'turn',
  ): Effect.Effect<void, Error, ProcessServices>;
  /** Succeeds once every message submitted so far has been sent, or has
   *  started its run. */
  readonly submitted: Effect.Effect<void>;
  /** Activate a skill for the next submitted message. */
  activateSkill(selection: SkillActivation): void;
  /** Drop every activated skill. */
  clearPendingSkills(): void;
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

  /** The chat session's {@link CliContext}: the controller attaches one
   *  interaction host for the session's lifetime. */
  readonly sessionContext: CliContext;

  /** The chat's scope: the host attachment and the resumed-root watch
   *  close with it, which the exit drain awaits. */
  readonly chatScope: Scope.Scope;

  /** The process's shutdown scope: the interaction host closes there, so
   *  every exit path, signal or graceful, awaits its close. */
  readonly shutdownScope: Scope.Scope;

  readonly cwd: string;
  readonly getSlashCommandContext: () => SlashCommandContext;
  /**
   * The three setting slots a retry's credential work reads, threaded from
   * the `CliPlatformServices` the chat entry point already holds rather than
   * looked up again here.
   */
  readonly stores: SettingsStores;
  /** The process runtime this controller runs its programs on, captured once
   *  here: the controller lives for the length of the chat session, and its
   *  Promise-facing methods are that session's run edge. */
  readonly runtime: ProcessRuntime;
  /** The policy the chat asked for itself (its flag, then `/approval`),
   *  which each launch carries (`launchApproval`); none follows the
   *  project's. */
  readonly approvalPolicy: () => ApprovalPolicy | undefined;
  /** The composer's draft: the skills a message takes, and where a message
   *  the session does not take goes back to. */
  readonly draft: SubscriptionRef.SubscriptionRef<Draft>;
  /** Chat messages wait here until a model is connected. */
  readonly modelConnection: ModelConnection;
}

/** How a submitted message ended: with the session (or a fresh run), or
 *  back in the input, naming why when there is a reason. */
type MessageResult =
  | { readonly kind: 'sent' }
  | { readonly kind: 'returned'; readonly reason?: string };

const SENT: MessageResult = Object.freeze({ kind: 'sent' });

interface PreparedChatInstruction {
  readonly instruction: string;
  readonly displayInstruction?: string;
}

/** The instruction a message sends: its line, wrapped in the prompts of the
 *  skills activated for it. */
function preparedInstruction(
  line: string,
  skills: readonly SkillActivation[],
): PreparedChatInstruction {
  if (skills.length === 0) return { instruction: line };
  return {
    instruction: [
      skills.map((skill) => skill.activationPrompt).join('\n\n'),
      '<user_request>',
      escapeText(line),
      '</user_request>',
    ].join('\n'),
    displayInstruction: line,
  };
}

export function createChatSessionController(
  init: ChatSessionControllerInit,
): ChatSessionController {
  const {
    session,
    runSession,
    served,
    sessionContext,
    chatScope,
    shutdownScope,
    cwd,
    getSlashCommandContext,
    stores,
    runtime,
    draft,
    modelConnection,
  } = init;
  const requests: SessionRequests = runSession;
  // The fold the chat's runs appear in: the service's, or this session's.
  const viewChanges: Stream.Stream<SessionView> = runSession.view.changes;
  /** A run that is no longer live here: its generation let go. */
  const settledHere = (runId: RunId): Effect.Effect<void> =>
    viewChanges.pipe(
      Stream.filter((view) => {
        const run = view.runs.get(runId);
        return run === undefined || !run.runsHere;
      }),
      Stream.runHead,
      Effect.asVoid,
    );

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
        if (run.runsHere) return true;
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
  const adoptRunConfig = Effect.fn('adoptRunConfig')(function* (
    config: Pick<
      AgentConfig,
      'agent' | 'agentSource' | 'model' | 'cli' | 'delegationAgentScope'
    >,
    modelSource?: 'history',
  ) {
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

  // A failure the chat shows: a refused launch by the notice it carries (an
  // unknown model's instruction, an unknown agent) where the chat's runtime
  // notices show, any other as the transcript line `text`. The session
  // shows neither: a launch's failure is its caller's to show.
  const showFailure = (error: unknown, text: string): void => {
    const notice = launchNoticeOf(error);
    if (notice !== undefined)
      presentationHost.emit(notice.event, notice.payload);
    else appendLocalErrorTranscript(text);
  };

  // Shared tail of the run/resume failure recovery: the failure is the
  // claim's exit code, and it is shown unless the chat is gone or the run's
  // own end says the user stopped it. A run whose claim the slot no longer
  // holds (a fork or a new task replaced it) says nothing to the chat.
  const reportRunFailure = (error: unknown, claim: RootRunSettled): void => {
    if (!session.holdsClaim(claim)) return;
    session.settleExitCode(claim, CliExitCode.AgentError);
    if (session.leaving || session.status() === RUN_PHASE.CANCELLED) return;
    const { classification } = normalizeProviderError(error);
    showFailure(
      error,
      modelFailureText({ message: toErrorMessage(error), classification }),
    );
  };

  // One interaction host for the chat session's lifetime, as the extension
  // and desktop attach theirs. The session routes every request to its last
  // attachment, so a detached child of an earlier turn keeps an answerable
  // approval path after its root finalizes, with no per-turn generation.
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
      requests: runSession,
      settings: stores,
      runtime,
    },
  );
  // Attached to the chat's session for its lifetime: here, its requests'
  // host; in the service, one of its project's windows, whose notices its
  // tasks raise here.
  // The attachment closes after the interactions are disposed.
  runtime.runSync(
    Effect.gen(function* () {
      const attached = yield* Scope.fork(chatScope);
      yield* Scope.addFinalizer(
        chatScope,
        Effect.sync(() => interactions.dispose?.()),
      );
      yield* runSession
        .attach(interactions)
        .pipe(Scope.provide(attached), Effect.forkIn(chatScope));
    }),
  );

  // -----------------------------------------------------------------------
  // startRootRun
  // -----------------------------------------------------------------------

  /**
   * The one root-run launch: claims the slot, then prepares and starts the
   * run on its own fiber, so the claim names the run from the first instant.
   * `shownInstruction` goes to the transcript when preparing failed before
   * any run could show it. Completes with whether the session holds the run.
   */
  const launchRootRun = <R>(
    resolveConfig: Effect.Effect<AgentConfigPayload, Error, R>,
    shownInstruction?: string,
  ): Effect.Effect<boolean, never, R> =>
    // The claim and the fork of the program that settles it are one
    // uninterruptible step: an interrupted caller never leaves a claim that
    // nothing will settle. Only the wait for the launch is interruptible.
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const runId = generateRunId();
        // The slot has to be claimed before the chain that settles it exists, so
        // the claim holds the `await` of a `Deferred` the run chain completes.
        // Awaiting the deferred is a plain suspension, so a run parked at the WAIT
        // node leaves the slot pending exactly as before.
        const claimedRun = Deferred.makeUnsafe<void, Error>();
        const claim = Deferred.await(claimedRun);
        // Done once the session holds the run (or the launch did not happen):
        // a message typed meanwhile, or a stop asked meanwhile, waits for it,
        // so it reaches a run that exists.
        const launched = Deferred.makeUnsafe<boolean>();
        const markLaunched = (held: boolean) =>
          Effect.sync(() =>
            Deferred.doneUnsafe(launched, Effect.succeed(held)),
          );
        // Native launch may resolve its stream on this turn. Claim first so
        // marking the run pending cannot erase that run.
        session.markRunPending(
          claim,
          Effect.asVoid(Deferred.await(launched)),
          runId,
        );
        let resolved = false;
        // Owned by the process's shutdown scope, as the chat's sends are.
        return recoverRun(
          Effect.gen(function* () {
            const config = yield* resolveConfig;
            resolved = true;
            yield* adoptRunConfig(config);
            const registeredConfig =
              yield* Schema.decodeUnknownEffect(AgentConfigSchema)(config);
            // Each chat round mints a fresh root run id, so bash/tool-edit/
            // super-YOLO bypass, which is keyed per stream, would otherwise
            // reset every round even though the user is continuing the same
            // conversation. The new round continues the previous one, so bypass
            // resolution falls through to whatever the prior round had, unless
            // this round sets its own explicit value.
            const run = yield* runSession.start({
              config: registeredConfig,
              runId,
              continues: rootRunId.get(),
              approval: launchApproval(init.approvalPolicy()),
              interactive: true,
            });
            rootRunId.set(run.runId);
            moveLocalTranscriptToRun(run.runId);
            focusRun(run.runId);
            yield* markLaunched(true);
            const { outcome } = yield* run.result;
            session.settleExitCode(claim, runOutcomeExitCode(outcome));
          }),
          (error) => {
            if (!resolved && shownInstruction !== undefined) {
              appendLocalUserTranscript(shownInstruction);
            }
            reportRunFailure(error, claim);
          },
        ).pipe(
          Effect.ensuring(
            Effect.andThen(
              markLaunched(false),
              Effect.sync(() => session.markRunCompleted(claim)),
            ),
          ),
          // The claim settles with the run's own exit, so a waiter reads what
          // the run did rather than what a promise adapter made of it.
          settleClaimOnExit(claimedRun),
          Effect.forkIn(shutdownScope),
          Effect.andThen(restore(Deferred.await(launched))),
        );
      }),
    );

  const startRootRun = (config: AgentConfigPayload): Effect.Effect<void> =>
    Effect.asVoid(launchRootRun(Effect.succeed(config)));

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
      // Done once the chat adopted the resumed run, or the resume ended
      // without one: a stop asked meanwhile waits for it.
      const adopted = Deferred.makeUnsafe<void>();
      const markAdopted = (): void => {
        Deferred.doneUnsafe(adopted, Effect.void);
      };
      if (!session.tryClaimRootRunSlot(claim, Deferred.await(adopted))) {
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
        markAdopted();
        session.markRunCompleted(claim);
        Deferred.doneUnsafe(claimedRun, Effect.void);
      };
      const attemptResume = Effect.gen(function* () {
        // The durable record carries the config the TUI adopts before the run.
        const store = init.runSession.records(id);
        const [config, exists] = yield* Effect.all(
          [store.readConfig(), store.exists()],
          { concurrency: 2 },
        );
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
            resumeRun(runSession, id).pipe(
              Effect.catch((refused) =>
                Effect.sync(() =>
                  showFailure(
                    refused,
                    isRequestRefusal(refused)
                      ? requestErrorText(refused)
                      : refused.message,
                  ),
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
            resumed === id
              ? config
              : yield* init.runSession.records(resumed).readConfig();
          if (adoptedConfig === null)
            return yield* Effect.fail(
              new Error(`Run ${resumed} has no configuration to resume`),
            );
          yield* setCliHelperModel(stores.globalState, adoptedConfig.model);
          yield* adoptRunConfig(adoptedConfig, 'history');
          clearLocalTranscript();
          session.runId = resumed;
          rootRunId.set(resumed);
          // The transcript and the work plan are the fold's: the TUI
          // subscribes the run's aggregate and renders `transcript.rows`, and
          // an open `/plan` reader reads the same `RunView`.
          focusRun(resumed);
          // A stop asked before this point lands on the run adopted here.
          markAdopted();
        });

        // A defect reaches the transcript as a failure does: nothing else
        // reads this fiber's exit but the claim.
        yield* Effect.forkIn(
          recoverRun(
            Effect.gen(function* () {
              // A refusal is the resume's answer, not a failure: the chat
              // says it in the session's words and exits as a usage error.
              const run = yield* resumeRun(runSession, id).pipe(
                Effect.catchIf(isRequestRefusal, (refusal) =>
                  Effect.succeed(refusal),
                ),
              );
              if (isRequestRefusal(run)) {
                appendLocalRequestRefusal(run);
                session.settleExitCode(claim, CliExitCode.Usage);
                return;
              }
              yield* adoptResumedRun(run.runId);
              // A root acknowledges at idle, so its result holds this chain,
              // and the root-run slot it settles, until the run ends.
              const { outcome } = yield* run.result;
              session.settleExitCode(claim, runOutcomeExitCode(outcome));
            }),
            (error) => reportRunFailure(error, claim),
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                markAdopted();
                session.markRunCompleted(claim);
              }),
            ),
            // The slot was claimed synchronously above; it settles with this
            // chain, so the exit drain blocks until the continued run actually
            // finishes (or is interrupted), not just until rehydration
            // completes. `resume()`'s own program still completes here, before
            // the run finishes, fire-and-forget per the interface contract.
            settleClaimOnExit(claimedRun),
          ),
          shutdownScope,
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
      const config = yield* init.runSession.records(runId).readConfig();
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
    // The session holds the run already: a stop lands at once.
    if (!session.tryClaimRootRunSlot(claim, Effect.void, runId)) return;
    rootRunId.set(runId);
    focusRun(runId);
    runtime.runSync(
      Effect.gen(function* () {
        yield* adoptRunRecord(runId);
        yield* resumed;
        yield* settledHere(runId);
        const outcome =
          runSession.view.current().runs.get(runId)?.durableOutcome ?? null;
        session.settleExitCode(
          claim,
          outcome === null ? CliExitCode.Success : runOutcomeExitCode(outcome),
        );
      }).pipe(
        Effect.ensuring(Effect.sync(() => session.markRunCompleted(claim))),
        settleClaimOnExit(adopted),
        Effect.forkIn(shutdownScope),
      ),
    );
  };
  let liveHere = new Set<RunId>();
  const observeResumedRoots = (view: SessionView): Effect.Effect<void> =>
    Effect.sync(() => {
      const previous = liveHere;
      liveHere = new Set(
        [...view.runs.values()]
          .filter((run) => run.runsHere)
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
    runtime.runSync(
      Effect.forkIn(
        Stream.runForEach(viewChanges, observeResumedRoots),
        chatScope,
      ),
    );
  }

  // -----------------------------------------------------------------------
  // stop
  // -----------------------------------------------------------------------

  /** A stop lands on a run the session holds. One asked while the claim's
   *  launch is still entering the session waits for it, then lands on the
   *  run the chat holds then: the claim's, or the one a launch replaced it
   *  with for the same `runId`. Ctrl-C leaves the child policy unset, so the
   *  stop itself (`Runs.stop`) applies the configured "Keep agents running";
   *  why the run then stops is the run registry's fact. */
  const stop = (reason: RunStopReason): void => {
    // A chat of the background service leaves its task running when the
    // terminal goes: only the user's own stop reaches it.
    if (reason === 'shutdown' && served) return;
    const asked = session.claim;
    if (asked.runSettled === undefined) return;
    runtime.runFork(
      asked.launched.pipe(
        Effect.andThen(
          Effect.suspend(() => {
            const claim = session.claim;
            const runId = claim.runId;
            if (runId === undefined || !chatTuiRunPending(claim))
              return Effect.void;
            if (claim.runSettled !== asked.runSettled && runId !== asked.runId)
              return Effect.void;
            return request({ kind: 'run.stop', runId, reason });
          }),
        ),
      ),
    );
  };

  /** A fresh root run of the chat's agent on the model it selects now. */
  const startSession = (
    instruction: string,
    mediaFiles?: readonly string[],
    displayInstruction?: string,
  ): Effect.Effect<boolean, never, ProcessServices> =>
    launchRootRun(
      Effect.gen(function* () {
        const meta = sessionMetaSignal.get();
        const selection = yield* selectCliRunnableModel(
          [{ model: meta.model, reason: meta.modelSource }],
          {
            stores: { ...stores, runtime },
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
        return {
          agent: meta.agent,
          agentSource: meta.agentSource,
          model: selection.model,
          instruction,
          ...(displayInstruction !== undefined ? { displayInstruction } : {}),
          workingDirectory: cwd,
          ...(mediaFiles?.length ? { mediaFiles: [...mediaFiles] } : {}),
          ...(meta.cliTeamId ? { cli: { teamId: meta.cliTeamId } } : {}),
          ...(meta.delegationAgentScope
            ? { delegationAgentScope: meta.delegationAgentScope }
            : {}),
        } satisfies AgentConfigPayload;
      }),
      displayInstruction ?? instruction,
    );

  // Where each message goes is decided one at a time, in the order typed,
  // so a message typed while the chat starts its run waits until the
  // session holds that run. The send itself runs outside: the session keeps
  // a run's messages in order.
  const inOrder = Semaphore.makeUnsafe(1).withPermit;
  // The sends in flight, which a graceful exit waits for.
  const sending = runtime.runSync(
    FiberSet.make<MessageResult>().pipe(Scope.provide(shutdownScope)),
  );

  /**
   * Send `prepared` to `target`. The session decides everything about the
   * message: whether the run takes it, waiting for a run that is stopping
   * to finish, and resuming a run that is not running. `continuing`: the
   * message may continue `target`, the root, outside the chat's running
   * claim: a root the chat does not hold, or the held root once the session
   * answers that it queued the message (the run was stopping, so the
   * session resumes it); the chat then adopts the run.
   */
  const sendMessage = Effect.fn('sendMessage')(function* (
    target: RunId,
    continuing: boolean,
    prepared: PreparedChatInstruction,
    mediaFiles: readonly string[],
    holdUntil: 'turn' | undefined,
  ) {
    const before = runSession.view.current().runs.get(target);
    // The claim of the stopped run, while the chat still holds it.
    const stoppedClaim = chatTuiRunPending(session)
      ? session.runSettled
      : undefined;
    // The request and its presentation are one uninterruptible step: a
    // request that committed is always followed by its notice.
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const outcome = yield* requests
          .request({
            kind: 'followUp.send',
            runId: target,
            text: prepared.instruction,
            displayText: prepared.displayInstruction,
            media: mediaFiles.length > 0 ? [...mediaFiles] : undefined,
            holdUntil,
          })
          .pipe(
            Effect.match({
              onFailure: (error) => ({
                kind: 'refused' as const,
                reason: requestErrorText(error),
              }),
              onSuccess: (value) => ({ kind: 'sent' as const, value }),
            }),
            // `match` recovers only the typed refusal; a defect is read the
            // way `SessionBridge` answers `Internal`: logged and worded.
            Effect.catchCause(
              Effect.fnUntraced(function* (cause) {
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
          return outcome.kind === 'interrupted'
            ? { kind: 'returned' as const }
            : { kind: 'returned' as const, reason: outcome.reason };
        }
        // The session resumed the stopped conversation: the slot passes to
        // it once the stopped run's claim lets go, so the next message goes
        // to it rather than starting a second root beside it.
        if (
          continuing &&
          (stoppedClaim === undefined || outcome.value.status === 'queued')
        )
          yield* Effect.forkIn(
            Effect.ignoreCause(stoppedClaim ?? Effect.void).pipe(
              Effect.andThen(
                Effect.sync(() =>
                  adoptResumedRoot(target, continuedSince(target, before)),
                ),
              ),
            ),
            shutdownScope,
          );
        const presentation = presentFollowUpResult(outcome.value);
        if (presentation.severity !== 'none') {
          appendLocalNotice(presentation.message, target);
        }
        return SENT;
      }),
    );
  });

  /** A message back in the input, below whatever was typed since. */
  const returnToInput = (
    message: Draft,
    reason?: string,
  ): Effect.Effect<void> =>
    SubscriptionRef.update(draft, (current) =>
      restoreDraft(current, message),
    ).pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (reason !== undefined) {
            setTransientNotice(
              `${reason} The message has been restored to the input.`,
              { ttlMs: Infinity },
            );
          }
        }),
      ),
    );

  const submitChatMessage = Effect.fn('submitChatMessage')(function* (
    submitted: Draft,
    line: string,
    holdUntil: 'turn' | undefined,
  ) {
    // The message takes the skills activated for it.
    const skills = yield* SubscriptionRef.modify(draft, (current) => [
      current.skills,
      { ...current, skills: [] },
    ]);
    const message: Draft = { ...submitted, skills };
    const prepared = preparedInstruction(line, skills);
    const mediaFiles = resolveImages(message).map((image) => image.path);
    const send = (target: RunId, continuing: boolean) =>
      FiberSet.run(
        sending,
        sendMessage(target, continuing, prepared, mediaFiles, holdUntil),
      );
    const returned = (reason?: string): MessageResult => ({
      kind: 'returned',
      ...(reason !== undefined ? { reason } : {}),
    });
    const route = Effect.gen(function* () {
      if (session.leaving) return returned();
      // The focused agent below the root takes the message.
      const focused = runViewOf(currentView(), selectedRunIdSignal.get());
      if (focused !== undefined && focused.parentId !== null)
        return yield* send(focused.id, false);
      // The root run the chat holds, stopping or not.
      if (chatTuiRunPending(session)) {
        const held = session.runId;
        if (held === undefined)
          return returned('The conversation is still being resumed.');
        return yield* send(held, true);
      }
      // The conversation's root while it runs without the chat holding it
      // (the session resumed it), or one the user stopped, which the session
      // continues; anything else (none yet, or one that failed) starts a
      // fresh run, which picks its model again. A run that does not start
      // gives back only the skills: its failure is in the transcript.
      const root = runViewOf(currentView(), rootRunId.get());
      if (
        root !== undefined &&
        (root.live || root.status === RUN_PHASE.CANCELLED) &&
        acceptsFollowUp(root)
      )
        return yield* send(root.id, true);
      const started = yield* startSession(
        prepared.instruction,
        mediaFiles,
        prepared.displayInstruction,
      );
      if (!started) yield* returnToInput({ ...EMPTY_DRAFT, skills });
      return SENT;
    });
    // Where the message ended is decided once, here: a failure or a throw is
    // reported to the transcript and, like the runtime closing, sends the
    // message back to the input. Waiting for a forked send is
    // uninterruptible, so a message the session took is never also back in
    // the input.
    yield* Effect.gen(function* () {
      // Waiting for a model happens before the lane, so the exit's drain
      // (which takes the lane) never waits on a message that is not sent.
      yield* modelConnection.connected;
      const routed = yield* inOrder(route);
      return Fiber.isFiber(routed)
        ? yield* Effect.uninterruptible(Fiber.join(routed))
        : routed;
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? returnToInput(message)
          : exit.value.kind === 'returned'
            ? returnToInput(message, exit.value.reason)
            : Effect.void,
      ),
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
    submitted: Draft,
    holdUntil?: 'turn',
  ) {
    const line = expandText(submitted).trim();
    if (line.length === 0) return;
    if (yield* handleTuiSlashCommand(line, getSlashCommandContext())) return;
    yield* submitChatMessage(submitted, line, holdUntil);
  });

  const activateSkill = (selection: SkillActivation): void => {
    const wasPending = SubscriptionRef.getUnsafe(draft).skills.some(
      (skill) => skill.name === selection.name,
    );
    runtime.runSync(
      SubscriptionRef.update(draft, (current) => withSkill(current, selection)),
    );
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
    clearPendingSkills: () =>
      runtime.runSync(
        SubscriptionRef.update(draft, (current) => ({
          ...current,
          skills: [],
        })),
      ),
  };
}
