// `texra chat` entry point, single Ink-based session. The Ink TUI runs for
// every interactive `texra chat` invocation, and non-TTY callers are pointed
// at `texra run` (which is what they actually want for piping/scripting).
//
// Run start/resume/stop orchestration lives in ../chatSessionController;
// this module keeps only composition, rendering glue, and the Ink lifecycle.

import {
  Cause,
  Duration,
  Effect,
  Exit,
  FiberHandle,
  Result,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import { render, type Instance as InkInstance } from 'ink';

import { appSignalStream } from '@texra-ai/worldline/host';
import {
  APPROVAL_POLICY_SETTING,
  type RuntimeCommand,
  type RunId,
  type AgentConfig,
  type ApprovalPolicy,
  toErrorMessage,
} from '@texra-ai/worldline/schemas';
import { isWorking } from '@texra-ai/worldline/schemas';
import {
  SESSION_CLOSE_DEADLINE_MS,
  Settings,
} from '@texra-ai/worldline/plugins';
import {
  effectiveApprovalPolicy,
  launchApprovalNotice,
  projectApprovalPolicy,
  type CliContext,
} from '@cli/runtime/platform/cliContext';
import { linkedClient } from '@texra/controllers/server/client';

import { resolveChatDefaults } from '@cli/runtime/models/launchDefaults';
import type { CliProcessRuntime } from '@cli/runtime/platform/cliProcessRuntime';
import { CliExitCode } from '@cli/runtime/platform/exitCodes';
import { cliPlatform } from '@cli/runtime/platform/initPlatform';
import { selectCliRunnableModel } from '@cli/runtime/models/modelAccess';
import { silentLogSink, writeTextStderr } from '@cli/runtime/platform/logSinks';
import { setLogSink } from '@texra-ai/worldline/node';
import { tuiOutputStreamForColor } from '@cli/tui/noColorOutput';
import {
  acquireTuiTerminal,
  clearTerminalScrollback,
} from '@cli/tui/terminalCleanup';
import { subscribeToSignalChanges } from '@texra/shared/signals';
import { formatApprovalPolicy } from '@ui/copy/approvalPolicy';
import { sessionStoreMovedAsideMessage } from '@ui/copy/sessionStore';

import {
  createChatSessionController,
  type ChatSessionController,
} from '../chatSessionController';
import { App } from './App';
import { setupAgent } from '@texra/agent/entryAgent';
import { type ChatLaunch, chatOf } from '@texra/shared/session/surface';
import { cliEntryAgent, withoutEditorTools } from '@cli/runtime/cliEntryAgent';
import { type SlashCommandContext } from './commands/handlers/slashContext';
import { builtinSlashCommands } from './commands/registerBuiltins';
import { handleTuiSlashCommand } from './commands/handleSlashCommand';
import { expandText } from './input/draftAttachments';
import { SlashContextProvider } from './commands/slashRegistry';
import { loadInputHistory } from './history/inputHistory';
import { notify } from './notifications/terminalNotifier';
import { runAttentionLine, runStatus } from '@ui/copy/runStatus';
import { announceForegroundApprovals } from './state/subscribeApprovals';
import { chatScrollback } from './panes/staticTranscriptRing';
import { EMPTY_DRAFT } from './input/draftAttachments';
import {
  rootRunId,
  selectedRunId as selectedRunIdSignal,
  startChat,
  patchSessionMeta,
  sessionViewFailure as sessionViewFailureSignal,
  sessionMeta as sessionMetaSignal,
  setTransientNotice,
} from './state/cliState';
import {
  bindSessionView,
  currentView,
  sessionView,
  runViewOf,
} from './state/sessionView';
import { discoverTerminalCapabilities } from './state/terminalCapabilities';
import {
  appendLocalNotice,
  appendLocalRequestRefusal,
  paintedRunIds,
} from './state/transcript';
import { openRegisteredCliSlashForm } from './commands/slashForms';
import {
  checkModelConnection,
  followModelConnection,
  makeModelConnection,
  modelConnectionNeeded,
} from './modelConnection';
import { installTerminalTitleUpdates } from './terminalTitle';
import { TuiSession } from './state/sessionRunState';
import { createSessionExitController } from './sessionExitController';
import { ChatProcessProvider } from './chatProcess';
import { scopeRunner } from '../scopeRunner';

interface ChatResult {
  exitCode: number;
}

/** A change of a run's approval grants (`policy.set`). */
type PolicyChange = Extract<RuntimeCommand, { kind: 'policy.set' }>['change'];

export interface RunChatInit {
  /** The setup conversation: the entry agent with the setup tools. */
  readonly setup?: boolean;
  /** `--model` override from the CLI; falls through `resolveChatDefaults`. */
  readonly modelOverride?: string;
  /** Startup resume from `texra resume <id>`, with the run's persisted
   *  config: its agent and model are the chat's. */
  readonly initialResume?: {
    readonly id: RunId;
    readonly config: AgentConfig;
  };
}

/** `runtime` is the one the command entry built and ran its program on;
 *  platform signals hand off before Ink mounts. */
export async function runChat(
  runtime: CliProcessRuntime,
  context: CliContext,
  init: RunChatInit,
): Promise<ChatResult> {
  const initialResume = init.initialResume;
  // The chat's hold on the background service, for its whole life.
  const chatScope = Scope.makeUnsafe();
  // One startup program; an early exit is its `exitCode` case.
  const startup = await runtime.runPromise(
    Effect.gen(function* () {
      // Every chat is a client of the one service, so other terminals and
      // windows see its task: the platform (`startsService`) starts it when
      // none runs and holds the link, which reaches the service again
      // (starting one when none answers) whenever it goes away. One the
      // platform could not link runs here, and says so once.
      const services = yield* cliPlatform;
      const { service } = services;
      const link = Result.getOrUndefined(service);
      const served = link !== undefined;
      // Where this chat's runs run: the service's session, or this one.
      const runSession = yield* services.runSession;
      // Said once the view is bound, which the transcript rows need.
      const startupNotices: string[] = [];
      // This chat's requests are decided under the project's persisted
      // policy, here or in the service; what this invocation asked for rides
      // each launch (`launchApproval`).
      const refused = launchApprovalNotice(
        context.requestedApprovalPolicy,
        projectApprovalPolicy(services.roots.config),
      );
      if (refused !== undefined) startupNotices.push(refused);
      if (Result.isFailure(service)) {
        // A store this process moved aside at open is said in the
        // transcript, not on stderr before Ink mounts, where it would sit
        // above the header.
        const local = yield* services.session;
        if (local.storeMovedAside)
          startupNotices.push(
            sessionStoreMovedAsideMessage(local.storeMovedAside),
          );
        startupNotices.push(
          `This chat runs here only, so other terminals and windows will not see it: ${service.failure.message}`,
        );
      }
      // Without a usable credential the chat still opens: the "Connect a
      // model" panel takes the first foreground slot, and model resolution
      // waits for the connection instead of ending the process.
      const credential = yield* checkModelConnection(services);
      if (credential.notice) startupNotices.push(credential.notice);
      const defaults = resolveChatDefaults({
        stores: services,
        modelOverride: initialResume?.config.model ?? init.modelOverride,
        envModel: context.envModel,
      });
      // A resumed conversation keeps the system text and tools its run
      // recorded.
      const resumed = initialResume?.config;
      const chat: ChatLaunch =
        resumed === undefined
          ? init.setup
            ? withoutEditorTools(setupAgent())
            : yield* cliEntryAgent
          : chatOf(resumed);
      const modelSelectionExit = yield* Effect.exit(
        credential.ready
          ? selectCliRunnableModel(
              [{ model: defaults.model, reason: defaults.modelSource }],
              { stores: services },
            )
          : Effect.succeed({ model: defaults.model, notice: undefined }),
      );
      if (Exit.isFailure(modelSelectionExit)) {
        writeTextStderr(toErrorMessage(modelSelectionExit.cause));
        return { exitCode: CliExitCode.Usage };
      }
      const modelSelection = modelSelectionExit.value;
      sessionMetaSignal.set({
        chat,
        model: modelSelection.model,
        modelSource: defaults.modelSource,
        cwd: context.cwd,
        approvalPolicy: effectiveApprovalPolicy(
          context.requestedApprovalPolicy,
          projectApprovalPolicy(services.roots.config),
        ),
        version: context.version,
      });
      if (modelSelection.notice) startupNotices.push(modelSelection.notice);
      // Stored until the platform closes, after the chat's scope: a graceful
      // exit keeps the line it was typed after.
      const { history: inputHistory, readFailure } =
        yield* loadInputHistory.pipe(Scope.provide(services.shutdownScope));
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
        runSession,
        link,
        runsElsewhere: served,
        defaults,
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
  const {
    services,
    runSession,
    runsElsewhere,
    link,
    defaults,
    inputHistory,
    startupNotices,
    terminalCaps,
  } = startup;

  // The policy this chat's launches ask for (`launchApproval`): its flag,
  // then each `/approval`.
  let chatPolicy = context.requestedApprovalPolicy;
  const getApprovalPolicy = (): ApprovalPolicy =>
    effectiveApprovalPolicy(
      chatPolicy,
      projectApprovalPolicy(services.roots.config),
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
    const run = runViewOf(currentView(), rootRunId.get());
    if (run === undefined) return Effect.void;
    const bypass = (enabled: boolean): PolicyChange => ({
      field: 'bypass',
      runId: run.id,
      bypass: 'superYolo',
      enabled,
    });
    const changes: PolicyChange[] = [
      ...(policy === 'yolo' && run.actions.includes('grant')
        ? [bypass(true)]
        : []),
      ...(leaving ? [bypass(false)] : []),
      ...(policy !== 'yolo' && run.holder === 'here'
        ? [{ field: 'limit' as const, runId: run.id, limit: policy }]
        : []),
    ];
    // Durable before the selection finishes, so nothing the chat sends next
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
  // The two owners of what the chat starts from outside Effect. The chat's
  // scope ends what the session on screen holds, and the exit drain awaits
  // that close; the process's shutdown scope ends what must outlive it (a
  // message being sent, a run being resumed), on every exit path.
  const chat = scopeRunner(runtime, chatScope);
  const untilShutdown = scopeRunner(runtime, services.shutdownScope);
  // What is added below closes last in first out.
  const onChatClose = (release: () => void): void =>
    chat.sync(Effect.addFinalizer(() => Effect.sync(release)));
  // The one session state the TUI renders: the session view
  // bridged into a signal, its transcript tier subscribed for the runs this
  // terminal paints. Bound before anything reads the view: the terminal
  // title below derives its attention state from it on install.
  const session = new TuiSession(runsElsewhere);
  // A dead session view (`view.changes` failing) is the end of this session: the
  // composer closes on the reason, Ctrl-C still exits, and the exit is a
  // failure on every exit path (`TuiSession.exitCode` reads the failure).
  const unbindSessionView = bindSessionView(runtime, runSession.view, {
    onFailure: (error) => {
      sessionViewFailureSignal.set(
        `The session view stopped updating: ${toErrorMessage(error)} Press Ctrl-C to exit and restart texra. If it repeats, run the same texra version that last opened this project; an older build cannot read a newer session store.`,
      );
    },
  });
  for (const notice of startupNotices) appendLocalNotice(notice);
  if (link !== undefined)
    chat.fork(
      // The service went away (retired by a newer build, or it died) and
      // the link reaches it again: the chat says so, rather than going
      // quiet.
      Stream.runForEach(link.client.changes.pipe(Stream.drop(1)), (client) =>
        Effect.sync(() =>
          appendLocalNotice(
            client === null
              ? 'The TeXRA service is offline; TeXRA is reconnecting. If another window runs a newer TeXRA, update this one.'
              : 'Reconnected to the TeXRA service.',
          ),
        ),
      ),
    );
  // A write to the project's approval policy in this process (`/config`, a
  // settings view) repaints the policy line, as it does every window's.
  chat.fork(
    Stream.runForEach(appSignalStream('approvalPolicyChanged'), () =>
      Settings.get(services.roots, APPROVAL_POLICY_SETTING).pipe(
        Effect.map((policy) => {
          patchSessionMeta({
            approvalPolicy: effectiveApprovalPolicy(chatPolicy, policy),
          });
          appendLocalNotice(
            `Project approval policy: ${formatApprovalPolicy(policy)}`,
          );
        }),
        // The value is written: a failed repaint leaves the line as it was.
        Effect.ignore({
          log: 'Warn',
          message: 'Approval policy written; session repaint failed',
        }),
      ),
    ),
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
  // The runs this terminal paints, watched on the session for as long as
  // the set holds: the watch keeps their transcripts in the view, and a
  // new set replaces the watch. The chat's scope ends it.
  const transcriptWatch = chat.sync(FiberHandle.make<void, never>());
  let subscribedRuns = '';
  const syncTranscriptSubscriptions = (): void => {
    const ids = paintedRunIds.get();
    const key = ids.join('\0');
    if (key === subscribedRuns) return;
    subscribedRuns = key;
    const view = runSession.view.current();
    chat.fork(
      FiberHandle.run(
        transcriptWatch,
        Stream.runDrain(
          runSession.view.watch(
            ids.map((id) => ({
              id: id,
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
    if (session.canStartRootRun() || !session.canSelectModel()) {
      return Effect.undefined;
    }
    // The run's loop answers in this process; the service checks the
    // switch against the run when it is asked.
    const runId = rootRunId.get();
    if (runId === undefined || runsElsewhere) return Effect.undefined;
    return Effect.flatMap(
      services.session,
      (local) =>
        local.held(runId)?.modelSwitchDisabledReason(candidateModel) ??
        Effect.undefined,
    );
  };
  // Chat-session controller: owns run start/resume/stop orchestration.
  // The Ink layer never directly mutates session run-state fields, every
  // state change flows through one of the controller's narrow commands.
  const draft = chat.sync(SubscriptionRef.make(EMPTY_DRAFT));
  // The chat's slash commands; their handlers and forms act over the slash
  // context built below.
  const commands = builtinSlashCommands({
    ...(link !== undefined && {
      connectService: () =>
        Effect.map(linkedClient(link), (client) => ({ client })),
    }),
  });
  const modelConnection = makeModelConnection(() =>
    openRegisteredCliSlashForm(commands.login),
  );
  const chatController: ChatSessionController = createChatSessionController({
    session,
    runSession,
    served: runsElsewhere,
    commandName: context.commandName,
    chat,
    untilShutdown,
    cwd: context.cwd,
    stores: services,
    runtime,
    approvalPolicy: () => chatPolicy,
    draft,
    modelConnection,
  });

  const inkRef: { current?: InkInstance } = {};
  const scrollback = chatScrollback(chat, inkRef);

  const resetSessionForClear = (): boolean => {
    const currentRunId = rootRunId.get() ?? selectedRunIdSignal.get();
    const activeRun = runViewOf(currentView(), currentRunId);
    const isRunPending = !session.canStartRootRun();

    if (
      (isRunPending && activeRun?.position !== 'waiting') ||
      (activeRun != null && isWorking(activeRun))
    ) {
      setTransientNotice(
        'Wait for the active response to finish, or press Ctrl-C first.',
      );
      return false;
    }

    const meta = sessionMetaSignal.get();
    if (isRunPending) chatController.stop();
    chatController.clearPendingSkills();
    startChat(meta);
    // The erase happens outside Ink, so the scrollback prints again from a
    // new origin even when the history it rebuilds is empty.
    clearTerminalScrollback();
    scrollback.restart();
    return true;
  };

  // What every slash command, its handler or its form, acts over.
  const slashContext: SlashCommandContext = {
    commands,
    cliContext: context,
    session,
    runSession,
    stores: services,
    chat,
    processCwd: process.cwd(),
    // The exit controller is built after Ink mounts; `/exit` runs later.
    requestInputExit: () => void exitController.exit(),
    getApprovalPolicy,
    setApprovalPolicy,
    resetSession: resetSessionForClear,
    resumeRun: chatController.resume,
    resumeTask: chatController.resumeTask,
    activateSkill: chatController.activateSkill,
    getModelSwitchDisabledReason,
  };
  chat.fork(
    followModelConnection(services, defaults.modelSource, modelConnection),
  );

  // Ink owns the terminal from here: a diagnostic line would land inside
  // the frame it redraws, so the chat's diagnostics go nowhere.
  setLogSink(silentLogSink, { trusted: true });
  const ink = render(
    <SlashContextProvider value={slashContext}>
      <ChatProcessProvider value={{ chat, roots: services.roots }}>
        <App
          session={runSession}
          draft={draft}
          onSubmit={(message, holdUntil) => {
            // Until shutdown, not until the chat's scope closes: a graceful
            // exit closes that scope first and then waits for the messages
            // still being sent.
            untilShutdown.fork(
              Effect.gen(function* () {
                const line = expandText(message).trim();
                if (yield* handleTuiSlashCommand(line, slashContext)) return;
                yield* chatController.submit(message, holdUntil);
              }),
            );
          }}
          commandName={context.commandName}
          scrollback={scrollback}
          onCtrlC={() => exitController.handleSigint()}
          onSuspend={() => exitController.handleSigtstp()}
          history={inputHistory}
          performHost={chatController.performHost}
        />
      </ChatProcessProvider>
    </SlashContextProvider>,
    {
      stdout: tuiOutputStreamForColor(
        process.stdout,
        context.stdoutColorEnabled,
      ),
      stderr: process.stderr,
      stdin: process.stdin,
      // Own Ctrl+C ourselves (App's unified useInput → exit()) instead of via
      // Ink's built-in handler. Ink's exitOnCtrlC only matches the raw \x03,
      // which never arrives under the Kitty protocol (Ctrl+C becomes ESC[99;5u);
      // worse, while it's enabled Ink's useInput *filters out* Ctrl+C before any
      // handler runs (build/hooks/use-input.js). Disabling it lets the parsed
      // ctrl+c key reach our handler uniformly on every terminal.
      exitOnCtrlC: false,
      // Rewrite only the live-region lines that changed, and only past their
      // unchanged prefix: typing or streaming redraws a fraction of the bytes
      // a whole-region rewrite does, which is what flickers over slow links.
      incrementalRendering: true,
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
  if (modelConnectionNeeded.get()) openRegisteredCliSlashForm(commands.login);

  // Making the controller takes the signals over from the platform handler,
  // not any earlier: everything above (the platform init, onboarding, model
  // resolution) ran with the platform's own handler still live, so a signal
  // during that window still got a graceful shutdown.
  const exitController = createSessionExitController({
    ink,
    session,
    commandName: context.commandName,
    cwd: context.cwd,
    chatScope,
    chat,
    untilShutdown,
    terminal,
    runtime,
    leaveProcess: services.leave,
    submitted: chatController.submitted,
    getApprovalPolicy,
    // What the session's publisher still holds, when the session is this
    // process's (the service's publisher is its own), drained before
    // shutdown within the close budget; one that does not drain is said on
    // stderr.
    flushArtifacts: (runsElsewhere
      ? Effect.void
      : Effect.flatMap(services.session, (local) => local.drained)
    ).pipe(
      Effect.timeoutOrElse({
        duration: SESSION_CLOSE_DEADLINE_MS,
        orElse: () =>
          Effect.fail(
            new Cause.TimeoutError(
              `the session's rows were not all written within ${Duration.format(Duration.millis(SESSION_CLOSE_DEADLINE_MS))}`,
            ),
          ),
      }),
    ),
    repaintAfterTerminalResume: scrollback.restart,
    interruptActive: () => chatController.stop(),
  });

  // Interactive resume: kick off the continued tool-use run now that Ink is
  // mounted (so the reloaded transcript + streamed continuation render) and
  // the signal handlers are armed. Fire-and-forget, the resume claims the
  // root launch, and the normal first-input path stays available so the
  // user can keep chatting (follow-ups target the root run as usual).
  if (initialResume) {
    untilShutdown.fork(chatController.resume(initialResume.id));
  }

  // The one turn-finished notification: the root run's turn finishes,
  // at WAITING ("your turn", alongside the StatusBar pill) or at its outcome.
  // A run that ends after waiting was already announced, and a stop the user
  // asked for is not news. A turn end, not `attentionOf`'s `finished`: a
  // conversation's turn ends at WAITING with no outcome.
  const rootStandingNow = () => runViewOf(currentView(), rootRunId.get());
  let rootStanding = rootStandingNow();
  onChatClose(
    subscribeToSignalChanges([sessionView()], () => {
      const previous = rootStanding;
      rootStanding = rootStandingNow();
      if (rootStanding === undefined) return;
      const { outcome } = rootStanding;
      if (
        previous?.position !== 'waiting' &&
        (rootStanding.position === 'waiting' ||
          (outcome !== null &&
            outcome !== previous?.outcome &&
            // A stop ends the run cancelled: no "finished" bell for it.
            outcome !== 'cancelled'))
      ) {
        notify(runAttentionLine(rootStanding, runStatus(rootStanding).key));
      }
    }),
  );

  // The code the exit's drain answers, read before the exit clears the
  // chat's state.
  let exitCode: CliExitCode;
  try {
    await ink.waitUntilExit();
  } finally {
    // The exit policy reads the view (a resumable idle root) after it has
    // released the store, so the bridge outlives the chat's scope. The
    // exit finishes only on the graceful path, whose drain closes that scope
    // first (a signal exit ends in process.exit and never returns here), so
    // nothing subscribed to the view outlives the bridge.
    exitCode = await exitController.exit();
    unbindSessionView();
  }
  return { exitCode };
}
