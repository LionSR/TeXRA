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
  LaunchRefused,
  type Run,
  type RunStopReason,
  type Session,
} from '@texra-ai/harness';
import {
  normalizeProviderError,
  presentFollowUpResult,
  type ProcessRuntime,
  type ProcessServices,
} from '@texra-ai/harness/host';
import {
  type RuntimeCommand,
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
  toErrorMessage,
} from '@texra-ai/harness/schemas';
import { createCliRuntimeHost } from '@cli/runtime/headless/cliPresentationHost';
import {
  formatCliNoAvailableModelsRecovery,
  selectCliRunnableModel,
} from '@cli/runtime/models/modelAccess';
import { setCliHelperModel } from '@cli/runtime/platform/initPlatform';
import { readCliTeamName } from '@cli/runtime/cliTeams';
import { CliExitCode } from '@cli/runtime/platform/exitCodes';
import {
  launchApproval,
  type CliContext,
} from '@cli/runtime/platform/cliContext';
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
import type { TuiSession } from './tui/state/sessionRunState';
import { oneShotResumeNotice } from './tui/state/resumeHint';
import { currentView, runViewOf, sessionView } from './tui/state/sessionView';
import { subscribeToSignalChanges } from '@texra/shared/signals';
import { createTuiHostInteractions } from './tui/state/subscribeApprovals';
import type { HostCommand } from '@texra/shared/session/hostRequest';
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
import type { SettingsStores } from '@texra-ai/harness/plugins';
import { isRequestRefusal } from '@texra/controllers/session/hostCallFailure';

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
  /** Succeeds once the root launch on its way has reached its end and the
   *  chat's root run is no longer live here: what an exit that stopped the
   *  root waits for. */
  readonly rootRunEnded: Effect.Effect<void>;
  /** Activate a skill for the next submitted message. */
  activateSkill(selection: SkillActivation): void;
  /** Drop every activated skill. */
  clearPendingSkills(): void;
  /** Perform the host command a decision names instead of a
   *  `request.decide`, on the chat's attached host. */
  readonly performHost: (command: HostCommand) => void;
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
  const endedHere = (runId: RunId): Effect.Effect<void> =>
    viewChanges.pipe(
      Stream.filter((view) => {
        const run = view.runs.get(runId);
        return run === undefined || run.holder !== 'here';
      }),
      Stream.runHead,
      Effect.asVoid,
    );

  /** Issue one request to the session's runtime and read its Effect result
   *  as the response (PRD 7.6): the refusal text, or undefined on success. */
  const request = (req: RuntimeCommand): Effect.Effect<string | undefined> =>
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
    const notice = error instanceof LaunchRefused ? error.notice : undefined;
    if (notice !== undefined)
      presentationHost.emit(notice.event, notice.payload);
    else appendLocalErrorTranscript(text);
  };

  // A launch's failure, shown unless the chat is leaving.
  const reportRunFailure = (error: unknown): void => {
    if (session.exited) return;
    const { classification } = normalizeProviderError(error);
    showFailure(
      error,
      modelFailureText({ message: toErrorMessage(error), classification }),
    );
  };
  // A held run's own failure (its end could not be read) fails the chat's
  // exit and says so, only while it is still the chat's root and the user
  // did not stop it.
  const reportHeldRunFailure = (runId: RunId, error: unknown): void => {
    if (rootRunId.get() !== runId) return;
    if (runViewOf(currentView(), runId)?.outcome === 'cancelled') return;
    session.rootFailed(runId);
    reportRunFailure(error);
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

  /** Done once the chat's view shows `runId` held here. */
  const shownHeld = (runId: RunId): Effect.Effect<void> =>
    Effect.callback<void>((resume) => {
      const shown = () => runViewOf(currentView(), runId)?.holder === 'here';
      if (shown()) return resume(Effect.void);
      const unsubscribe = subscribeToSignalChanges([sessionView()], () => {
        if (shown()) resume(Effect.void);
      });
      return Effect.sync(unsubscribe);
    });

  /**
   * Hand the launch `launched` over to `run`: the launch ends, naming the
   * run, once the chat's view shows it held here or its result is in. Until
   * then the launch is still on its way, so a stop, a message and the Ctrl-C
   * hint wait for it instead of reading a view that has not caught up (a
   * service window's watch can lag the session's start). Answers the run's
   * result, read once.
   */
  const handOver = Effect.fnUntraced(function* (
    launched: Deferred.Deferred<RunId | null>,
    run: Run,
  ) {
    const result = yield* Effect.cached(run.result);
    yield* Effect.raceFirst(shownHeld(run.runId), Effect.ignore(result));
    session.endLaunch(launched, { runId: run.runId });
    return result;
  });

  /**
   * The one root-run launch: claims the root launch, then prepares and
   * starts the run on its own fiber, so a message typed while the model is
   * chosen already sees the launch. `shownInstruction` goes to the
   * transcript when preparing failed before any run could show it.
   * Completes with whether the session holds the run.
   */
  const launchRootRun = <R>(
    resolveConfig: Effect.Effect<AgentConfigPayload, Error, R>,
    shownInstruction?: string,
  ): Effect.Effect<boolean, never, R> =>
    // The claim and the fork of the program that ends it are one
    // uninterruptible step: an interrupted caller never leaves a launch
    // that nothing will end. Only the wait for the launch is interruptible.
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const launched = session.claimLaunch();
        if (launched === undefined) return Effect.succeed(false);
        const runId = generateRunId();
        let resolved = false;
        let held = false;
        const launch = Effect.gen(function* () {
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
          held = true;
          moveLocalTranscriptToRun(run.runId);
          focusRun(run.runId);
          return { runId: run.runId, result: yield* handOver(launched, run) };
        });
        // Owned by the process's shutdown scope, as the chat's sends are.
        return recoverRun(launch, (error) => {
          if (!resolved && shownInstruction !== undefined) {
            appendLocalUserTranscript(shownInstruction);
          }
          reportRunFailure(error);
          session.endLaunch(launched, { exitCode: CliExitCode.AgentError });
          return undefined;
        }).pipe(
          Effect.flatMap((run) =>
            run === undefined
              ? Effect.void
              : recoverRun(Effect.asVoid(run.result), (error) =>
                  reportHeldRunFailure(run.runId, error),
                ),
          ),
          Effect.ensuring(
            Effect.sync(() =>
              session.endLaunch(launched, { exitCode: CliExitCode.Success }),
            ),
          ),
          Effect.forkIn(shutdownScope),
          Effect.andThen(restore(Deferred.await(launched))),
          Effect.map(() => held),
        );
      }),
    );

  const startRootRun = (config: AgentConfigPayload): Effect.Effect<void> =>
    Effect.asVoid(launchRootRun(Effect.succeed(config)));

  // -----------------------------------------------------------------------
  // resume
  // -----------------------------------------------------------------------

  // The user's resume of a conversation they pick. Config is adopted once
  // the session accepted the resumed run.
  const resume = (id: RunId): Effect.Effect<void, Error> =>
    // The claim and the fork of the program that ends it are one
    // uninterruptible step, as a launch's are.
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const launched = session.claimLaunch();
        if (launched === undefined) {
          appendLocalNotice(
            'Finish the active task before resuming a previous one.',
          );
          return Effect.void;
        }
        const endWithout = (exitCode: CliExitCode) =>
          Effect.sync(() => session.endLaunch(launched, { exitCode }));
        const attemptResume = Effect.gen(function* () {
          // The durable record carries the config the TUI adopts before the run.
          const store = init.runSession.records(id);
          const [config, exists] = yield* Effect.all(
            [store.readConfig, store.exists],
            { concurrency: 2 },
          );
          if (!config || !exists) {
            appendLocalErrorTranscript(`Task not found: ${id}`);
            return;
          }
          // A document task takes no chat: it resumes beside this one, as
          // `/resume all` resumes it, and joins the agent list.
          if (isTaskConfig(config)) {
            appendLocalNotice(`Resuming document task ${id}. Tab lists it.`);
            yield* endWithout(CliExitCode.Success);
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
          // A run launched to run once reads no messages: once it ended, a
          // chat over it would refuse every one, so it continues as a fork.
          // One stopped mid-turn still resumes to finish it. Read from the
          // log: at startup a service window's own view has not filled yet.
          const stored = (yield* runSession.view.read([id])).runs.get(id);
          if (stored?.takesFollowUps === false && stored.outcome !== null) {
            appendLocalErrorTranscript(
              oneShotResumeNotice(init.sessionContext.commandName, id),
            );
            return;
          }

          // A refusal is the resume's answer, not a failure: the chat says
          // it in the session's words and exits as a usage error.
          const run = yield* resumeRun(runSession, id).pipe(
            Effect.catchIf(isRequestRefusal, (refusal) =>
              Effect.succeed(refusal),
            ),
          );
          if (isRequestRefusal(run)) {
            appendLocalRequestRefusal(run);
            yield* endWithout(CliExitCode.Usage);
            return;
          }
          // Adopting the resumed stream is the mutation a refusal must not
          // cost: it runs only once the session accepted the run, so a
          // refusal reaches the chat the user is looking at instead of a
          // cleared transcript switched onto a dead stream. The run resumed
          // is the one asked for, or the parent that owns it.
          const adoptedConfig =
            run.runId === id
              ? config
              : yield* init.runSession.records(run.runId).readConfig;
          if (adoptedConfig === null)
            return yield* Effect.fail(
              new Error(`Run ${run.runId} has no configuration to resume`),
            );
          yield* setCliHelperModel(stores.globalState, adoptedConfig.model);
          yield* adoptRunConfig(adoptedConfig, 'history');
          clearLocalTranscript();
          // The transcript and the work plan are the view's: the TUI
          // subscribes the run's aggregate and renders `transcript.rows`, and
          // an open `/plan` reader reads the same `RunView`.
          focusRun(run.runId);
          // A stop asked before this point lands on the run adopted here.
          const result = yield* handOver(launched, run);
          yield* recoverRun(Effect.asVoid(result), (error) =>
            reportHeldRunFailure(run.runId, error),
          );
        });
        // A defect reaches the transcript as a failure does. The program
        // completes once the session holds the run, or the resume ended
        // without one; the run itself goes on.
        return recoverRun(attemptResume, (error) => {
          reportRunFailure(error);
          session.endLaunch(launched, { exitCode: CliExitCode.AgentError });
        }).pipe(
          Effect.ensuring(endWithout(CliExitCode.Success)),
          Effect.forkIn(shutdownScope),
          Effect.andThen(restore(Deferred.await(launched))),
          Effect.asVoid,
        );
      }),
    );

  /** Adopt a resumed run's configuration and helper model. A failure is the
   *  chat's own line (the TUI's log sink is silent): the run goes on, but the
   *  chat's model and settings may not be the run's. */
  const adoptRunRecord = (runId: RunId) =>
    Effect.gen(function* () {
      const config = yield* init.runSession.records(runId).readConfig;
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
   * A top-level run the session resumed (a follow-up wake, the stopped
   * conversation's continuation among them) is this chat's root the way its
   * own launch is: the chat focuses it and adopts its configuration. The
   * resume itself is the session's; the chat only reacts.
   */
  const adoptRoot = (runId: RunId): void => {
    if (!session.takeUpRoot(runId)) return;
    focusRun(runId);
    runtime.runSync(Effect.forkIn(adoptRunRecord(runId), shutdownScope));
  };
  // A run counts from the level where it is live here and was not on the
  // level before, so neither a child detached while running (live already)
  // nor a stale terminal row is taken up. While no launch is on its way, the
  // chat takes one up when its root is not live here, or when it is the
  // root itself continuing after an end (not the first activation of the
  // chat's own launch).
  let previous: SessionView | undefined;
  const observeResumedRoots = (view: SessionView): Effect.Effect<void> =>
    Effect.sync(() => {
      const before = previous;
      previous = view;
      for (const run of view.runs.values()) {
        if (run.holder !== 'here' || run.parentId !== null) continue;
        const was = before?.runs.get(run.id);
        if (was?.holder === 'here' || session.launched !== undefined) continue;
        const root = rootRunId.get();
        if (
          run.id === root
            ? was !== undefined && was.outcome !== null
            : runViewOf(view, root)?.holder !== 'here'
        )
          adoptRoot(run.id);
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

  /** The chat's root as the session holds it now. */
  const heldRoot = (): RunView | undefined => {
    const run = runViewOf(runSession.view.current(), rootRunId.get());
    return run?.holder === 'here' ? run : undefined;
  };

  /** A stop lands on the root the session holds. One asked while a launch
   *  is still entering the session waits for it, then lands on the run that
   *  launch reached (a stop of a run that already ended is a no-op).
   *  Ctrl-C leaves the child policy unset, so the stop itself (`Runs.stop`)
   *  applies the configured "Keep agents running"; why the run then stops
   *  is the run registry's fact. */
  const stop = (reason: RunStopReason): void => {
    // A chat of the background service leaves its task running when the
    // terminal goes: only the user's own stop reaches it.
    if (reason === 'shutdown' && served) return;
    const launched = session.launched;
    if (launched === undefined && heldRoot() === undefined) return;
    runtime.runFork(
      (launched === undefined
        ? Effect.sync((): RunId | null => heldRoot()?.id ?? null)
        : Deferred.await(launched)
      ).pipe(
        Effect.flatMap((runId) =>
          runId == null
            ? Effect.void
            : request({ kind: 'run.stop', runId, reason }),
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
   * message may continue `target`, the root: a root the session does not
   * hold, or the held root once the session answers that it queued the
   * message (the run was stopping, so the session resumes it).
   */
  const sendMessage = Effect.fn('sendMessage')(function* (
    target: RunId,
    continuing: boolean,
    prepared: PreparedChatInstruction,
    mediaFiles: readonly string[],
    holdUntil: 'turn' | undefined,
  ) {
    const wasHeld = runViewOf(currentView(), target)?.holder === 'here';
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
        // The session continues the conversation for this message. A chat
        // of the service sees no resumes of its own, so it takes the root
        // up here; this session's chat takes it up as the view shows it.
        if (
          served &&
          continuing &&
          (!wasHeld || outcome.value.status === 'queued')
        )
          adoptRoot(target);
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
      if (session.exited) return returned();
      // The focused agent below the root takes the message.
      const focused = runViewOf(currentView(), selectedRunIdSignal.get());
      if (focused !== undefined && focused.parentId !== null)
        return yield* send(focused.id, false);
      // A launch on its way: the message goes to its run once the session
      // holds it. One that ended without a run leaves the message to start
      // its own below.
      const pending = session.launched;
      if (pending !== undefined) {
        const launchedRun = yield* Deferred.await(pending);
        if (launchedRun !== null) return yield* send(launchedRun, true);
      }
      // The root run the session holds, stopping or not, or one the user
      // stopped, which the session continues; anything else (none yet, or
      // one that failed) starts a fresh run, which picks its model again. A
      // run that does not start gives back only the skills: its failure is
      // in the transcript.
      const root = runViewOf(currentView(), rootRunId.get());
      if (
        root !== undefined &&
        (root.holder === 'here' ||
          (root.outcome === 'cancelled' && acceptsFollowUp(root)))
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
    rootRunEnded: Effect.suspend(() => {
      const launched = session.launched;
      return (
        launched === undefined ? Effect.void : Deferred.await(launched)
      ).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            const runId = rootRunId.get();
            return runId === undefined ? Effect.void : endedHere(runId);
          }),
        ),
      );
    }),
    activateSkill,
    performHost: interactions.performHost,
    clearPendingSkills: () =>
      runtime.runSync(
        SubscriptionRef.update(draft, (current) => ({
          ...current,
          skills: [],
        })),
      ),
  };
}
