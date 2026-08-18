// `texra chat` entry point — single Ink-based session. The Ink TUI runs for
// every interactive `texra chat` invocation, and non-TTY callers are pointed
// at `texra run` (which is what they actually want for piping/scripting).
//
// Run start/resume/stop orchestration lives in ../chatSessionController;
// this module keeps only composition, rendering glue, and the Ink lifecycle.

import { render, type Instance as InkInstance } from 'ink';
import PQueue from 'p-queue';

import { getVisibleAgents, loadAgents } from '@agent/index';
import { detachSubagentsOnStop, type ToolUseResumeData } from '@agent/runtime';
import { setCliAgentResumeHandler } from '@cli/runtime/agentResume';
import { chatAgentSupportsDelegation } from '@cli/runtime/agents';
import { type CliContext, readCliVersion } from '@cli/runtime/cliContext';
import {
  firstRunSetupAgentOverride,
  SETUP_AGENT_HANDOFF_NOTICE,
} from '@cli/onboarding/setupContinuation';
import { resolveChatDefaults } from '@cli/runtime/chatDefaults';
import { CliExitCode } from '@cli/runtime/exitCodes';
import {
  initInteractiveCliPlatform,
  setCliHelperModel,
} from '@cli/runtime/initPlatform';
import {
  formatCliNoAvailableModelsRecovery,
  selectCliRunnableModel,
  type CliNoAvailableModelsRecoveryOptions,
  type CliRunnableModelResolution,
} from '@cli/runtime/modelAccess';
import { writeTextStderr } from '@cli/runtime/logSinks';
import { readCliMultiAgentPresetName } from '@cli/runtime/multiAgentPresets';
import { initializeInteractiveTranscriptSession } from '@cli/runtime/transcriptSession';
import { cliSettingsStores } from '@cli/runtime/settingsStores';
import {
  formatInteractiveTerminalFailure,
  interactiveTerminalFailure,
} from '@cli/runtime/terminalRequirements';
import { tuiOutputStreamForColor } from '@cli/tui/noColorOutput';
import {
  clearTerminalScrollback,
  installTerminalRestoreOnExit,
} from '@cli/tui/terminalCleanup';
import { DisposableStore } from '@platform/disposable';
import { platform } from '@platform/platform';
import {
  formatTexraApprovalPolicy,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import type {
  AgentDelegationScope,
  ExecutionId,
  StreamPhase,
} from '@shared/schemas';
import { AgentCategory, STREAM_PHASE } from '@shared/schemas';
import { getFirstRunDone } from '@shared/state/onboardingState';
import { isActivePhase } from '@shared/streams/streamStatus';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  createChatSessionController,
  type ChatSessionController,
} from '../chatSessionController';
import { App } from './App';
import { createChatSubmitDriver } from './chatSubmitDriver';
import {
  applyCliModelSelection,
  applyInitialCliAgentSelection,
  chatToolUseAgentUsageError,
} from './commands/handlers/agentModelCommands';
import {
  applyCliModelAccessSelection,
  applyCliProviderApiKey,
} from './commands/handlers/modelAccessCommands';
import { showCliMemoryPreview } from './commands/handlers/memoryCommands';
import {
  loginFromChat,
  logoutFromChat,
} from './commands/handlers/loginCommands';
import { type SlashCommandContext } from './commands/handlers/slashContext';
import { registerBuiltinSlashCommands } from './commands/registerBuiltins';
import { loadInputHistory } from './history/inputHistory';
import { notify } from './notifications/terminalNotifier';
import { createTuiViewportController } from './render/tuiViewportController';
import { clearApprovals } from './state/approvalQueue';
import {
  activeStreamId as activeStreamIdSignal,
  resetCliState,
  patchSessionMeta,
  sessionMeta as sessionMetaSignal,
  streams as streamsSignal,
} from './state/cliState';
import { subscribeStreamArtifacts } from './state/subscribeStreamArtifacts';
import { notifyStaticTranscriptErased } from './state/staticTranscriptRepaint';
import { subscribeStreamLog } from './state/subscribeStreamLog';
import { subscribeStreamStatus } from './state/subscribeStreamStatus';
import { discoverTerminalCapabilities } from './state/terminalCapabilities';
import {
  appendLocalAssistantTranscript,
  appendLocalErrorTranscript,
} from './state/transcript';
import { installTerminalTitleUpdates } from './terminalTitle';
import {
  chatTuiCanInterruptActiveRun,
  chatTuiCanSelectModel,
  chatTuiCanStartRootRun,
  chatTuiCanStopVisibleRun,
  chatTuiIsResumableIdleOnExit,
  chatTuiRunPending,
  TuiSession,
} from './state/sessionRunState';
import { createSessionExitController } from './sessionExitController';

export interface ChatResult {
  exitCode: number;
}

export interface RunChatInit {
  /** `--agent` override from the CLI; falls through `resolveChatDefaults`. */
  readonly agentOverride?: string;
  /** `--model` override from the CLI; falls through `resolveChatDefaults`. */
  readonly modelOverride?: string;
  /**
   * Display-only transcript notice shown at session start (never sent to the
   * model). Callers that steer the session themselves — the first-run
   * setup-agent handoff in `orchestrate` — use it to explain that steering.
   */
  readonly startupNotice?: string;
  /** Visible team identity when chat was launched from a multi-agent preset. */
  readonly teamName?: string;
  /** Multi-agent preset id when chat was launched from a team preset. */
  readonly cliMultiAgentPresetId?: string;
  readonly delegationAgentScope?: AgentDelegationScope;
  /** Pre-resolved startup resume from `texra resume <id>`. */
  readonly initialResume?: {
    readonly id: ExecutionId;
    readonly resolution: ToolUseResumeData;
  };
}

const CHAT_STARTUP_MODEL_RECOVERY = {
  configureKeyAction: 'add a provider API key with `texra setup`',
} satisfies CliNoAvailableModelsRecoveryOptions;

export async function runChat(
  context: CliContext,
  init: RunChatInit,
): Promise<ChatResult> {
  // `mode === 'headless'` already covers --print / CI / non-TTY stdin
  // (see cliContext.cliMode); stdout must also be a TTY for Ink to render,
  // and `TERM=dumb` strips the cursor controls Ink depends on (Ink would
  // mount and emit garbled output instead of a usable session).
  const terminalFailure = interactiveTerminalFailure(context);
  const clearItermProgress = process.env.TERM_PROGRAM === 'iTerm.app';
  if (terminalFailure) {
    // Headless precedence: in CI (headless + TERM=dumb often co-occur) the
    // actionable advice is "use `texra run`", not "fix your TERM".
    writeTextStderr(
      formatInteractiveTerminalFailure(terminalFailure, {
        headlessMessage:
          'texra chat requires an interactive terminal (TTY stdin and stdout). For scripting or piped input, use `texra run`.',
        dumbTerminalCommand: 'chat',
        dumbTerminalOptions: { nonInteractiveFallback: '`texra run`' },
      }),
    );
    return { exitCode: CliExitCode.Usage };
  }

  // The platform's own SIGINT/SIGTERM handler stays live through onboarding
  // and model resolution below — this function does not suppress it. Once
  // Ink actually mounts (below), handOffCliShutdownSignalHandlers() removes
  // it immediately before this function installs its own process.on pair, so
  // exactly one owner is ever registered for a given signal; see
  // initInteractiveCliPlatform's doc comment for the full handoff design.
  await initInteractiveCliPlatform({ ...context, quietLogs: true });
  const initialResume = init.initialResume;
  const transcriptLifecycle = await initializeInteractiveTranscriptSession(
    initialResume
      ? { onPersistentOpenFailure: 'fail' }
      : {
          onPersistentOpenFailure: 'use-ephemeral',
          showPersistentWarning: writeTextStderr,
        },
  );
  const runtimeSession = transcriptLifecycle.session;
  runtimeSession.setApprovalPolicy(context.approvalPolicy);
  // First-run gate (interactive only; headless already rejected above). A
  // credential-less user signs in or saves a key here; the model
  // resolution below then see the freshly-set credentials in the same process.
  const { maybeRunCliOnboarding } =
    await import('@cli/onboarding/runOnboarding');
  const onboarding = await maybeRunCliOnboarding(context);
  if (onboarding.declined) {
    // The user saw the picker and chose "Skip for now"; the skip summary already
    // told them how to set up later. Exit cleanly instead of falling through to
    // the no-models resolution error — the dead-end this feature exists to fix.
    return { exitCode: CliExitCode.Success };
  }
  // State 1 continuation (docs/prds/2026-06-11-agent-native-onboarding.md): on a true
  // first run the post-picker session starts with the setup agent. Threaded
  // through the same override slot resolveChatDefaults already honors, and
  // only when the user didn't pin an agent (--agent, resume, or env) — an
  // explicit choice always wins.
  const explicitAgent =
    initialResume?.resolution.agentConfig.agent ?? init.agentOverride;
  const setupAgentOverride = firstRunSetupAgentOverride({
    onboardingConfigured: onboarding.configured,
    firstRunDone: getFirstRunDone(platform().globalState),
    pinnedAgent: explicitAgent ?? context.envAgent,
  });
  await loadAgents();
  const visibleToolUseAgents = getVisibleAgents(AgentCategory.ToolUse);
  const defaults = await resolveChatDefaults({
    cwd: context.cwd,
    agentOverride: explicitAgent ?? setupAgentOverride,
    modelOverride:
      initialResume?.resolution.agentConfig.model ?? init.modelOverride,
    envAgent: context.envAgent,
    envModel: context.envModel,
    visibleToolUseAgents,
  });
  const agentUsageError = chatToolUseAgentUsageError(defaults.agent);
  if (agentUsageError) {
    writeTextStderr(agentUsageError);
    return { exitCode: CliExitCode.Usage };
  }
  // One API mode for the whole session: an explicit --api-mode/env override
  // wins, otherwise the persisted account default. Model resolution, the
  // no-models hints, and the header/status all read this same value so they can
  // never disagree.
  let modelSelection: CliRunnableModelResolution;
  try {
    modelSelection = await selectCliRunnableModel(defaults.model, {
      fallbackReason: defaults.modelSource,
      noAvailableModelsMessage: formatCliNoAvailableModelsRecovery(
        CHAT_STARTUP_MODEL_RECOVERY,
      ),
    });
    await setCliHelperModel(modelSelection.model);
  } catch (error: unknown) {
    writeTextStderr(toErrorMessage(error));
    return { exitCode: CliExitCode.Usage };
  }
  const { agent } = defaults;
  const model = modelSelection.model;
  const version = await readCliVersion();

  const getApprovalPolicy = (): TexraApprovalPolicy =>
    runtimeSession.approvalPolicy;
  const currentSessionContext = (helperModel: string): CliContext => ({
    ...context,
    helperModel,
    quietLogs: true,
  });
  const setApprovalPolicy = (policy: TexraApprovalPolicy): void => {
    runtimeSession.setApprovalPolicy(policy);
    patchSessionMeta({ approvalPolicy: policy });
  };
  // The slash-command context is identical at every call site; build it once
  // lazily so the closures it captures (interruptActive, resetSessionForClear,
  // chatController.resume) are all defined before the first use.
  const slashCommandContext = (): SlashCommandContext => ({
    cliContext: context,
    session,
    commandName: context.commandName,
    cwd: context.cwd,
    processCwd: process.cwd(),
    initialAgent: agent,
    initialModel: model,
    interruptActive,
    requestInputExit: exitController.requestInputExit,
    getApprovalPolicy,
    setApprovalPolicy,
    canSelectModel: canSelectCurrentModel,
    resetSession: resetSessionForClear,
    resumeExecution: chatController.resume,
  });
  const initialPresetId = initialResume
    ? (initialResume.resolution.agentConfig.cliMultiAgentPresetId ?? undefined)
    : init.cliMultiAgentPresetId;
  sessionMetaSignal.set({
    agent,
    category: AgentCategory.ToolUse,
    model,
    modelSource: defaults.modelSource,
    cwd: context.cwd,
    approvalPolicy: runtimeSession.approvalPolicy,
    canDelegate: chatAgentSupportsDelegation(agent),
    transcriptMode: transcriptLifecycle.canResume ? 'persistent' : 'ephemeral',
    teamName: initialResume
      ? readCliMultiAgentPresetName(initialPresetId)
      : (init.teamName ?? readCliMultiAgentPresetName(initialPresetId)),
    cliMultiAgentPresetId: initialPresetId,
    delegationAgentScope: initialResume
      ? (initialResume.resolution.agentConfig.delegationAgentScope ?? undefined)
      : init.delegationAgentScope,
    version,
  });
  if (transcriptLifecycle.warning) {
    appendLocalErrorTranscript(transcriptLifecycle.warning);
  }
  if (modelSelection.notice) {
    appendLocalAssistantTranscript(modelSelection.notice);
  }
  // First-run handoff explanation: when the setup agent owns this session
  // (decided here for `texra chat`, passed in by `orchestrate`), say so —
  // display-only, so the agent waits for the user's first message.
  const startupNotice =
    init.startupNotice ??
    (setupAgentOverride ? SETUP_AGENT_HANDOFF_NOTICE : undefined);
  if (startupNotice) {
    appendLocalAssistantTranscript(startupNotice);
  }

  const inputHistory = await loadInputHistory();

  // DA1 sentinel discovery runs *before* Ink mounts so it owns the raw-mode
  // toggle exclusively — interleaving with Ink's own raw-mode lifecycle (set
  // when `useInput` mounts) caused capability discovery to flip raw mode off
  // ~250ms in, breaking input. Capability-gated notifications fall back to
  // BEL during this window (~250ms typical, hard 250ms cap on no DA1 reply).
  const terminalCaps = await discoverTerminalCapabilities({
    stdin: process.stdin,
    stdout: process.stdout,
  });

  const disposables = new DisposableStore();
  // Crash safety stays armed until graceful teardown has restored the terminal;
  // it outlives session subscriptions so a later teardown failure cannot leave
  // the user's shell in raw/kitty/mouse mode with a hidden cursor.
  const disposeTerminalRestoreOnExit = installTerminalRestoreOnExit({
    clearItermProgress,
  });
  // Cosmetic, but "texra-local" (a local dev binary's own name) or a bare
  // shell prompt in every tab makes a multi-session workflow hard to
  // navigate. Keep the project name while surfacing live attention state.
  const terminalTitleUpdates = installTerminalTitleUpdates(context.cwd);
  disposables.add(terminalTitleUpdates.dispose);
  disposables.add(subscribeStreamLog());
  disposables.add(subscribeStreamArtifacts(runtimeSession.snapshots));

  const session = new TuiSession();

  const followUpQueue = new PQueue({ concurrency: 1 });
  const rootStreamStatus = (): StreamPhase | undefined =>
    session.streamId
      ? streamsSignal.get().get(session.streamId)?.status
      : undefined;
  const hasActiveToolUseFlow = (): boolean =>
    Boolean(
      session.streamId &&
      runtimeSession.executions.getToolUseFlowContext(session.streamId),
    );
  const canSelectCurrentModel = (): boolean =>
    chatTuiCanSelectModel({
      canStartRootRun: chatTuiCanStartRootRun(session),
      streamId: session.streamId,
      status: rootStreamStatus(),
      hasActiveToolUseFlow: hasActiveToolUseFlow(),
    });
  const getModelSwitchDisabledReason = (
    candidateModel: string,
  ): string | undefined => {
    if (chatTuiCanStartRootRun(session) || !canSelectCurrentModel()) {
      return undefined;
    }
    const activeFlow = session.streamId
      ? runtimeSession.executions.getToolUseFlowContext(session.streamId)
      : undefined;
    return activeFlow?.modelSwitchDisabledReason(candidateModel);
  };
  const canInterruptActiveRun = (): boolean =>
    chatTuiCanInterruptActiveRun(session);
  const canStopActiveRun = (): boolean =>
    chatTuiCanStopVisibleRun({
      runPending: chatTuiRunPending(session),
      streamId: session.streamId,
      status: rootStreamStatus(),
    });
  const isResumableIdle = (): boolean =>
    transcriptLifecycle.canResume &&
    chatTuiIsResumableIdleOnExit({
      canInterruptActiveRun: canInterruptActiveRun(),
      canStopActiveRun: canStopActiveRun(),
      hasActiveToolUseFlow: hasActiveToolUseFlow(),
    });
  // Chat-session controller: owns run start/resume/stop orchestration.
  // The Ink layer never directly mutates session run-state fields — every
  // state transition flows through one of the controller's narrow commands.
  const chatController: ChatSessionController = createChatSessionController({
    session,
    runtimeSession,
    getSessionContext: currentSessionContext,
    disposables,
    followUpQueue,
    snapshotStore: runtimeSession.snapshots,
  });
  disposables.add(subscribeStreamStatus());
  disposables.add(
    setCliAgentResumeHandler({
      tryResumeStream: chatController.tryResumeStream,
    }),
  );

  // Session-command engine: slash-command dispatch, follow-up admission, the
  // stream-id poll loop, queued-follow-up emission, and skill-activation
  // reservation/restore. Lives outside this mount function so the submission
  // state machine is testable without mounting Ink.
  const submitDriver = createChatSubmitDriver({
    session,
    chatController,
    followUpQueue,
    runtimeSession,
    initialAgent: agent,
    initialModel: model,
    initialModelSource: defaults.modelSource,
    cwd: context.cwd,
    getSlashCommandContext: slashCommandContext,
  });

  const interruptActive = (): void => {
    chatController.stop();
  };

  const resetSessionForClear = (): void => {
    const currentStreamId = session.streamId ?? activeStreamIdSignal.get();
    const activeStatus = currentStreamId
      ? streamsSignal.get().get(currentStreamId)?.status
      : undefined;
    const isRunPending = chatTuiRunPending(session);

    if (
      (isRunPending && activeStatus !== STREAM_PHASE.WAITING) ||
      isActivePhase(activeStatus)
    ) {
      appendLocalAssistantTranscript(
        'Wait for the active response to finish, or press Ctrl-C before /clear.',
      );
      return;
    }

    const meta = sessionMetaSignal.get();
    if (isRunPending) chatController.stop();
    clearApprovals();
    followUpQueue.clear();
    chatController.clearInterruptedRecovery();
    submitDriver.clearPendingSkills();
    session.clearRunState();
    // StreamLogStore entries outlive resetCliState (which only clears the
    // React/signal view). Drop them so transcript projection can't replay
    // the cleared conversation into the fresh `<Static>` scrollback.
    const store = runtimeSession.transcripts;
    for (const streamId of streamsSignal.get().keys()) {
      store.delete(streamId).catch(() => {
        // Best-effort: a KV failure leaves the log on disk, but the run
        // is already torn down — nothing actionable to surface here.
      });
    }
    resetCliState(meta);
    clearTerminalScrollback();
    // The erase above happened outside Ink, so everything the static
    // transcript printed is gone from the terminal — even when the state
    // rebuild is a no-op (empty history) that would skip the repaint-epoch
    // bump. The erase epoch forces a rebuild after the reset state commits,
    // so the remounted `<Static>` repaints the header without ever carrying
    // the cleared rows.
    notifyStaticTranscriptErased();
  };

  // Pre-register the slash commands the input palette uses.
  registerBuiltinSlashCommands({
    canSelectAgent: () => chatTuiCanStartRootRun(session),
    onAgentSelect: (nextAgent) =>
      applyInitialCliAgentSelection(nextAgent, slashCommandContext()),
    getApprovalPolicy,
    onApprovalPolicySelect: (policy) => {
      setApprovalPolicy(policy);
      appendLocalAssistantTranscript(
        `Approval mode: ${formatTexraApprovalPolicy(policy)}`,
      );
    },
    canSelectModel: canSelectCurrentModel,
    getModelSwitchDisabledReason,
    onModelSelect: (nextModel) =>
      applyCliModelSelection(nextModel, slashCommandContext()),
    onModelAccessSelect: (route, output) =>
      applyCliModelAccessSelection(route, slashCommandContext(), output),
    onApiKeySave: (provider, key) => applyCliProviderApiKey(provider, key),
    onLoginSelect: (value, output) => loginFromChat(value, context, output),
    onLogoutSelect: (value, output) => logoutFromChat(value, output),
    onMemorySelect: showCliMemoryPreview,
    onSkillSelect: submitDriver.activateSkill,
    onResumeSelect: chatController.resume,
    workPlanSnapshots: runtimeSession.snapshots,
    getConfigStores: cliSettingsStores,
    onError: (error) => {
      appendLocalAssistantTranscript(toErrorMessage(error));
    },
  });

  const stdoutColorEnabled = context.stdoutColorEnabled;
  const inkRef: { current?: InkInstance } = {};
  const viewportController = createTuiViewportController(inkRef);
  const ink = render(
    <App
      onSubmit={(line, mediaFiles) =>
        void submitDriver.handleSubmittedLine(line, mediaFiles)
      }
      canInterruptActiveRun={canInterruptActiveRun}
      canInterruptStream={(streamId) =>
        (streamId === session.streamId && canInterruptActiveRun()) ||
        runtimeSession.status.isInFlight(streamId)
      }
      canStopActiveRun={canStopActiveRun}
      colorEnabled={stdoutColorEnabled}
      commandName={context.commandName}
      onInterruptActive={interruptActive}
      onInterruptStream={chatController.stopStream}
      onStaticTranscriptChange={viewportController.repaintTranscript}
      onCtrlC={() => exitController.handleSigint()}
      onSuspend={() => exitController.handleSigtstp()}
      onKillExecution={(executionId) => {
        clearApprovals();
        runtimeSession.executions.kill(executionId, {
          detachActiveChildren: detachSubagentsOnStop(),
        });
      }}
      onWorkflowControl={(executionId, action) => {
        runtimeSession.workflowControls.control(
          executionId as ExecutionId,
          action,
        );
      }}
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
      // terminal supports it — already confirmed by discoverTerminalCapabilities
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

  const exitController = createSessionExitController({
    ink,
    session,
    commandName: context.commandName,
    cwd: context.cwd,
    canResume: transcriptLifecycle.canResume,
    clearItermProgress,
    kittyKeyboardEnabled: terminalCaps.kittyKeyboard,
    disposables,
    disposeTerminalRestoreOnExit,
    followUpQueue,
    getApprovalPolicy,
    flushArtifacts: () => runtimeSession.flushArtifacts(),
    repaintAfterTerminalResume: () =>
      viewportController.repaintAfterTerminalResume(),
    suspendTerminalTitle: terminalTitleUpdates.suspend,
    resumeTerminalTitle: terminalTitleUpdates.resume,
    canStopActiveRun,
    isResumableIdle,
    interruptActive,
  });
  // Transfer signal ownership from the platform handler and arm this session's
  // handlers — not any earlier: everything above (initInteractiveCliPlatform,
  // onboarding, model resolution) ran with the platform's own handler still
  // live, so a signal during that window still got a graceful shutdown.
  exitController.install();

  // Interactive resume: kick off the continued tool-use run now that Ink is
  // mounted (so the rehydrated transcript + streamed continuation render) and
  // the signal handlers are armed. Fire-and-forget — resumeAgentRun installs
  // session.runPromise, and the normal first-input path stays available so the
  // user can keep chatting (follow-ups target session.streamId as usual).
  if (initialResume) {
    void chatController.resume(initialResume.id, initialResume.resolution);
  }

  // Auto-prompt when the active stream goes WAITING so the UI clearly
  // signals "your turn," alongside the StatusBar pill.
  disposables.add(
    runtimeSession.events.subscribeStatus((change) => {
      if (
        change.streamId === session.streamId &&
        change.phase === STREAM_PHASE.WAITING &&
        !session.stopRequested
      ) {
        notify('agentFinished');
      }
    }),
  );

  try {
    await ink.waitUntilExit();
  } finally {
    await exitController.gracefulTeardown();
  }
  return { exitCode: session.runExitCode };
}
