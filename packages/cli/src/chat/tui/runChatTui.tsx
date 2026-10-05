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
  Fiber,
  Result,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import { render, type Instance as InkInstance } from 'ink';

import { aggregateId } from '@texra-ai/harness';
import type { AgentConfig } from '@agent/runtime';
import { getVisibleAgents } from '@agent/index';
import { CliUsageError, type CliContext } from '@cli/runtime/cliContext';
import { linkCliService, reachCliService } from '@cli/runtime/cliService';

import { firstRunSetupAgentOverride } from '@cli/onboarding/setupContinuation';
import { resolveChatDefaults } from '@cli/runtime/chatDefaults';
import { installCliProcessRuntime } from '@cli/runtime/cliProcessRuntime';
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
import { cliSecrets } from '@cli/runtime/cliSecrets';
import { nodeFileServices } from '@platform/defaults/jsonStore';
import {
  formatTexraApprovalPolicy,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import { RUN_PHASE } from '@shared/schemas';
import { getFirstRunDone } from '@shared/state/onboardingState';
import {
  isActivePhase,
  isTranscriptSettlementPhase,
} from '@shared/runs/runStatus';
import { DisposableStore } from '@texra/platform/disposable';
import { subscribeToSignalChanges } from '@texra/shared/signals';
import { attachWindowHost } from '@texra/controllers/server/windowHost';
import { serviceSessionBackend } from '@texra/controllers/server/serviceBackend';
import { localSessionBackend } from '@texra/controllers/session/sessionBackend';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { serviceAgentRuns } from '../serviceAgentRuns';

import {
  createChatSessionController,
  type ChatSessionController,
  type ResumeEdit,
} from '../chatSessionController';
import { makeFollowUpDeliveryQueue } from '../followUpDeliveryQueue';
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
import { subscribeCliCredentialChanges } from './hosts/cliProviderKeys';
import { createTuiViewportController } from './render/tuiViewportController';
import {
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
import type { RunId } from '@texra-ai/harness/schemas';

interface ChatResult {
  exitCode: number;
}

export interface RunChatInit {
  /** `--agent` override from the CLI; falls through `resolveChatDefaults`. */
  readonly agentOverride?: string;
  /** `--model` override from the CLI; falls through `resolveChatDefaults`. */
  readonly modelOverride?: string;
  /**
   * Display-only transcript notice shown at session start (never sent to the
   * model). Used for the first-run setup-agent handoff, to explain that
   * steering.
   */
  readonly startupNotice?: string;
  /**
   * Startup resume from `texra resume <id>`, with the run's persisted config.
   * A resumed team run carries its team identity and delegation
   * scope in that config; those are the only fields below still sourced here,
   * because a team run is started headlessly by `texra team run`.
   */
  readonly initialResume?: {
    readonly id: RunId;
    readonly config: AgentConfig;
    /** `--reset` or `--handoff`: applied once the run is resumed. */
    readonly edit?: ResumeEdit;
  };
}

const CHAT_STARTUP_MODEL_RECOVERY = {
  configureKeyAction: 'add a provider API key with `texra setup`',
} satisfies CliNoAvailableModelsRecoveryOptions;

export async function runChat(
  context: CliContext,
  init: RunChatInit,
): Promise<ChatResult> {
  // Platform signals hand off before Ink mounts; chat keeps the entry runtime.
  const runtime = installCliProcessRuntime(context.storageRoot, {
    resourcesPath: context.resourcesPath,
    minimumLogLevel: context.minimumLogLevel,
  });
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
      runtimeSession.setApprovalPolicy(context.approvalPolicy);
      const backend = Result.isSuccess(service)
        ? yield* serviceSessionBackend(
            service.success,
            context.cwd,
            runtimeSession.roots.storage,
          ).pipe(Scope.provide(chatScope))
        : localSessionBackend(runtimeSession);
      // Said once the view is bound, which the transcript rows need.
      const startupNotices: string[] = [];
      if (Result.isSuccess(service))
        yield* backend.setApprovalPolicy(context.approvalPolicy);
      else
        startupNotices.push(
          `This chat runs here only, so other terminals and windows will not see it: ${service.failure.message}`,
        );
      // Without a usable credential the chat still opens: the "Connect a
      // model" panel takes the first foreground slot, and model resolution
      // waits for the connection instead of ending the process.
      const hasCredential = yield* checkModelConnection(services);
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
        visibleToolUseAgents: (yield* getVisibleAgents(services)).filter(
          (agent) => agent.task === null,
        ),
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
        hasCredential
          ? selectCliRunnableModel(defaults.model, {
              stores: services,
              fallbackReason: defaults.modelSource,
              noAvailableModelsMessage: formatCliNoAvailableModelsRecovery(
                CHAT_STARTUP_MODEL_RECOVERY,
              ),
            }).pipe(
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
      // Both persisted team fields are `.nullish()` on the wire, so a resumed
      // run that never carried a preset lands `null` where `SessionMeta` wants
      // absent.
      const initialPresetId = initialResume?.config.cli?.teamId ?? undefined;
      sessionMetaSignal.set({
        agent: defaults.agent,
        agentSource: agentEntry.source,
        model: modelSelection.model,
        modelSource: defaults.modelSource,
        cwd: context.cwd,
        approvalPolicy: runtimeSession.approvalPolicy,
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
      // First-run handoff explanation: when the setup agent owns this session
      // (decided here for both the bare-`texra` and `texra chat` entries), say
      // so - display-only, so the agent waits for the user's first message.
      const startupNotice = init.startupNotice;
      if (startupNotice) startupNotices.push(startupNotice);
      return {
        startupNotices,
        services,
        runtimeSession,
        backend,
        link: Result.isSuccess(service) ? service.success : undefined,
        runsElsewhere: Result.isSuccess(service),
        defaults,
        firstRunSetupAgent,
        model: modelSelection.model,
        inputHistory: yield* loadInputHistory,
        // The drain lives as long as the process runtime; the graceful exit
        // waits on `idle` before that runtime is disposed.
        followUpQueue: yield* makeFollowUpDeliveryQueue(runtime.scope),
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
  const { services, runtimeSession, backend, runsElsewhere, link } = startup;
  const { defaults, model } = startup;
  const { inputHistory, followUpQueue, startupNotices } = startup;
  const { agent } = defaults;

  const getApprovalPolicy = (): TexraApprovalPolicy =>
    runtimeSession.approvalPolicy;
  const currentSessionContext = (): CliContext => ({
    ...context,
    quietLogs: true,
  });
  const setApprovalPolicy = (policy: TexraApprovalPolicy): void => {
    runtimeSession.setApprovalPolicy(policy);
    if (runsElsewhere) runtime.runFork(backend.setApprovalPolicy(policy));
    patchSessionMeta({ approvalPolicy: policy });
  };
  // The slash-command context is identical at every call site; build it once
  // lazily so the closures it captures (resetSessionForClear,
  // chatController.resume) are all defined before the first use.
  const slashCommandContext = (): SlashCommandContext => ({
    cliContext: context,
    session,
    runtimeSession,
    backend,
    secrets: services.secrets,
    stores: services,
    runtime: services.runtime,
    processCwd: process.cwd(),
    initialAgent: agent,
    initialModel: model,
    requestInputExit: exitController.requestInputExit,
    getApprovalPolicy,
    setApprovalPolicy,
    resetSession: resetSessionForClear,
    resumeRun: chatController.resume,
  });

  // DA1 sentinel discovery runs *before* Ink mounts so it owns the raw-mode
  // toggle exclusively, interleaving with Ink's own raw-mode lifecycle (set
  // when `useInput` mounts) caused capability discovery to flip raw mode off
  // ~250ms in, breaking input. Capability-gated notifications fall back to
  // BEL during this window (~250ms typical, hard 250ms cap on no DA1 reply).
  const terminalCaps = await discoverTerminalCapabilities({
    stdin: process.stdin,
    stdout: process.stdout,
  });

  const disposables = new DisposableStore();
  // The one session state the TUI renders (PRD 10.1): the session's fold
  // bridged into a signal, its transcript tier subscribed for the runs this
  // terminal paints. Bound before anything reads the view: the terminal
  // title below derives its attention state from it on install.
  const session = new TuiSession(backend.controls, runsElsewhere);
  disposables.add(() => runtime.runFork(Scope.close(chatScope, Exit.void)));
  // A dead fold (`viewChanges` failing) is the end of this session: the
  // composer closes on the reason, Ctrl-C still exits, and the exit is a
  // failure on every exit path, since they all read `session.runExitCode`.
  const unbindSessionView = bindSessionView(runtime, backend.view, {
    changes: backend.viewChanges,
    onFailure: (error) => {
      sessionViewFailureSignal.set(
        `The session view stopped updating: ${toErrorMessage(error)} Press Ctrl-C to exit and restart texra. If it repeats, run the same texra version that last opened this project; an older build cannot read a newer session store.`,
      );
      session.runExitCode = CliExitCode.AgentError;
    },
  });
  for (const notice of startupNotices) appendLocalNotice(notice);
  // The service went away (retired by a newer build, or it died) and the
  // link reaches it again: the chat says so, rather than going quiet.
  if (link !== undefined)
    runtime.runFork(
      Stream.runForEach(
        SubscriptionRef.changes(link.client).pipe(Stream.drop(1)),
        (client) =>
          Effect.sync(() =>
            appendLocalNotice(
              client === null
                ? 'The TeXRA service is offline. Reconnecting…'
                : 'Reconnected to the TeXRA service.',
            ),
          ),
      ).pipe(Scope.provide(chatScope)),
    );
  // Cosmetic, but "texra-local" or a bare shell prompt in every tab makes a
  // multi-session workflow hard to navigate: show project and attention state.
  // The terminal outlives session subscriptions: only the exit controller
  // releases it, and its `exit` hook covers every other death.
  const terminal = acquireTuiTerminal({
    kittyKeyboard: terminalCaps.kittyKeyboard,
    title: installTerminalTitleUpdates(context.cwd),
  });
  disposables.add(announceForegroundApprovals());
  disposables.add(subscribeCliCredentialChanges(runtime));
  // Keys another TeXRA window or the service saves reach this chat too.
  const watchingKeys = runtime.runFork(
    cliSecrets(context.storageRoot)
      .watch()
      .pipe(Effect.provide(nodeFileServices)),
  );
  disposables.add(() => runtime.runFork(Fiber.interrupt(watchingKeys)));
  let subscribedRuns = '';
  const syncTranscriptSubscriptions = (): void => {
    const ids = paintedRunIds.get();
    const key = ids.join('\0');
    if (key === subscribedRuns) return;
    subscribedRuns = key;
    runtime.runFork(
      backend.transcripts(
        'tui',
        ids.map((id) => ({ id: aggregateId('run', id), fromSeq: 0 })),
      ),
    );
  };
  disposables.add(
    subscribeToSignalChanges([paintedRunIds], syncTranscriptSubscriptions),
  );
  syncTranscriptSubscriptions();

  const getModelSwitchDisabledReason = (
    candidateModel: string,
  ): Effect.Effect<string | undefined, Error> => {
    if (chatTuiCanStartRootRun(session) || !session.canSelectModel()) {
      return Effect.succeed(undefined);
    }
    return (
      session.activeRunControls()?.modelSwitchDisabledReason(candidateModel) ??
      Effect.succeed(undefined)
    );
  };
  // Chat-session controller: owns run start/resume/stop orchestration.
  // The Ink layer never directly mutates session run-state fields, every
  // state transition flows through one of the controller's narrow commands.
  const chatController: ChatSessionController = createChatSessionController({
    session,
    runtimeSession,
    getSessionContext: currentSessionContext,
    disposables,
    shutdownScope: services.shutdownScope,
    followUpQueue,
    initialAgent: agent,
    initialModel: model,
    initialModelSource: defaults.modelSource,
    cwd: context.cwd,
    getSlashCommandContext: slashCommandContext,
    secrets: services.secrets,
    stores: services,
    runtime,
    ...(link !== undefined && {
      backend,
      agentRuns: serviceAgentRuns(backend),
      attachWindow: (host) => {
        runtime.runFork(
          attachWindowHost(link, context.cwd, host).pipe(
            Scope.provide(chatScope),
          ),
        );
      },
    }),
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
    followUpQueue.clear();
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
    backend,
    connectService: () => reachCliService(context.storageRoot),
    onAccountChanged: () =>
      connectChatModel(
        slashCommandContext(),
        {
          startupModel: model,
          modelSource: defaults.modelSource,
          recovery: CHAT_STARTUP_MODEL_RECOVERY,
          firstRunSetupAgent: startup.firstRunSetupAgent,
        },
        (held) =>
          chatController.submit(held.line, held.mediaFiles, held.images),
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
    onApprovalPolicySelect: (policy) => {
      setApprovalPolicy(policy);
      appendLocalNotice(`Approval mode: ${formatTexraApprovalPolicy(policy)}`);
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
    // `onApiKeySave` and `onLogoutSelect` are deliberately absent: the
    // registry's own defaults are exactly these handlers. Only `/login` needs
    // an override, to carry this session's CliContext.
    onLoginSelect: (value, output) =>
      loginFromChat(value, services, context, output),
    onMemorySelect: (storagePath) =>
      showCliMemoryPreview(runtimeSession.roots, storagePath),
    onSkillSelect: (selection) =>
      Effect.sync(() => chatController.activateSkill(selection)),
    onResumeSelect: chatController.resume,
    configStores: runtimeSession.roots,
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
      session={runtimeSession}
      requests={backend}
      onSubmit={(line, mediaFiles, images) => {
        if (holdUntilConnected({ line, mediaFiles, images })) return;
        runtime.runFork(chatController.submit(line, mediaFiles, images));
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
  if (modelConnectionNeeded.get()) openCliSlashCommandForm('login', '');

  const exitController = createSessionExitController({
    ink,
    session,
    commandName: context.commandName,
    cwd: context.cwd,
    disposables,
    terminal,
    runtime,
    followUpsIdle: followUpQueue.idle,
    getApprovalPolicy,
    flushArtifacts: runtimeSession.settlePublications(),
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
    runtime.runFork(
      chatController.resume(initialResume.id, initialResume.edit),
    );
  }

  // The one "agent finished" notification: the claimed run's turn settles,
  // at WAITING ("your turn", alongside the StatusBar pill) or at its outcome.
  // A run that ends after waiting was already announced, and a stop the user
  // asked for is not news.
  let rootPhase = session.status();
  disposables.add(
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
    // released the store, so the bridge outlives the session's disposables.
    // A signal exit leaves the store to process.exit; releasing it here keeps
    // the order on every path: nothing subscribed to the view outlives it.
    await exitController.gracefulTeardown();
    disposables.dispose();
    unbindSessionView();
  }
  return { exitCode: session.runExitCode };
}
