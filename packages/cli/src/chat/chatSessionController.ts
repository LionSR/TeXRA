// Chat-session controller: owns run start/resume/stop state-transition
// orchestration and the composer's submit path for the CLI chat session.
// Host-neutral (no Ink/TUI rendering dependencies): the Ink component
// consumes narrow commands exposed here.

import {
  Cause,
  Data,
  Deferred,
  Effect,
  Fiber,
  Option,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';

import { getRunRecords } from '@agent/storage';
import {
  AgentConfigSchema,
  resumeRun,
  runAgent,
  type AgentConfig,
  type AgentConfigPayload,
  type SessionHandle,
} from '@agent/runtime';
import {
  describeFollowUpFailure,
  presentFollowUpResult,
  resumeOnSession,
} from '@agent/followUp';
import { type CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { readCliTeamName } from '@cli/runtime/cliTeams';
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
import type { SessionBackend } from '@controllers/session/sessionBackend';
import type { WindowHost } from '@controllers/server/windowHost';
import type { RunModelDecisionReason } from '@model/runModelDecision';
import type { DisposableStore } from '@platform/disposable';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';
import {
  acceptsFollowUp,
  isLiveRun,
  type RunView,
  type SessionView,
} from '@shared/session/sessionView';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import { isDocumentTaskConfig, RUN_OUTCOME, type RunId } from '@shared/schemas';
import { heldElsewhereBy } from '@shared/session/database';
import type {
  RunStopReason,
  RuntimeRequest,
} from '@shared/session/runtimeRequest';
import { escapeText } from '@shared/utils/xmlEscape';
import { FOCUSED_AGENT } from '@ui/copy/nestedRuns';
import { sessionStoreMovedAsideMessage } from '@ui/copy/sessionStore';
import { generateRunId } from '@utils/core';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
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
  chatTuiCanStartRootRun,
  type TuiSession,
} from './tui/state/sessionRunState';
import {
  currentView,
  runViewOf,
  CLI_FOLLOW_UP_HOST,
} from './tui/state/sessionView';
import { createTuiHostInteractions } from './tui/state/subscribeApprovals';
import {
  appendLocalErrorTranscript,
  appendLocalNotice,
  appendLocalUserTranscript,
  clearLocalTranscript,
  describeRequestError,
  moveLocalTranscriptToRun,
  reportRequestDefect,
} from './tui/state/transcript';
import type { FollowUpDeliveryQueue } from './followUpDeliveryQueue';
import type { ChatAgentRuns } from './serviceAgentRuns';
import type { SessionRequests } from './tui/state/approvalQueue';
import type { SkillActivation } from './tui/forms/SkillsListForm';
import type { PastedImageEntry } from './tui/input/draftAttachments';

/** The root-run slot a message continuing the stopped conversation holds
 *  while the session resumes it, so the chat reads as busy (Ctrl-C stops,
 *  it does not exit) until the resumed run takes the slot over. */
interface PreparingRoot {
  readonly runId: RunId;
  readonly slot: Deferred.Deferred<void, Error>;
  /** The user stopped meanwhile: the stop lands on the run once it is live. */
  stopped: boolean;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

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
/** A view edit a resume applies once the run is back at its park:
 *  `texra resume --reset` (`handoff` null) or `--handoff <text>`. */
export interface ResumeEdit {
  readonly handoff: string | null;
}

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
  resume(id: RunId, edit?: ResumeEdit): Effect.Effect<void, Error>;

  /** Request stop of the root run using the configured child policy, for
   *  `reason`: a `user` stop also cancels its remote background work. */
  stop(reason: RunStopReason): void;

  /**
   * The composer's submit path (PRD 10.1): a slash command, the first
   * instruction of a fresh root run, a message into an interrupted root, or
   * a `followUp.send` request onto the focused stream.
   */
  submit(
    line: string,
    mediaFiles?: readonly string[],
    images?: readonly PastedImageEntry[],
  ): Effect.Effect<void, Error, ProcessServices>;
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

  /** The process's shutdown scope: the interaction host closes there, so
   *  every exit path, signal or graceful, awaits its close. */
  readonly shutdownScope: Scope.Scope;

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
  /** The agent run boundary the controller drives. Composition leaves it
   *  unset and gets the agent runtime's own; a test harness injects its
   *  stand-ins here rather than mocking agent modules. */
  readonly agentRuns?: Partial<ChatAgentRuns> & {
    readonly records?: typeof getRunRecords;
  };
  /** Where run requests land, edit previews come from and run state is
   *  read, when the chat is a client of the background service; its own
   *  session otherwise. */
  readonly backend?: Pick<SessionBackend, 'request' | 'preview' | 'view'>;
  /** Offer the service what this chat shows for its project's tasks. */
  readonly attachWindow?: (host: WindowHost) => void;
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
    shutdownScope,
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
  const agentRuns = {
    launch: runAgent,
    resume: resumeRun,
    resumeBeside: (id: RunId) =>
      Effect.asVoid(resumeOnSession(id, runtimeSession)),
    records: getRunRecords,
    ...init.agentRuns,
  };
  const requests: SessionRequests = init.backend ?? runtimeSession.requests;
  // The fold the chat's runs appear in: the service's, or this session's.
  const viewChanges =
    init.backend === undefined
      ? runtimeSession.viewChanges
      : SubscriptionRef.changes(init.backend.view);
  // Said in the transcript the controller writes to, not on stderr before
  // Ink mounts, where it would be left above the header.
  if (runtimeSession.storeMovedAside) {
    appendLocalNotice(
      sessionStoreMovedAsideMessage(runtimeSession.storeMovedAside),
    );
  }
  let preparingRoot: PreparingRoot | undefined;
  const pendingSkillActivations = new Map<string, string>();
  let pendingSkillActivationClearEpoch = 0;

  /** `runId` once the fold holds it, from the first view level that does. */
  const awaitRunFolded = (
    runId: RunId | undefined,
  ): Effect.Effect<RunId | undefined> =>
    runId === undefined
      ? Effect.succeed(undefined)
      : viewChanges.pipe(
          Stream.filter((view) => view.runs.has(runId)),
          Stream.runHead,
          Effect.map((head) => (Option.isSome(head) ? runId : undefined)),
        );

  /** Issue one request to the session's runtime and read its Effect result
   *  as the response (PRD 7.6): the refusal text, or undefined on success. */
  const request = (req: RuntimeRequest): Effect.Effect<string | undefined> =>
    requests.request(req).pipe(
      Effect.match({
        onFailure: describeRequestError,
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
        runtimeSession.roots.repoState,
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

  // The reason of the stop asked last, for a stop re-issued once the launch
  // gap closes.
  let stopReason: RunStopReason = 'user';
  const requestStop = (reason: RunStopReason): void => {
    stopReason = reason;
    session.stopRequested = true;
    // A continuation of the stopped conversation stops with it.
    if (preparingRoot) preparingRoot.stopped = true;
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
    // Ctrl-C leaves the child policy unset, so the session's request handler
    // applies the configured "Keep agents running".
    runtime.runFork(request({ kind: 'run.stop', runId, reason: stopReason }));
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
      session: runtimeSession,
      requests,
      preview: init.backend?.preview,
      secrets,
      settings: stores,
      runtime,
    },
  );
  disposables.add(
    runtime.runSync(runtimeSession.interactions.use(interactions)),
  );
  // A chat of the service is one of its project's windows: the notices
  // its tasks raise are shown here.
  init.attachWindow?.({
    emit: interactions.emit,
    approvalDenied: interactions.approvalDenied,
  });

  // -----------------------------------------------------------------------
  // startRootRun
  // -----------------------------------------------------------------------

  const startRootRun = (config: AgentConfigPayload): void => {
    session.interruptedRunId = undefined;
    const runId = generateRunId();

    // The slot has to be claimed before the chain that settles it exists, so
    // the claim holds the `await` of a `Deferred` the run chain completes.
    // Awaiting the deferred is a plain suspension, so a run parked at the WAIT
    // node leaves the slot pending exactly as before.
    const claimedRun = Deferred.makeUnsafe<void, Error>();
    // Native launch may resolve its stream on this turn. Claim first so
    // marking the run pending cannot erase that run or a reentrant stop.
    session.markRunPending(Deferred.await(claimedRun));
    session.runId = runId;
    runtime.runFork(
      recoverRun(
        Effect.gen(function* () {
          yield* adoptRunConfig(config);
          const registeredConfig = yield* Effect.try({
            try: () => AgentConfigSchema.parse(config),
            catch: ensureError,
          });
          // Each chat round mints a fresh root run id, so bash/tool-edit/
          // super-YOLO bypass, which is keyed per stream, would otherwise
          // reset every round even though the user is continuing the same
          // conversation. The new round continues the previous one, so bypass
          // resolution falls through to whatever the prior round had, unless
          // this round sets its own explicit value.
          const previousRootRunId = rootRunId.get();
          const result = yield* agentRuns.launch(
            { config: registeredConfig, runId },
            {
              session: runtimeSession,
              ...(previousRootRunId !== undefined && {
                continues: previousRootRunId,
              }),
              onRunResolved: (resolvedRunId) => {
                rootRunId.set(resolvedRunId);
                moveLocalTranscriptToRun(resolvedRunId);
                focusRun(resolvedRunId);
                if (session.stopRequested) interruptActiveRun();
              },
            },
          );
          session.runExitCode = runOutcomeExitCode(result.outcome);
        }),
        reportRunFailure,
      ).pipe(
        Effect.ensuring(Effect.sync(() => session.markRunCompleted())),
        // The claim settles with the run's own exit, so a waiter reads what
        // the run did rather than what a promise adapter made of it.
        settleClaimOnExit(claimedRun),
      ),
    );
  };

  // -----------------------------------------------------------------------
  // resume
  // -----------------------------------------------------------------------

  // The user's resume of a conversation they pick. Config is adopted inside
  // `onResumeResolved`, which `resumeRun` calls only once the saved state
  // loaded. The stopped conversation it supersedes stays the chat's target
  // again when the resume never reaches its run.
  const resume = (id: RunId, edit?: ResumeEdit): Effect.Effect<void, Error> =>
    // `Effect.suspend` is what keeps the claim handshake synchronous: its
    // body is this program's first step, so the availability check and the
    // claim are one uninterrupted synchronous callback (see
    // tryClaimRootRunSlot) that no other fiber can land between, and a
    // root the session resumes (or another resume()) can never observe this
    // call suspended between "checked available" and "claimed".
    Effect.suspend(() => {
      const claimedRun = Deferred.makeUnsafe<void, Error>();
      if (!session.tryClaimRootRunSlot(Deferred.await(claimedRun))) {
        // The slot is taken, so the deferred this attempt made is dropped
        // unsettled: nothing holds it, and no fiber is parked on it.
        appendLocalNotice(
          'Finish the active task before resuming a previous one.',
        );
        return Effect.void;
      }

      const superseded = session.interruptedRunId;
      session.interruptedRunId = undefined;
      let adopted = false;
      const restoreSuperseded = (): void => {
        if (!adopted) session.interruptedRunId ??= superseded;
      };
      /** The end of a resume that never reached its run: announce, complete,
       *  settle. */
      const endResumeUnstarted = (announce: () => void): void => {
        restoreSuperseded();
        announce();
        session.markRunCompleted();
        Deferred.doneUnsafe(claimedRun, Effect.void);
      };
      const attemptResume = Effect.gen(function* () {
        // The durable record carries the config the TUI adopts before the run.
        const store = agentRuns.records(runtimeSession, id);
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
        if (isDocumentTaskConfig(config)) {
          endResumeUnstarted(() =>
            appendLocalNotice(`Resuming document task ${id}. Tab lists it.`),
          );
          yield* Effect.forkDetach(agentRuns.resumeBeside(id));
          return;
        }

        // Adopting the resumed stream is the mutation a refusal must not cost:
        // `resumeRun` calls this only once the saved state loaded, so the
        // refusal reaches the chat the user is looking at instead of a cleared
        // transcript switched onto a dead stream. A Ctrl-C during the steps
        // below lands as `session.stopRequested`, which `resumeRun` re-reads
        // once this returns, rather than starting an agent the user cancelled.
        // The run resumed is the one asked for, or the parent that owns it.
        const adoptResumedRun = Effect.fn('adoptResumedRun')(function* (
          resumed: RunId,
        ) {
          const adoptedConfig =
            resumed === id
              ? config
              : yield* agentRuns.records(runtimeSession, resumed).readConfig();
          if (adoptedConfig === null)
            return yield* Effect.fail(
              new Error(`Run ${resumed} has no configuration to resume`),
            );
          yield* setCliHelperModel(stores.globalState, adoptedConfig.model);
          yield* adoptRunConfig(adoptedConfig, 'history');
          adopted = true;
          clearLocalTranscript();
          followUpQueue.clear();
          session.runId = resumed;
          rootRunId.set(resumed);
          // The pre-resume stream was dropped by the synchronous slot claim
          // above, so a Ctrl-C before adoption had nothing to interrupt;
          // re-read the request here and let it land on the run the user
          // asked to continue. `resumeRun` re-reads `isCancellationRequested`
          // once this hook returns, so the stop still refuses the launch; this
          // only decides which stream it marks recoverable.
          if (session.stopRequested) interruptActiveRun();

          // The transcript and the work plan are the fold's: the TUI
          // subscribes the run's aggregate and renders `transcript.rows`, and
          // an open `/plan` reader reads the same `RunView`.
          focusRun(resumed);
        });

        runtime.runFork(
          Effect.gen(function* () {
            const result = yield* agentRuns.resume(id, {
              session: runtimeSession,
              onResumeResolved: adoptResumedRun,
              isCancellationRequested: () => session.stopRequested,
            });
            if ('started' in result) {
              // A resume of an owned child continues its parent: the edit
              // was asked of the child, never of the parent.
              if (edit !== undefined && session.runId !== id) {
                appendLocalErrorTranscript(
                  `Task ${id} is an agent of task ${session.runId}, which was resumed instead; it was not reset.`,
                );
              } else if (edit !== undefined) {
                const refused = yield* request({
                  kind: 'run.reset',
                  runId: id,
                  handoff: edit.handoff,
                });
                if (refused !== undefined) appendLocalErrorTranscript(refused);
              }
              yield* settleResumedTurn(result);
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
                restoreSuperseded();
                session.markRunCompleted();
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

  /** Settle a resumed turn. A root acknowledges at idle, so its `completion`
   *  holds this chain, and the root-run slot it settles, until the run ends.
   *  A subagent back at WAITING is a completed turn. */
  const settleResumedTurn = Effect.fn('settleResumedTurn')(function* (result: {
    readonly outcome?: TurnOutcome;
    readonly completion?: Effect.Effect<TurnOutcome, Error>;
  }) {
    const outcome =
      (result.completion ? yield* result.completion : result.outcome) ??
      RUN_OUTCOME.COMPLETED;
    session.runExitCode = runOutcomeExitCode(outcome);
  });

  /** Hold the root-run slot while a message continues the stopped
   *  conversation `runId`, once the slot is free. */
  const claimPreparingRoot = (runId: RunId): PreparingRoot | undefined => {
    const slot = Deferred.makeUnsafe<void, Error>();
    if (!session.tryClaimRootRunSlot(Deferred.await(slot))) return undefined;
    session.runId = runId;
    preparingRoot = { runId, slot, stopped: false };
    return preparingRoot;
  };

  /** Give back the slot a continuation held, unless its run took it over. */
  const releasePreparingRoot = (preparing: PreparingRoot | undefined): void => {
    if (preparing === undefined || preparingRoot !== preparing) return;
    preparingRoot = undefined;
    session.markRunCompleted();
    Deferred.doneUnsafe(preparing.slot, Effect.void);
  };

  /** Adopt a resumed run's configuration and helper model. */
  const adoptRunRecord = (runId: RunId) =>
    Effect.gen(function* () {
      const config = yield* agentRuns
        .records(runtimeSession, runId)
        .readConfig();
      if (!config) return;
      yield* adoptRunConfig(config, 'history');
      yield* setCliHelperModel(stores.globalState, config.model);
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `Resumed run ${runId}: its configuration could not be adopted: ${toErrorMessage(error)}`,
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
   * stale terminal row is adopted.
   */
  const adoptResumedRoot = (run: RunView): void => {
    const adopted = Deferred.makeUnsafe<void, Error>();
    // A continuation preparing this run hands its slot to the run, and a
    // stop the user asked of it meanwhile lands on the run.
    const preparing =
      preparingRoot?.runId === run.id ? preparingRoot : undefined;
    releasePreparingRoot(preparing);
    if (!session.tryClaimRootRunSlot(Deferred.await(adopted))) return;
    session.runId = run.id;
    if (session.interruptedRunId === run.id)
      session.interruptedRunId = undefined;
    rootRunId.set(run.id);
    focusRun(run.id);
    if (preparing?.stopped) {
      session.stopRequested = true;
      interruptActiveRun();
    }
    runtime.runFork(
      Effect.gen(function* () {
        yield* adoptRunRecord(run.id);
        yield* runtimeSession.runs.awaitDrained(run.id);
        const status = runtimeSession.runView(run.id)?.status;
        session.runExitCode = isTerminalOutcomePhase(status)
          ? runOutcomeExitCode(status)
          : CliExitCode.Success;
      }).pipe(
        Effect.ensuring(Effect.sync(() => session.markRunCompleted())),
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
          .filter((run) => isLiveRun(run) && runtimeSession.runs.isLive(run.id))
          .map((run) => run.id),
      );
      for (const id of liveHere) {
        const run = view.runs.get(id);
        if (!previous.has(id) && run?.parentId === null) adoptResumedRoot(run);
      }
    });
  // A chat of the service adopts only the runs it launches or resumes: the
  // service's view also holds other terminals' conversations.
  if (init.backend === undefined) {
    const resumedRoots = runtime.runFork(
      Stream.runForEach(runtimeSession.viewChanges, observeResumedRoots),
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
    if (reason === 'shutdown' && init.backend !== undefined) return;
    requestStop(reason);
    interruptActiveRun();
  };

  const startSession = (
    instruction: string,
    mediaFiles?: readonly string[],
    displayInstruction?: string,
  ): Effect.Effect<boolean, Error, ProcessServices> =>
    Effect.suspend(() => {
      followUpQueue.clear();
      let started = false;
      // The slot is claimed before the program runs, the way every other launch
      // path claims it: `startRootRun` below re-claims it for the run it mints,
      // and a refusal on the way there settles this deferred instead.
      const startSettled = Deferred.makeUnsafe<void, Error>();
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
          yield* setCliHelperModel(stores.globalState, selection.model);
          if (session.stopRequested) {
            session.markRunCompleted();
            return;
          }
          startRootRun({
            agent: meta.agent || initialAgent,
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
          });
          started = true;
        }),
        (error) => {
          if (!session.stopRequested) {
            appendLocalUserTranscript(displayInstruction ?? instruction);
          }
          reportRunFailure(error);
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
    const stream = runViewOf(currentView(), selectedRunIdSignal.get());
    if (!stream || stream.parentId === null) return { kind: 'none' };
    return {
      kind: acceptsFollowUp(stream, CLI_FOLLOW_UP_HOST) ? 'accept' : 'reject',
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
      appendLocalNotice(
        FOCUSED_AGENT.selectedNoLongerAccepting,
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
    // A message to the conversation the user stopped continues it: the
    // session queues it on that run and resumes the run.
    const interrupted = childFollowUpTarget
      ? undefined
      : session.interruptedRunId;
    if (
      !childFollowUpTarget &&
      !interrupted &&
      chatTuiCanStartRootRun(session)
    ) {
      const started = yield* startSession(
        prepared.instruction,
        mediaFiles,
        prepared.displayInstruction,
      );
      if (!started) restoreReservedSkillActivations();
      return;
    }
    let delivered = false;
    let preparing: PreparingRoot | undefined;
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
      const continuing =
        interrupted !== undefined && session.interruptedRunId === interrupted;
      if (continuing) {
        // The stopped generation leaves the session before the message
        // continues the run, and the chat holds the slot while it resumes.
        yield* Effect.ignoreCause(session.runSettled ?? Effect.void);
        yield* runtimeSession.runs.awaitDrained(interrupted);
        if (session.interruptedRunId === interrupted)
          preparing = claimPreparingRoot(interrupted);
      }
      // The fold states when the pending run exists: the first view level
      // holding the run this controller minted, unless the run settles
      // first. Both are read when the delivery starts, not when it queued.
      const runSettled = session.runSettled;
      const followUpTarget = continuing
        ? preparing?.runId
        : (childFollowUpTarget ??
          (yield* Effect.raceFirst(
            awaitRunFolded(session.runId),
            runSettled === undefined
              ? Effect.succeed(undefined)
              : // Settled is settled: a run that failed or was interrupted
                // wins this race with `undefined` so the draft is restored.
                runSettled.pipe(Effect.exit, Effect.as(undefined)),
          )));
      // Hand the message back to the input, naming why when there is a reason.
      const restoreDraft = (reason?: string): void => {
        requestDraftRestore(line, images);
        if (reason !== undefined) {
          setTransientNotice(
            `${reason} The message has been restored to the input.`,
            { ttlMs: Infinity },
          );
        }
      };
      if (session.stopRequested) {
        restoreDraft();
        return;
      }
      if (!followUpTarget) {
        restoreDraft(
          'The conversation ended before the message could be sent.',
        );
        return;
      }
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const outcome = yield* requests
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
                  kind: 'refused' as const,
                  reason: describeRequestError(error),
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
          if (outcome.kind === 'sent') {
            delivered = true;
            // The session took the message and resumed the run: it is no
            // longer the stopped conversation, and the next message goes to
            // it live rather than waiting for it to drain.
            if (
              continuing &&
              outcome.value.wake == null &&
              session.interruptedRunId === interrupted
            )
              session.interruptedRunId = undefined;
            const presentation = presentFollowUpResult(
              outcome.value.status === 'sent'
                ? { status: 'sent' }
                : { status: 'queued', wake: outcome.value.wake ?? undefined },
            );
            if (presentation.severity !== 'none') {
              appendLocalNotice(presentation.message, followUpTarget);
            }
            return;
          }
          // Teardown mid-send is not a verdict on the message, and a defect is
          // no refusal (the run may be healthy): both hand the message back
          // without stopping the stream or retargeting the conversation.
          restoreDraft(
            outcome.kind === 'interrupted' ? undefined : outcome.reason,
          );
          if (outcome.kind !== 'refused') return;
          if (followUpTarget === session.runId) {
            session.stopRequested = true;
          } else {
            appendLocalNotice(
              FOCUSED_AGENT.selectedNoLongerAccepting,
              followUpTarget,
            );
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
            releasePreparingRoot(preparing);
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
    activateSkill,
    clearPendingSkills: () => {
      pendingSkillActivationClearEpoch += 1;
      pendingSkillActivations.clear();
    },
  };
}
