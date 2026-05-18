// `texra chat` entry point — single Ink-based session.
//
// The legacy line-based renderer was retired in favour of one canonical
// path: the Ink TUI runs for every interactive `texra chat` invocation, and
// non-TTY callers are pointed at `texra run` (which is what they actually
// want for piping/scripting).

import { render } from 'ink';
import PQueue from 'p-queue';

import { loadAgents } from '@agent/index';
import { type AgentConfigPayload } from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import {
  interruptActiveChildren,
  killExecution,
} from '@agent/runtime/executionRegistry';
import { executeAgent } from '@agent/runtime/executeAgent';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { sendFollowUp } from '@agent/toolUse/ToolUseFollowUp';
import {
  getInterruptible,
  switchToolUseModel,
} from '@agent/toolUse/ToolUseAgentRegistry';
import { toErrorMessage } from '@common/errors/errorMessage';
import { STREAM_STATUS, type StreamTabId } from '@shared/schemas';

import { type CliContext, readCliVersion } from '../../runtime/cliContext';
import { hasCliApprovalDenied } from '../../runtime/approvalAdapter';
import {
  formatCliApiMode,
  getCliApiMode,
  parseCliApiMode,
  setCliApiMode,
  type CliApiMode,
} from '../../runtime/apiAccessMode';
import { resolveChatDefaults } from '../../runtime/chatDefaults';
import { CliExitCode } from '../../runtime/exitCodes';
import { initCliPlatform, setCliHelperModel } from '../../runtime/initPlatform';
import { createCliRuntimeHost } from '../../runtime/runtimeHost';
import { writeTextStderr } from '../../runtime/logSinks';
import { getCliAuthProfile } from '../../runtime/supabaseAuth';
import {
  CLI_APPROVAL_POLICIES,
  type CliApprovalPolicy,
} from '../../runtime/approvalPolicy';
import {
  formatCliHistoryText,
  listCliHistoryEntries,
  parseCliHistoryId,
  readCliHistoryConfig,
} from '../../runtime/history';
import { App } from './App';
import { ApiModeForm } from './forms/ApiModeForm';
import { renderHeaderBanner } from './panes/HeaderBanner';
import { registerBuiltinSlashCommands } from './commands/registerBuiltins';
import { listSlashCommands, parseSlashInput } from './commands/slashRegistry';
import { loadInputHistory } from './history/inputHistory';
import { notify } from './notifications/terminalNotifier';
import { clearApprovals } from './state/approvalQueue';
import { cliState, resetCliState } from './state/cliState';
import { installTuiApprovals } from './state/subscribeApprovals';
import { wrapRuntimeHost } from './state/subscribeRuntimeHost';
import { subscribeStreamLog, syncStreamLog } from './state/subscribeStreamLog';
import { subscribeStreamStatus } from './state/subscribeStreamStatus';
import { discoverTerminalCapabilities } from './state/terminalCapabilities';
import {
  appendAssistantTranscriptIfMissing,
  appendLocalAssistantTranscript,
  appendLocalErrorTranscript,
  clearActiveTranscript,
  moveLocalTranscriptToStream,
} from './state/transcript';
import { cleanupTerminalModes } from './terminalCleanup';

export interface ChatResult {
  exitCode: number;
}

export interface RunChatInit {
  /** `--agent` override from the CLI; falls through `resolveChatDefaults`. */
  readonly agentOverride?: string;
  /** `--model` override from the CLI; falls through `resolveChatDefaults`. */
  readonly modelOverride?: string;
}

interface TuiSession {
  streamId: StreamTabId | undefined;
  runPromise: Promise<void> | undefined;
  runExitCode: CliExitCode;
  runCompleted: boolean;
  stopRequested: boolean;
}

interface SlashCommandContext {
  readonly session: TuiSession;
  readonly initialAgent: string;
  readonly initialModel: string;
  readonly interruptActive: () => void;
  readonly requestInputExit: () => void;
  readonly getApprovalPolicy: () => CliApprovalPolicy;
  readonly setApprovalPolicy: (policy: CliApprovalPolicy) => void;
  readonly startStoredExecution: (config: AgentConfigPayload) => void;
  readonly runSessionMutation?: <T>(task: () => Promise<T>) => Promise<T>;
}

async function applyCliModelSelection(
  model: string,
  context: SlashCommandContext,
): Promise<void> {
  const nextModel = model.trim();
  if (!nextModel) {
    appendLocalAssistantTranscript('Usage: /model <name>');
    return;
  }

  try {
    if (!context.session.runPromise) {
      await setCliHelperModel(nextModel);
      cliState.sessionMeta.set({
        ...cliState.sessionMeta.get(),
        model: nextModel,
      });
      appendLocalAssistantTranscript(`Model set to ${nextModel}.`);
      return;
    }

    const switchActiveModel = async (): Promise<void> => {
      const streamId = context.session.streamId;
      const status = streamId ? StreamStatusService.get(streamId) : undefined;
      if (!streamId || status !== STREAM_STATUS.WAITING) {
        appendLocalAssistantTranscript(
          'The model can be changed while the chat is waiting for your next message.',
        );
        return;
      }
      const result = await switchToolUseModel(streamId, nextModel);
      if (result.status === 'no_session') {
        appendLocalAssistantTranscript(
          'The active chat is no longer available. Start a new chat to use that model.',
        );
        return;
      }
      await setCliHelperModel(nextModel);
      cliState.sessionMeta.set({
        ...cliState.sessionMeta.get(),
        model: nextModel,
      });
      appendLocalAssistantTranscript(`Model set to ${nextModel}.`);
    };

    if (context.runSessionMutation) {
      await context.runSessionMutation(switchActiveModel);
    } else {
      await switchActiveModel();
    }
  } catch (error: unknown) {
    appendLocalAssistantTranscript(toErrorMessage(error));
  }
}

async function applyCliApiModeSelection(
  mode: string | CliApiMode,
): Promise<void> {
  const normalized = mode.trim().toLowerCase();

  if (!normalized || normalized === 'status') {
    appendLocalAssistantTranscript(
      [
        `api: ${formatCliApiMode(getCliApiMode())}`,
        'Usage: /api personal | /api included',
      ].join('\n'),
    );
    return;
  }

  const apiMode = parseCliApiMode(normalized);
  if (apiMode) {
    await setCliApiMode(apiMode);
    cliState.sessionMeta.set({
      ...cliState.sessionMeta.get(),
      apiMode,
    });
    appendLocalAssistantTranscript(
      `API mode set to ${formatCliApiMode(apiMode)}.`,
    );
    return;
  }

  appendLocalAssistantTranscript('Usage: /api personal | /api included');
}

function openCliApiModeForm(
  onSelect: (mode: CliApiMode) => void | Promise<void>,
): void {
  cliState.activeForm.set({
    commandName: 'api',
    render: (close) => {
      const current = cliState.sessionMeta.get().apiMode;
      return (
        <ApiModeForm
          currentMode={current}
          onSelect={(value) => {
            void (async () => {
              try {
                await onSelect(value);
              } catch (error: unknown) {
                appendLocalAssistantTranscript(toErrorMessage(error));
              } finally {
                close();
              }
            })();
          }}
          onCancel={close}
        />
      );
    },
  });
}

async function showCliAuthStatus(): Promise<void> {
  const profile = await getCliAuthProfile();
  const lines = [
    `api: ${formatCliApiMode(getCliApiMode())}`,
    profile.authenticated
      ? `auth: signed in${profile.accountLabel ? ` as ${profile.accountLabel}` : ''}`
      : 'auth: signed out',
  ];
  if (profile.tier) lines.push(`tier: ${profile.tier}`);
  appendLocalAssistantTranscript(lines.join('\n'));
}

function formatApprovalPolicy(policy: CliApprovalPolicy): string {
  switch (policy) {
    case 'ask':
      return 'ask before privileged actions';
    case 'never':
      return 'deny privileged actions';
    case 'yolo':
      return 'approve privileged actions';
  }
}

function parseApprovalPolicy(input: string): CliApprovalPolicy | undefined {
  const normalized = input.trim().toLowerCase();
  if ((CLI_APPROVAL_POLICIES as readonly string[]).includes(normalized)) {
    return normalized as CliApprovalPolicy;
  }
  switch (normalized) {
    case 'default':
    case 'interactive':
    case 'on':
      return 'ask';
    case 'off':
    case 'deny':
      return 'never';
    case 'auto':
    case 'full':
    case 'danger':
      return 'yolo';
    default:
      return undefined;
  }
}

const APPROVAL_USAGE =
  'Usage: /approval ask | /approval never | /approval yolo';
const YOLO_USAGE = 'Usage: /yolo [ask | never | yolo]';

function applyCliApprovalPolicySelection(
  input: string,
  context: SlashCommandContext,
  usage = APPROVAL_USAGE,
): void {
  const normalized = input.trim().toLowerCase();
  if (!normalized || normalized === 'status') {
    appendLocalAssistantTranscript(
      [
        `approval: ${formatApprovalPolicy(context.getApprovalPolicy())}`,
        usage,
      ].join('\n'),
    );
    return;
  }

  const policy = parseApprovalPolicy(normalized);
  if (!policy) {
    appendLocalAssistantTranscript(usage);
    return;
  }

  context.setApprovalPolicy(policy);
  appendLocalAssistantTranscript(
    `Approval mode set to ${formatApprovalPolicy(policy)}.`,
  );
}

async function handleTuiSlashCommand(
  line: string,
  context: SlashCommandContext,
): Promise<boolean> {
  const parsed = parseSlashInput(line);
  if (!parsed) return false;

  const command = parsed.name.toLowerCase();
  const rest = parsed.remainder.trim();
  switch (command) {
    case 'help': {
      const commands = listSlashCommands()
        .map((cmd) => `/${cmd.name} - ${cmd.description}`)
        .join('\n');
      appendLocalAssistantTranscript(commands);
      return true;
    }
    case 'clear':
      clearActiveTranscript();
      return true;
    case 'exit':
    case 'quit':
      context.session.stopRequested = true;
      context.interruptActive();
      context.requestInputExit();
      return true;
    case 'agent':
      if (context.session.runPromise) {
        appendLocalAssistantTranscript(
          'The agent is fixed for this chat session. Start a new chat to use a different agent.',
        );
      } else if (rest) {
        cliState.sessionMeta.set({
          ...cliState.sessionMeta.get(),
          agent: rest,
        });
        appendLocalAssistantTranscript(`Agent set to ${rest}.`);
      } else {
        appendLocalAssistantTranscript('Usage: /agent <name>');
      }
      return true;
    case 'model':
      await applyCliModelSelection(rest, context);
      return true;
    case 'api':
      if (!rest) {
        openCliApiModeForm(applyCliApiModeSelection);
        return true;
      }
      try {
        await applyCliApiModeSelection(rest);
      } catch (error: unknown) {
        appendLocalAssistantTranscript(toErrorMessage(error));
      }
      return true;
    case 'auth':
      try {
        await showCliAuthStatus();
      } catch (error: unknown) {
        appendLocalAssistantTranscript(toErrorMessage(error));
      }
      return true;
    case 'approval':
      applyCliApprovalPolicySelection(rest, context);
      return true;
    case 'yolo':
      applyCliApprovalPolicySelection(rest || 'yolo', context, YOLO_USAGE);
      return true;
    case 'status': {
      const meta = cliState.sessionMeta.get();
      const activeStreamId = cliState.activeStreamId.get();
      const slice = activeStreamId
        ? cliState.streams.get().get(activeStreamId)
        : undefined;
      appendLocalAssistantTranscript(
        [
          `agent: ${meta.agent || context.initialAgent}`,
          `model: ${meta.model || context.initialModel}`,
          `api: ${formatCliApiMode(getCliApiMode())}`,
          `approval: ${formatApprovalPolicy(context.getApprovalPolicy())}`,
          `status: ${slice?.status ?? 'not started'}`,
        ].join('\n'),
      );
      return true;
    }
    case 'resume': {
      if (!rest) {
        const entries = (await listCliHistoryEntries()).slice(0, 20);
        appendLocalAssistantTranscript(
          entries.length
            ? [
                'Recent executions:',
                formatCliHistoryText(entries),
                '',
                'Usage: /resume <id>',
              ].join('\n')
            : 'No execution history found.',
        );
        return true;
      }
      const id = parseCliHistoryId(rest);
      if (!id) {
        appendLocalAssistantTranscript(`Invalid execution id: ${rest}`);
        return true;
      }
      if (context.session.runPromise) {
        appendLocalAssistantTranscript(
          'Finish the active chat before resuming a stored execution.',
        );
        return true;
      }
      const config = await readCliHistoryConfig(id);
      if (!config) {
        appendLocalAssistantTranscript(`Execution not found: ${id}`);
        return true;
      }
      context.startStoredExecution(config);
      appendLocalAssistantTranscript(`Resuming execution ${id}.`);
      return true;
    }
    default: {
      const registered = listSlashCommands().find(
        (cmd) =>
          cmd.name.toLowerCase() === command ||
          cmd.aliases?.some((alias) => alias.toLowerCase() === command) ===
            true,
      );
      if (registered) {
        appendLocalAssistantTranscript(
          `/${parsed.name} is registered but is not available in this CLI view yet.`,
        );
      } else {
        appendLocalAssistantTranscript(`Unknown command: /${parsed.name}`);
      }
      return true;
    }
  }
}

export async function runChat(
  context: CliContext,
  init: RunChatInit,
): Promise<ChatResult> {
  // `mode === 'headless'` already covers --print / CI / non-TTY stdin
  // (see cliContext.cliMode); stdout must also be a TTY for Ink to render,
  // and `TERM=dumb` strips the cursor controls Ink depends on (Ink would
  // mount and emit garbled output instead of a usable session).
  const isHeadless = context.mode === 'headless' || !process.stdout.isTTY;
  const dumbTerm = process.env.TERM === 'dumb';
  const clearItermProgress = process.env.TERM_PROGRAM === 'iTerm.app';
  if (isHeadless || dumbTerm) {
    // Headless precedence: in CI (headless + TERM=dumb often co-occur) the
    // actionable advice is "use `texra run`", not "fix your TERM".
    writeTextStderr(
      isHeadless
        ? 'texra chat requires an interactive terminal (TTY stdin and stdout). For scripting, --print, or piped output, use `texra run`.'
        : 'texra chat needs a capable terminal — TERM=dumb strips the cursor controls Ink uses. For non-interactive runs, use `texra run`.',
    );
    return { exitCode: CliExitCode.Usage };
  }

  await initCliPlatform({ ...context, quietLogs: true });
  const defaults = await resolveChatDefaults({
    cwd: context.cwd,
    agentOverride: init.agentOverride,
    modelOverride: init.modelOverride,
    envAgent: context.envAgent,
    envModel: context.envModel,
    workspaceConfig: context.cliConfig,
  });
  const { agent, model } = defaults;
  await setCliHelperModel(model);

  cliState.sessionMeta.set({
    agent,
    model,
    cwd: context.cwd,
    apiMode: getCliApiMode(),
  });

  let activeApprovalPolicy = context.approvalPolicy;
  const currentSessionContext = (helperModel: string): CliContext => ({
    ...context,
    get approvalPolicy(): CliApprovalPolicy {
      return activeApprovalPolicy;
    },
    helperModel,
    quietLogs: true,
  });
  const getApprovalPolicy = (): CliApprovalPolicy => activeApprovalPolicy;
  const setApprovalPolicy = (policy: CliApprovalPolicy): void => {
    activeApprovalPolicy = policy;
  };
  await loadAgents();

  const inputHistory = await loadInputHistory();

  // DA1 sentinel discovery runs *before* Ink mounts so it owns the raw-mode
  // toggle exclusively — interleaving with Ink's own raw-mode lifecycle (set
  // when `useInput` mounts) caused capability discovery to flip raw mode off
  // ~250ms in, breaking input. Capability-gated notifications fall back to
  // BEL during this window (~250ms typical, hard 250ms cap on no DA1 reply).
  await discoverTerminalCapabilities({
    stdin: process.stdin,
    stdout: process.stdout,
  });

  const disposers: Array<() => void> = [];
  disposers.push(subscribeStreamLog());
  disposers.push(subscribeStreamStatus());

  const session: TuiSession = {
    streamId: undefined,
    runPromise: undefined,
    runExitCode: CliExitCode.Success,
    runCompleted: false,
    stopRequested: false,
  };

  const followUpQueue = new PQueue({ concurrency: 1 });
  const runSessionMutation = async <T,>(task: () => Promise<T>): Promise<T> =>
    followUpQueue.add(task);
  let requestInputExit: (() => void) | undefined;

  const interruptActive = (): void => {
    clearApprovals();
    if (!session.streamId) return;
    interruptActiveChildren(session.streamId);
    getInterruptible(session.streamId)?.interrupt();
  };

  const startAgentRun = (config: AgentConfigPayload): void => {
    const currentModel = config.model;
    const sessionContext = currentSessionContext(currentModel);
    cliState.sessionMeta.set({
      ...cliState.sessionMeta.get(),
      agent: config.agent,
      model: config.model,
    });
    const runtimeHost = createCliRuntimeHost(sessionContext);
    const wrapped = wrapRuntimeHost(runtimeHost);
    const unbindApprovals = installTuiApprovals(wrapped, sessionContext);
    disposers.push(unbindApprovals);

    session.runPromise = setCliHelperModel(currentModel)
      .then(() =>
        executeAgent(config, undefined, {
          runtimeHost: wrapped,
          enforceCategory: true,
          onStreamResolved: (resolvedStreamId) => {
            session.streamId = resolvedStreamId;
            moveLocalTranscriptToStream(resolvedStreamId);
            cliState.activeStreamId.set(resolvedStreamId);
            if (session.stopRequested) interruptActive();
          },
        }),
      )
      .then((result) => {
        if (session.stopRequested || result.status !== 'error') {
          session.runExitCode = CliExitCode.Success;
        } else if (hasCliApprovalDenied(sessionContext)) {
          session.runExitCode = CliExitCode.ApprovalDenied;
        } else {
          session.runExitCode = CliExitCode.AgentError;
        }
        // Pull any final MODEL_RESPONSE chunks out of the AgentLogger
        // buffer before falling back to `result.lastResponse`. Without
        // this, a reply that finalized between sync ticks would never
        // hit the transcript.
        if (result.streamId) syncStreamLog(result.streamId);
        if (result.category === AgentCategory.ToolUse) {
          appendAssistantTranscriptIfMissing(
            result.streamId,
            result.lastResponse,
            `final:${result.executionId}`,
          );
        }
        notify({ kind: 'agentFinished' });
      })
      .catch((error: unknown) => {
        if (!session.stopRequested) {
          // Ink owns stdout while the TUI is mounted, so writing to
          // stderr disappears under the alternate screen. Surface the
          // failure inline so the user sees why the agent stopped.
          appendLocalErrorTranscript(toErrorMessage(error));
        }
        session.runExitCode = session.stopRequested
          ? CliExitCode.Success
          : CliExitCode.AgentError;
      })
      .finally(() => {
        session.runCompleted = true;
        void runtimeHost.close();
      });
  };

  // Pre-register the slash commands the input palette uses.
  registerBuiltinSlashCommands({
    onModelSelect: (nextModel) =>
      applyCliModelSelection(nextModel, {
        session,
        initialAgent: agent,
        initialModel: model,
        interruptActive,
        requestInputExit: () => requestInputExit?.(),
        getApprovalPolicy,
        setApprovalPolicy,
        startStoredExecution: (config) => startAgentRun(config),
        runSessionMutation,
      }),
    onApiModeSelect: (nextMode) => applyCliApiModeSelection(nextMode),
  });

  const startSession = (instruction: string): void => {
    const meta = cliState.sessionMeta.get();
    const currentAgent = meta.agent || agent;
    const currentModel = meta.model || model;
    startAgentRun({
      agent: currentAgent,
      model: currentModel,
      instruction,
      agentCategory: AgentCategory.ToolUse,
      workingDirectory: context.cwd,
    });
  };

  const handleSubmit = (line: string): void => {
    void handleSubmittedLine(line);
  };

  const handleSubmittedLine = async (line: string): Promise<void> => {
    if (
      await handleTuiSlashCommand(line, {
        session,
        initialAgent: agent,
        initialModel: model,
        interruptActive,
        requestInputExit: () => requestInputExit?.(),
        getApprovalPolicy,
        setApprovalPolicy,
        startStoredExecution: (config) => startAgentRun(config),
        runSessionMutation,
      })
    ) {
      return;
    }
    if (!session.runPromise) {
      startSession(line);
      return;
    }
    // PRD success criterion: follow-ups must not be silently dropped when the
    // user submits before `onStreamResolved` populates `session.streamId`.
    // p-queue serializes work but doesn't have an "await predicate" primitive,
    // so the task itself waits for the stream id via a tiny poll loop.
    void followUpQueue.add(async () => {
      while (
        session.streamId === undefined &&
        !session.stopRequested &&
        !session.runCompleted
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      if (!session.streamId || session.stopRequested) return;
      const result = await sendFollowUp(session.streamId, line);
      if (result.status === 'no_session') {
        session.stopRequested = true;
      }
    });
  };

  const version = await readCliVersion();
  process.stdout.write(
    renderHeaderBanner({ version, agent, model, cwd: context.cwd }),
  );
  const ink = render(
    <App
      onSubmit={handleSubmit}
      onKillExecution={(executionId) => {
        clearApprovals();
        killExecution(executionId);
      }}
      history={inputHistory}
    />,
    {
      stdout: process.stdout,
      stderr: process.stderr,
      stdin: process.stdin,
    },
  );

  let pendingExitTimer: ReturnType<typeof setTimeout> | undefined;
  let exitArmed = false;
  const clearPendingExit = (): void => {
    if (pendingExitTimer) clearTimeout(pendingExitTimer);
    pendingExitTimer = undefined;
    exitArmed = false;
    cliState.pendingExitHint.set(false);
  };
  const removeProcessHandlers = (): void => {
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);
    process.off('SIGHUP', handleSighup);
  };
  const exitNow = (exitCode: number): void => {
    removeProcessHandlers();
    clearPendingExit();
    ink.unmount();
    cleanupTerminalModes({ clearItermProgress });
    process.exit(exitCode);
  };
  const armExit = (): void => {
    exitArmed = true;
    cliState.pendingExitHint.set(true);
    if (pendingExitTimer) clearTimeout(pendingExitTimer);
    pendingExitTimer = setTimeout(clearPendingExit, 800);
  };
  const handleSigint = (): void => {
    if (exitArmed) {
      exitNow(130);
      return;
    }
    session.stopRequested = true;
    interruptActive();
    armExit();
  };
  const handleSigterm = (): void => {
    session.stopRequested = true;
    interruptActive();
    exitNow(143);
  };
  const handleSighup = (): void => {
    session.stopRequested = true;
    interruptActive();
    exitNow(129);
  };
  requestInputExit = () => {
    removeProcessHandlers();
    clearPendingExit();
    ink.unmount();
  };
  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', handleSigterm);
  process.on('SIGHUP', handleSighup);

  // Auto-prompt when the active stream goes WAITING so the UI clearly
  // signals "your turn." Combined with the StatusBar pill, this replaces
  // the legacy reader.prompt() ergonomics.
  disposers.push(
    StreamStatusService.onDidChange((change) => {
      if (
        change.streamId === session.streamId &&
        change.status === STREAM_STATUS.WAITING &&
        !session.stopRequested
      ) {
        notify({ kind: 'agentFinished' });
      }
    }),
  );

  try {
    await ink.waitUntilExit();
  } finally {
    removeProcessHandlers();
    clearPendingExit();
    for (const dispose of disposers) dispose();
    await followUpQueue.onIdle();
    if (session.runPromise && !session.runCompleted) {
      session.stopRequested = true;
      interruptActive();
    }
    await session.runPromise;
    resetCliState();
    cleanupTerminalModes({ clearItermProgress });
  }
  return { exitCode: session.runExitCode };
}
