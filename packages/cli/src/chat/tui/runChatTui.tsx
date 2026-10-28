// `texra chat` entry point, single Ink-based session. The Ink TUI runs for
// every interactive `texra chat` invocation, and non-TTY callers are pointed
// at `texra run` (which is what they actually want for piping/scripting).
//
// Run start/resume/stop orchestration lives in ../chatSessionController;
// this module keeps only composition, rendering glue, and the Ink lifecycle.

import {
  Cause,
  Effect,
  Exit,
  FiberHandle,
  Result,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import { render, type Instance as InkInstance } from 'ink';

import {
  AgentCatalog,
  SESSION_CLOSE_DEADLINE_MS,
} from '@texra-ai/harness/host';
import {
  type RuntimeRequest,
  qualifyAggregateId,
  type RunId,
  type AgentConfig,
  RUN_PHASE,
  isLiveRun,
  type ApprovalPolicy,
  isActivePhase,
  isTranscriptSettlementPhase,
  toErrorMessage,
} from '@texra-ai/harness/schemas';
import { FileSecrets, secretsDirectory } from '@texra-ai/harness/node';
import { emitAppSignal } from '@texra-ai/harness/host';
import {
  CliUsageError,
  effectiveApprovalPolicy,
  launchApprovalNotice,
  projectApprovalPolicy,
  type CliContext,
} from '@cli/runtime/cliContext';
import {
  linkCliService,
  reachCliService,
  serviceKeysNotice,
} from '@cli/runtime/cliService';

import { firstRunSetupAgentOverride } from '@cli/onboarding/setupContinuation';
import { resolveChatDefaults } from '@cli/runtime/chatDefaults';
import type { CliProcessRuntime } from '@cli/runtime/cliProcessRuntime';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { initCliPlatform, setCliHelperModel } from '@cli/runtime/initPlatform';
import {
  formatCliNoAvailableModelsRecovery,
  selectCliRunnableModel,
  type CliNoAvailableModelsRecoveryOptions,
} from '@cli/runtime/modelAccess';
import { writeTextStderr } from '@cli/runtime/logSinks';
import { readCliTeamName } from '@cli/runtime/cliTeams';
import { tuiOutputStreamForColor } from '@cli/tui/noColorOutput';
import {
  acquireTuiTerminal,
  clearTerminalScrollback,
} from '@cli/tui/terminalCleanup';
import { getFirstRunDone } from '@texra/controllers/onboarding/onboardingFunnel';
import { subscribeToSignalChanges } from '@texra/shared/signals';
import { serviceSession } from '@texra/controllers/server/serviceSession';
import { documentTaskOf } from '@texra/tools/documents/documentTask';
import { formatApprovalPolicy } from '@ui/copy/approvalPolicy';
import { sessionStoreMovedAsideMessage } from '@ui/copy/sessionStore';

import {
  createChatSessionController,
  type ChatSessionController,
} from '../chatSessionController';
import { App } from './App';
import {
  applyCliModelSelection,
  applyCliTeamSelection,
  applyInitialCliAgentSelection,
  resolveChatToolUseAgent,
} from './commands/handlers/agentModelCommands';
import { applyCliModelAccessSelection } from './commands/handlers/modelAccessCommands';
import { showCliMemoryPreview } from './commands/handlers/memoryCommands';
import { loginFromChat } from './commands/handlers/loginCommands';
import { type SlashCommandContext } from './commands/handlers/slashContext';
import { registerBuiltinSlashCommands } from './commands/registerBuiltins';
import { loadInputHistory } from './history/inputHistory';
import { notify } from './notifications/terminalNotifier';
import { announceForegroundApprovals } from './state/subscribeApprovals';
import { followCliCredentialChanges } from './hosts/cliProviderKeys';
import { createTuiViewportController } from './render/tuiViewportController';
import {
  rootRunId,
  selectedRunId as selectedRunIdSignal,
  resetCliState,
  patchSessionMeta,
  sessionViewFailure as sessionViewFailureSignal,
  sessionMeta as sessionMetaSignal,
  setTransientNotice,
} from './state/cliState';
import {
  bindSessionView,
  currentView,
  sessionView,
  runPhaseOf,
  runViewOf,
} from './state/sessionView';
import { notifyStaticTranscriptErased } from './state/staticTranscriptRepaint';
import { discoverTerminalCapabilities } from './state/terminalCapabilities';
import {
  appendLocalErrorTranscript,
  appendLocalNotice,
  appendLocalRequestRefusal,
  paintedRunIds,
} from './state/transcript';
import { openCliSlashCommandForm } from './commands/slashForms';
import {
  checkModelConnection,
  connectChatModel,
  holdUntilConnected,
  modelConnectionNeeded,
} from './modelConnection';
import { installTerminalTitleUpdates } from './terminalTitle';
import {
  chatTuiCanStartRootRun,
  chatTuiRunPending,
  TuiSession,
} from './state/sessionRunState';
import { createSessionExitController } from './sessionExitController';

interface ChatResult {
  exitCode: number;
}

/** A change of a run's approval grants (`policy.set`). */
type PolicyChange = Extract<RuntimeRequest, { kind: 'policy.set' }>['change'];

export interface RunChatInit {
  /** `--agent` override from the CLI; falls through `resolveChatDefaults`. */
  readonly agentOverride?: string;
  /** `--model` override from the CLI; falls through `resolveChatDefaults`. */
  readonly modelOverride?: string;
  /**
   * Startup resume from `texra resume <id>`, with the run's persisted config.
   * A resumed team run carries its team identity and delegation
   * scope in that config; those are the only fields below still sourced here,
   * because a team run is started headlessly by `texra team run`.
   */
  readonly initialResume?: {
    readonly id: RunId;
    readonly config: AgentConfig;
  };
}

const CHAT_STARTUP_MODEL_RECOVERY = {
  configureKeyAction: 'add a provider API key with `texra setup`',
} satisfies CliNoAvailableModelsRecoveryOptions;

/** `runtime` is the one the command entry installed and ran its program on;
 *  platform signals hand off before Ink mounts. */
export async function runChat(
  runtime: CliProcessRuntime,
  context: CliContext,
  init: RunChatInit,
): Promise<ChatResult> {
  const initialResume = init.initialResume;
  // The chat's hold on the background service, for its whole life.
  const chatScope = Scope.makeUnsafe();
  // One startup program; an early exit is its `exitCode` arm.
  const startup = await runtime.runPromise(
    Effect.gen(function* () {
      // Every chat is a client of the one service, so other terminals and
      // windows see its task; one that cannot reach it runs here, and says
      // so once.
      const service = yield* linkCliService(context.storageRoot).pipe(
        Scope.provide(chatScope),
        Effect.result,
      );
      const services = yield* initCliPlatform({
        ...context,
        presentsStoreMovedAside: true,
        // The service follows interrupted tasks for a chat that is its
        // client. In this process, `texra resume <id>` resumes the task it
        // names; a second resume of the interrupted ones beside it would
        // race that one, so it only retries a blocked resume.
        ...(Result.isFailure(service) && {
          interruptedTasks: initialResume === undefined ? 'offer' : 'retry',
        }),
      });
      const runtimeSession = yield* services.session;
      // Where this chat's runs run: the service's session, or this one.
      const runSession = Result.isSuccess(service)
        ? yield* serviceSession(
            service.success,
            context.cwd,
            runtimeSession.roots,
          ).pipe(Scope.provide(chatScope))
        : runtimeSession;
      // Said once the view is bound, which the transcript rows need.
      const startupNotices: string[] = [];
      // This chat's requests are decided under the project's persisted
      // policy, here or in the service; what this invocation asked for rides
      // each launch (`launchApproval`).
      const refused = launchApprovalNotice(
        context.requestedApprovalPolicy,
        projectApprovalPolicy(runtimeSession.roots.config),
      );
      if (refused !== undefined) startupNotices.push(refused);
      // A store this process moved aside at open is said in the transcript,
      // not on stderr before Ink mounts, where it would sit above the header.
      if (runtimeSession.storeMovedAside)
        startupNotices.push(
          sessionStoreMovedAsideMessage(runtimeSession.storeMovedAside),
        );
      if (Result.isFailure(service)) {
        startupNotices.push(
          `This chat runs here only, so other terminals and windows will not see it: ${service.failure.message}`,
        );
      }
      // Without a usable credential the chat still opens: the "Connect a
      // model" panel takes the first foreground slot, and model resolution
      // waits for the connection instead of ending the process.
      const credential = yield* checkModelConnection(services);
      if (credential.notice) startupNotices.push(credential.notice);
      const explicitAgent = initialResume?.config.agent ?? init.agentOverride;
      // The setup-agent handoff belongs to the moment a first credential
      // lands, which is after startup when the chat opened without one.
      const firstRunSetupAgent = firstRunSetupAgentOverride({
        onboardingConfigured: true,
        firstRunDone: yield* getFirstRunDone(services.globalState),
        pinnedAgent: explicitAgent ?? context.envAgent,
      });
      const defaults = resolveChatDefaults({
        stores: services,
        agentOverride: explicitAgent,
        modelOverride: initialResume?.config.model ?? init.modelOverride,
        envAgent: context.envAgent,
        envModel: context.envModel,
        // The implicit chat default is a persona with no document task.
        visibleToolUseAgents: (yield* (yield* AgentCatalog).visible(
          services,
        )).filter((agent) => documentTaskOf(agent) === null),
      });
      const agentEntry = yield* resolveChatToolUseAgent(
        services,
        defaults.agent,
      );
      if (agentEntry instanceof CliUsageError) {
        writeTextStderr(agentEntry.message);
        return { exitCode: CliExitCode.Usage };
      }
      // One API mode for the whole session: an explicit --api-mode/env
      // override wins, otherwise the persisted account default. Model
      // resolution, the no-models hints, and the header/status all read this
      // same value so they can never disagree.
      const modelSelectionExit = yield* Effect.exit(
        credential.ready
          ? selectCliRunnableModel(
              [{ model: defaults.model, reason: defaults.modelSource }],
              {
                stores: services,
                noAvailableModelsMessage: formatCliNoAvailableModelsRecovery(
                  CHAT_STARTUP_MODEL_RECOVERY,
                ),
              },
            ).pipe(
              Effect.tap((selection) =>
                setCliHelperModel(services.globalState, selection.model),
              ),
            )
          : Effect.succeed({ model: defaults.model, notice: undefined }),
      );
      if (Exit.isFailure(modelSelectionExit)) {
        writeTextStderr(toErrorMessage(Cause.squash(modelSelectionExit.cause)));
        return { exitCode: CliExitCode.Usage };
      }
      const modelSelection = modelSelectionExit.value;
      // Both persisted team fields are optional and nullable on the wire, so a
      // resumed run that never carried a preset lands `null` where
      // `SessionMeta` wants absent.
      const initialPresetId = initialResume?.config.cli?.teamId ?? undefined;
      sessionMetaSignal.set({
        agent: defaults.agent,
        agentSource: agentEntry.source,
        model: modelSelection.model,
        modelSource: defaults.modelSource,
        cwd: context.cwd,
        approvalPolicy: effectiveApprovalPolicy(
          context.requestedApprovalPolicy,
          projectApprovalPolicy(runtimeSession.roots.config),
        ),
        teamName: yield* readCliTeamName(
          runtimeSession.roots.repoState,
          initialPresetId,
        ),
        cliTeamId: initialPresetId,
        delegationAgentScope:
          initialResume?.config.delegationAgentScope ?? undefined,
        version: context.version,
      });
      if (modelSelection.notice) startupNotices.push(modelSelection.notice);
      const { history: inputHistory, readFailure } = yield* loadInputHistory;
      if (readFailure !== null)
        startupNotices.push(
          `Input history could not be read (${toErrorMessage(readFailure)}); ↑/↓ and Ctrl-R start from this session's entries.`,
        );
      // DA1 sentinel discovery runs *before* Ink mounts so it owns the
      // raw-mode toggle exclusively, interleaving with Ink's own raw-mode
      // lifecycle (set when `useInput` mounts) caused capability discovery to
      // flip raw mode off ~250ms in, breaking input. Capability-gated
      // notifications fall back to BEL during this window (~250ms typical,
      // hard 250ms cap on no DA1 reply).
      const terminalCaps = yield* discoverTerminalCapabilities({
        stdin: process.stdin,
        stdout: process.stdout,
      });
      return {
        startupNotices,
        services,
        runtimeSession,
        runSession,
        link: Result.isSuccess(service) ? service.success : undefined,
        runsElsewhere: Result.isSuccess(service),
        defaults,
        firstRunSetupAgent,
        inputHistory,
        terminalCaps,
      };
    }).pipe(
      // A chat that ends at startup lets go of the service there.
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) && exit.value.exitCode === undefined
          ? Effect.void
          : Scope.close(chatScope, Exit.void),
      ),
    ),
  );
  if (startup.exitCode !== undefined) return { exitCode: startup.exitCode };
  const { services, runtimeSession, runSession, runsElsewhere, link } = startup;
  const { defaults } = startup;
  const { inputHistory, startupNotices, terminalCaps } = startup;

  // The policy this chat's launches ask for (`launchApproval`): its flag,
  // then each `/approval`.
  let chatPolicy = context.requestedApprovalPolicy;
  const getApprovalPolicy = (): ApprovalPolicy =>
    effectiveApprovalPolicy(
      chatPolicy,
      projectApprovalPolicy(runtimeSession.roots.config),
    );
  // `/approval` sets this chat's launch policy only, here or in the
  // service; the project's policy changes through `/config` or the settings
  // view. The chat's latest run takes the change on its own `approval.policy`
  // row (the card's request): Auto-approve turns its bypasses on; leaving
  // Auto-approve turns them off, so the next round inherits them cleared;
  // a stricter policy lowers a live run's limit at once, even below the
  // project's.
  const setApprovalPolicy = (policy: ApprovalPolicy): Effect.Effect<void> => {
    // What the chat asked for, not the effective policy: a yolo under a
    // Block project left a grant that a later Ask project would honour.
    const leaving = chatPolicy === 'yolo' && policy !== 'yolo';
    chatPolicy = policy;
    patchSessionMeta({ approvalPolicy: getApprovalPolicy() });
    const run = runViewOf(currentView(), session.runId ?? rootRunId.get());
    if (run === undefined) return Effect.void;
    const bypass = (enabled: boolean): PolicyChange => ({
      field: 'bypass',
      runId: run.id,
      bypass: 'superYolo',
      enabled,
    });
    const live = isLiveRun(run);
    const changes: PolicyChange[] = [
      ...(policy === 'yolo' && run.actions.includes('grant')
        ? [bypass(true)]
        : []),
      ...(leaving ? [bypass(false)] : []),
      ...(policy !== 'yolo' && live
        ? [{ field: 'limit' as const, runId: run.id, limit: policy }]
        : []),
    ];
    // Durable before the selection settles, so nothing the chat sends next
    // runs under, or inherits, the grant just left.
    return Effect.forEach(
      changes,
      (change) =>
        runSession
          .request({ kind: 'policy.set', change })
          .pipe(
            Effect.catch((error) =>
              Effect.sync(() => appendLocalRequestRefusal(error, run.id)),
            ),
          ),
      { discard: true },
    );
  };
  // The slash-command context is identical at every call site; build it once
  // lazily so the closures it captures (resetSessionForClear,
  // chatController.resume) are all defined before the first use.
  const slashCommandContext = (): SlashCommandContext => ({
    cliContext: context,
    session,
    runtimeSession,
    runSession,
    secrets: services.secrets,
    stores: services,
    runtime: services.runtime,
    processCwd: process.cwd(),
    requestInputExit: exitController.requestInputExit,
    getApprovalPolicy,
    setApprovalPolicy,
    resetSession: resetSessionForClear,
    resumeRun: chatController.resume,
  });

  // From here on `chatScope` owns everything the session holds: what is
  // added below closes before the service hold above, last in first out,
  // and the exit drain awaits that close.
  const onChatClose = (release: () => void): void =>
    runtime.runSync(Scope.addFinalizer(chatScope, Effect.sync(release)));
  // The one session state the TUI renders (PRD 10.1): the session's fold
  // bridged into a signal, its transcript tier subscribed for the runs this
  // terminal paints. Bound before anything reads the view: the terminal
  // title below derives its attention state from it on install.
  const session = new TuiSession(runsElsewhere);
  // A dead fold (`view.changes` failing) is the end of this session: the
  // composer closes on the reason, Ctrl-C still exits, and the exit is a
  // failure on every exit path, since they all read `session.runExitCode`.
  const unbindSessionView = bindSessionView(runtime, runSession.view, {
    onFailure: (error) => {
      sessionViewFailureSignal.set(
        `The session view stopped updating: ${toErrorMessage(error)} Press Ctrl-C to exit and restart texra. If it repeats, run the same texra version that last opened this project; an older build cannot read a newer session store.`,
      );
      session.runExitCode = CliExitCode.AgentError;
    },
  });
  for (const notice of startupNotices) appendLocalNotice(notice);
  if (link !== undefined)
    runtime.runSync(
      Effect.gen(function* () {
        // Said when the login shell has answered, without holding the chat.
        yield* serviceKeysNotice().pipe(
          Effect.tap((keys) =>
            Effect.sync(() => keys !== null && appendLocalNotice(keys)),
          ),
          Effect.forkIn(chatScope),
        );
        // The service went away (retired by a newer build, or it died) and
        // the link reaches it again: the chat says so, rather than going
        // quiet.
        yield* Stream.runForEach(
          SubscriptionRef.changes(link.client).pipe(Stream.drop(1)),
          (client) =>
            Effect.sync(() =>
              appendLocalNotice(
                client === null
                  ? 'The TeXRA service is offline; TeXRA is reconnecting. If another window runs a newer TeXRA, update this one.'
                  : 'Reconnected to the TeXRA service.',
              ),
            ),
        ).pipe(Effect.forkIn(chatScope));
      }),
    );
  // Cosmetic, but "texra-local" or a bare shell prompt in every tab makes a
  // multi-session workflow hard to navigate: show project and attention state.
  // The terminal outlives session subscriptions: only the exit controller
  // releases it, and its `exit` hook covers every other death.
  const terminal = acquireTuiTerminal({
    kittyKeyboard: terminalCaps.kittyKeyboard,
    title: installTerminalTitleUpdates(context.cwd),
  });
  onChatClose(announceForegroundApprovals());
  runtime.runSync(
    Effect.gen(function* () {
      yield* Effect.forkIn(followCliCredentialChanges, chatScope);
      // Keys another TeXRA window or the service saves reach this chat too.
      yield* Effect.forkIn(
        FileSecrets.watch(secretsDirectory(context.storageRoot), (key) =>
          emitAppSignal('credentialChanged', { key }),
        ),
        chatScope,
      );
    }),
  );
  // The runs this terminal paints, watched on the session for as long as
  // the set holds: the watch keeps their transcripts in the view, and a
  // new set replaces the watch. The chat's scope ends it.
  const transcriptWatch = runtime.runSync(
    FiberHandle.make<void, never>().pipe(Scope.provide(chatScope)),
  );
  let subscribedRuns = '';
  const syncTranscriptSubscriptions = (): void => {
    const ids = paintedRunIds.get();
    const key = ids.join('\0');
    if (key === subscribedRuns) return;
    subscribedRuns = key;
    const view = runSession.view.current();
    runtime.runFork(
      FiberHandle.run(
        transcriptWatch,
        Stream.runDrain(
          runSession.view.watch(
            ids.map((id) => ({
              id: qualifyAggregateId('run', id),
              fromSeq: 0,
            })),
            { cursor: view.cursor, debug: view.debug },
          ),
        ),
      ),
    );
  };
  onChatClose(
    subscribeToSignalChanges([paintedRunIds], syncTranscriptSubscriptions),
  );
  syncTranscriptSubscriptions();

  const getModelSwitchDisabledReason = (
    candidateModel: string,
  ): Effect.Effect<string | undefined, Error> => {
    if (chatTuiCanStartRootRun(session) || !session.canSelectModel()) {
      return Effect.succeed(undefined);
    }
    // The run's loop answers in this process; the service checks the
    // switch against the run when it is asked.
    const { runId } = session;
    const held =
      runId === undefined || runsElsewhere
        ? undefined
        : runtimeSession.held(runId);
    return (
      held?.modelSwitchDisabledReason(candidateModel) ??
      Effect.succeed(undefined)
    );
  };
  // Chat-session controller: owns run start/resume/stop orchestration.
  // The Ink layer never directly mutates session run-state fields, every
  // state transition flows through one of the controller's narrow commands.
  const chatController: ChatSessionController = createChatSessionController({
    session,
    runSession,
    served: runsElsewhere,
    records: runtimeSession.records,
    sessionContext: { ...context, quietLogs: true },
    chatScope,
    shutdownScope: services.shutdownScope,
    cwd: context.cwd,
    getSlashCommandContext: slashCommandContext,
    secrets: services.secrets,
    stores: services,
    runtime,
    approvalPolicy: () => chatPolicy,
  });

  const resetSessionForClear = (): boolean => {
    const currentRunId = session.runId ?? selectedRunIdSignal.get();
    const activeStatus = runPhaseOf(runViewOf(currentView(), currentRunId));
    const isRunPending = chatTuiRunPending(session);

    if (
      (isRunPending && activeStatus !== RUN_PHASE.WAITING) ||
      isActivePhase(activeStatus)
    ) {
      setTransientNotice(
        'Wait for the active response to finish, or press Ctrl-C first.',
      );
      return false;
    }

    const meta = sessionMetaSignal.get();
    if (isRunPending) chatController.stop('user');
    chatController.clearPendingSkills();
    session.clearRunState();
    resetCliState(meta);
    clearTerminalScrollback();
    // The erase above happened outside Ink, so everything the static
    // transcript printed is gone from the terminal, even when the state
    // rebuild is a no-op (empty history) that would skip the repaint-epoch
    // bump. The erase epoch forces a rebuild after the reset state commits,
    // so the remounted `<Static>` repaints the header without ever carrying
    // the cleared rows.
    notifyStaticTranscriptErased();
    return true;
  };

  // Pre-register the slash commands the input palette uses.
  registerBuiltinSlashCommands({
    runSession,
    connectService: () => reachCliService(context.storageRoot),
    onAccountChanged: () =>
      connectChatModel(
        slashCommandContext(),
        {
          modelSource: defaults.modelSource,
          recovery: CHAT_STARTUP_MODEL_RECOVERY,
          firstRunSetupAgent: startup.firstRunSetupAgent,
        },
        (held) => chatController.submit(held.line, held),
      ),
    secrets: services.secrets,
    stores: services,
    runtime,
    runtimeSession,
    canSelectAgent: () => chatTuiCanStartRootRun(session),
    onAgentSelect: (nextAgent) =>
      applyInitialCliAgentSelection(nextAgent, slashCommandContext()),
    onTeamSelect: (teamId) =>
      applyCliTeamSelection(teamId, slashCommandContext()),
    getApprovalPolicy,
    onApprovalPolicySelect: (policy) =>
      setApprovalPolicy(policy).pipe(
        Effect.andThen(
          Effect.sync(() =>
            appendLocalNotice(`Approval mode: ${formatApprovalPolicy(policy)}`),
          ),
        ),
      ),
    onProjectApprovalPolicyChanged: (policy) => {
      patchSessionMeta({
        approvalPolicy: effectiveApprovalPolicy(chatPolicy, policy),
      });
      appendLocalNotice(
        `Project approval policy: ${formatApprovalPolicy(policy)}`,
      );
    },
    canSelectModel: () => session.canSelectModel(),
    getModelSwitchDisabledReason,
    onModelSelect: (nextModel) =>
      applyCliModelSelection(nextModel, slashCommandContext()),
    onModelAccessSelect: (route, output) =>
      applyCliModelAccessSelection(
        services,
        route,
        slashCommandContext(),
        output,
      ),
    // `/key` and sign-out use the registry's own handlers. Only `/login`
    // needs an override, to carry this session's CliContext.
    onLoginSelect: (value, output) =>
      loginFromChat(value, services, context, output),
    onMemorySelect: (storagePath) =>
      showCliMemoryPreview(runtimeSession.roots, storagePath),
    onSkillSelect: (selection) =>
      Effect.sync(() => chatController.activateSkill(selection)),
    onResumeSelect: chatController.resume,
    configRoots: runtimeSession.roots,
    onError: (error) => {
      appendLocalErrorTranscript(toErrorMessage(error));
    },
  });

  const stdoutColorEnabled = context.stdoutColorEnabled;
  const inkRef: { current?: InkInstance } = {};
  const viewportController = createTuiViewportController(inkRef);
  const ink = render(
    <App
      secrets={services.secrets}
      stores={services}
      runtime={runtime}
      session={runSession}
      onSubmit={(line, mediaFiles, images, holdUntil) => {
        if (holdUntilConnected({ line, mediaFiles, images })) return;
        runtime.runFork(
          chatController.submit(line, { mediaFiles, images, holdUntil }),
        );
      }}
      commandName={context.commandName}
      onStaticTranscriptChange={viewportController.repaintTranscript}
      onCtrlC={() => exitController.handleSigint()}
      onSuspend={() => exitController.handleSigtstp()}
      history={inputHistory}
    />,
    {
      stdout: tuiOutputStreamForColor(process.stdout, stdoutColorEnabled),
      stderr: process.stderr,
      stdin: process.stdin,
      // Own Ctrl+C ourselves (App's unified useInput → exit()) instead of via
      // Ink's built-in handler. Ink's exitOnCtrlC only matches the raw \x03,
      // which never arrives under the Kitty protocol (Ctrl+C becomes ESC[99;5u);
      // worse, while it's enabled Ink's useInput *filters out* Ctrl+C before any
      // handler runs (build/hooks/use-input.js). Disabling it lets the parsed
      // ctrl+c key reach our handler uniformly on every terminal.
      exitOnCtrlC: false,
      // Enable the Kitty keyboard protocol (disambiguate flag only) when the
      // terminal supports it, already confirmed by discoverTerminalCapabilities
      // above, so use 'enabled' to skip Ink's redundant detection query. This
      // is what lets Ink distinguish Shift+Enter (newline) from Enter (submit);
      // plain Enter stays a legacy `\r`, and Ink pops the protocol on unmount.
      kittyKeyboard: {
        mode: terminalCaps.kittyKeyboard ? 'enabled' : 'disabled',
        // Pin the flags rather than relying on Ink's default: the SIGCONT
        // re-push in terminalCleanup re-arms exactly this set, so the two
        // must not drift apart.
        flags: ['disambiguateEscapeCodes'],
      },
    },
  );
  inkRef.current = ink;
  // No model yet: the "Connect a model" panel is the first thing on screen.
  if (modelConnectionNeeded.get()) openCliSlashCommandForm('login');

  const exitController = createSessionExitController({
    ink,
    session,
    commandName: context.commandName,
    cwd: context.cwd,
    chatScope,
    terminal,
    runtime,
    submitted: chatController.submitted,
    getApprovalPolicy,
    // What the session's publisher still holds, drained before shutdown
    // within the close budget; one that does not drain is said on stderr.
    flushArtifacts: runtimeSession.settled.pipe(
      Effect.timeout(SESSION_CLOSE_DEADLINE_MS),
      Effect.mapError(
        () =>
          new Error(
            `the session's rows did not settle within ${SESSION_CLOSE_DEADLINE_MS} ms`,
          ),
      ),
    ),
    repaintAfterTerminalResume: viewportController.repaintAfterTerminalResume,
    interruptActive: (reason) => chatController.stop(reason),
    quiet: context.quietLogs,
  });
  // Transfer signal ownership from the platform handler and arm this session's
  // handlers, not any earlier: everything above (the platform init,
  // onboarding, model resolution) ran with the platform's own handler still
  // live, so a signal during that window still got a graceful shutdown.
  exitController.install();

  // Interactive resume: kick off the continued tool-use run now that Ink is
  // mounted (so the rehydrated transcript + streamed continuation render) and
  // the signal handlers are armed. Fire-and-forget, the resume claims the
  // root-run slot, and the normal first-input path stays available so the
  // user can keep chatting (follow-ups target session.runId as usual).
  if (initialResume) {
    runtime.runFork(chatController.resume(initialResume.id));
  }

  // The one "agent finished" notification: the claimed run's turn settles,
  // at WAITING ("your turn", alongside the StatusBar pill) or at its outcome.
  // A run that ends after waiting was already announced, and a stop the user
  // asked for is not news.
  let rootPhase = session.status();
  onChatClose(
    subscribeToSignalChanges([sessionView()], () => {
      const previous = rootPhase;
      rootPhase = session.status();
      if (
        rootPhase !== previous &&
        previous !== RUN_PHASE.WAITING &&
        isTranscriptSettlementPhase(rootPhase) &&
        !session.stopRequested
      ) {
        notify('agentFinished');
      }
    }),
  );

  try {
    await ink.waitUntilExit();
  } finally {
    // The exit policy reads the view (a resumable idle root) after it has
    // released the store, so the bridge outlives the chat's scope. The
    // teardown settles only on the graceful path, whose drain closes that
    // scope first (a signal exit ends in process.exit and never returns
    // here), so nothing subscribed to the view outlives the bridge.
    await exitController.gracefulTeardown();
    unbindSessionView();
  }
  return { exitCode: session.runExitCode };
}
