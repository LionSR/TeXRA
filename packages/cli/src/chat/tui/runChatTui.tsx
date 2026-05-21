// `texra chat` entry point — single Ink-based session.
//
// The legacy line-based renderer was retired in favour of one canonical
// path: the Ink TUI runs for every interactive `texra chat` invocation, and
// non-TTY callers are pointed at `texra run` (which is what they actually
// want for piping/scripting).

import { render } from 'ink';
import PQueue from 'p-queue';

import { getAgent, loadAgents } from '@agent/index';
import { type AgentConfigPayload } from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import {
  interruptActiveChildren,
  killExecution,
} from '@agent/runtime/executionRegistry';
import { executeAgent } from '@agent/runtime/executeAgent';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import {
  notifyFollowUpSent,
  sendFollowUp,
} from '@agent/toolUse/ToolUseFollowUp';
import {
  getInterruptible,
  getToolUseFlowContext,
} from '@agent/toolUse/ToolUseAgentRegistry';
import { toErrorMessage } from '@common/errors/errorMessage';
import { DELEGATION_TOOLS } from '@shared/constants/delegationTools';
import {
  STREAM_STATUS,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { loadMemoryItems } from '@tools/memory/memoryFileSystem';
import { generateExecutionId } from '@utils/core/executionId';

import { type CliContext, readCliVersion } from '../../runtime/cliContext';
import { hasCliApprovalDenied } from '../../runtime/approvalAdapter';
import {
  formatCliApiMode,
  getCliApiMode,
  parseCliApiMode,
  setCliApiMode,
  type CliApiMode,
} from '../../runtime/apiAccessMode';
import { loadCliApiStatusLines } from '../../runtime/apiStatus';
import { resolveChatDefaults } from '../../runtime/chatDefaults';
import { CliExitCode } from '../../runtime/exitCodes';
import { initCliPlatform, setCliHelperModel } from '../../runtime/initPlatform';
import { createCliRuntimeHost } from '../../runtime/runtimeHost';
import { writeTextStderr } from '../../runtime/logSinks';
import {
  CLI_APPROVAL_POLICIES,
  type CliApprovalPolicy,
} from '../../runtime/approvalPolicy';
import { parseCliHistoryId, readCliHistoryConfig } from '../../runtime/history';
import {
  formatCliMemoryList,
  formatCliMemoryPreview,
} from '../../runtime/memory';
import { App } from './App';
import { AgentListForm } from './forms/AgentListForm';
import { ApiModeForm } from './forms/ApiModeForm';
import {
  ApprovalPolicyForm,
  formatApprovalPolicyForCli as formatApprovalPolicy,
} from './forms/ApprovalPolicyForm';
import { MemoryListForm } from './forms/MemoryListForm';
import { ModelListForm } from './forms/ModelListForm';
import { ResumeListForm } from './forms/ResumeListForm';
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
import { requestCliCompaction } from './state/compactionRequest';
import {
  appendAssistantTranscriptIfMissing,
  appendLocalAssistantTranscript,
  appendLocalErrorTranscript,
  appendLocalUserTranscript,
  moveLocalTranscriptToStream,
} from './state/transcript';
import {
  cleanupTerminalModes,
  enterTerminalFullScreen,
} from './terminalCleanup';

export interface ChatResult {
  exitCode: number;
}

export interface RunChatInit {
  /** `--agent` override from the CLI; falls through `resolveChatDefaults`. */
  readonly agentOverride?: string;
  /** `--model` override from the CLI; falls through `resolveChatDefaults`. */
  readonly modelOverride?: string;
}

export interface ClearableTuiSessionState {
  streamId: StreamTabId | undefined;
  executionId: string | undefined;
  runPromise: Promise<void> | undefined;
  runExitCode: CliExitCode;
  runCompleted: boolean;
  stopRequested: boolean;
}

interface TuiSession extends ClearableTuiSessionState {}

export function clearTuiSessionRunState(
  session: ClearableTuiSessionState,
): void {
  session.streamId = undefined;
  session.executionId = undefined;
  session.runPromise = undefined;
  session.runExitCode = CliExitCode.Success;
  session.runCompleted = false;
  session.stopRequested = false;
}

export function chatTuiCanInterruptActiveRun(session: {
  readonly streamId: StreamTabId | undefined;
  readonly runPromise: Promise<unknown> | undefined;
  readonly runCompleted: boolean;
}): boolean {
  return Boolean(
    session.streamId && session.runPromise && !session.runCompleted,
  );
}

interface SlashCommandContext {
  readonly session: TuiSession;
  readonly initialAgent: string;
  readonly initialModel: string;
  readonly interruptActive: () => void;
  readonly requestInputExit: () => void;
  readonly getApprovalPolicy: () => CliApprovalPolicy;
  readonly setApprovalPolicy: (policy: CliApprovalPolicy) => void;
  readonly resetSession: () => void;
  readonly startStoredExecution: (config: AgentConfigPayload) => void;
}

function agentSupportsDelegation(agentName: string): boolean {
  return (
    getAgent(agentName, true)?.tools?.some((toolName) =>
      DELEGATION_TOOLS.has(toolName),
    ) ?? false
  );
}

function applyInitialCliAgentSelection(
  agentName: string,
  context: SlashCommandContext,
): void {
  if (context.session.runPromise) {
    appendLocalAssistantTranscript(
      'Agent changes are only available before the first message. Start a new chat with texra --agent=<name> to choose a different root agent.',
    );
    return;
  }

  const nextAgent = agentName.trim();
  cliState.sessionMeta.set({
    ...cliState.sessionMeta.get(),
    agent: nextAgent,
    canDelegate: agentSupportsDelegation(nextAgent),
  });
  appendLocalAssistantTranscript(`Root agent set to ${nextAgent}.`);
}

function openCliAgentListForm(context: SlashCommandContext): void {
  const selectable = !context.session.runPromise;
  cliState.activeForm.set({
    commandName: 'agent',
    render: (close, availableRows) => (
      <AgentListForm
        currentAgent={cliState.sessionMeta.get().agent}
        availableRows={availableRows}
        selectable={selectable}
        onSelect={(value) => {
          applyInitialCliAgentSelection(value, context);
          close();
        }}
        onClose={close}
      />
    ),
  });
}

async function applyInitialCliModelSelection(
  model: string,
  context: SlashCommandContext,
): Promise<void> {
  if (context.session.runPromise) {
    appendLocalAssistantTranscript(
      'Model changes are only available before the first message. Start a new chat with texra --model=<name> to choose a different root model.',
    );
    return;
  }
  const nextModel = model.trim();
  try {
    await setCliHelperModel(nextModel);
    cliState.sessionMeta.set({
      ...cliState.sessionMeta.get(),
      model: nextModel,
    });
    appendLocalAssistantTranscript(`Root model set to ${nextModel}.`);
  } catch (error: unknown) {
    appendLocalAssistantTranscript(toErrorMessage(error));
  }
}

function openCliModelListForm(context: SlashCommandContext): void {
  const selectable = !context.session.runPromise;
  cliState.activeForm.set({
    commandName: 'model',
    render: (close, availableRows) => (
      <ModelListForm
        currentModel={cliState.sessionMeta.get().model}
        apiMode={cliState.sessionMeta.get().apiMode}
        availableRows={availableRows}
        selectable={selectable}
        onSelect={(value) => {
          void applyInitialCliModelSelection(value, context).finally(close);
        }}
        onClose={close}
      />
    ),
  });
}

async function applyCliApiModeSelection(
  mode: string | CliApiMode,
): Promise<void> {
  const normalized = mode.trim().toLowerCase();

  if (!normalized || normalized === 'status') {
    const lines = await loadCliApiStatusLines();
    appendLocalAssistantTranscript(
      [...lines, 'Usage: /api personal | /api included'].join('\n'),
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
  appendLocalAssistantTranscript((await loadCliApiStatusLines()).join('\n'));
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

const YOLO_USAGE = 'Usage: /yolo [ask | never | yolo]';

function openCliApprovalPolicyForm(context: SlashCommandContext): void {
  cliState.activeForm.set({
    commandName: 'approval',
    render: (close) => (
      <ApprovalPolicyForm
        currentPolicy={context.getApprovalPolicy()}
        onSelect={(policy) => {
          context.setApprovalPolicy(policy);
          appendLocalAssistantTranscript(
            `Approval mode set to ${formatApprovalPolicy(policy)}.`,
          );
          close();
        }}
        onCancel={close}
      />
    ),
  });
}

function applyCliApprovalPolicySelection(
  input: string,
  context: SlashCommandContext,
  usage = YOLO_USAGE,
): void {
  const normalized = input.trim().toLowerCase();
  if (!normalized || normalized === 'status') {
    openCliApprovalPolicyForm(context);
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

async function resumeStoredExecution(
  id: ExecutionId,
  context: SlashCommandContext,
): Promise<void> {
  if (context.session.runPromise) {
    appendLocalAssistantTranscript(
      'Finish the active chat before resuming a stored execution.',
    );
    return;
  }
  const config = await readCliHistoryConfig(id);
  if (!config) {
    appendLocalAssistantTranscript(`Execution not found: ${id}`);
    return;
  }
  context.startStoredExecution(config);
  appendLocalAssistantTranscript(`Resuming execution ${id}.`);
}

function openCliResumeListForm(context: SlashCommandContext): void {
  cliState.activeForm.set({
    commandName: 'resume',
    render: (close, availableRows) => (
      <ResumeListForm
        availableRows={availableRows}
        onSelect={(id) => {
          close();
          void resumeStoredExecution(id, context).catch((error: unknown) => {
            appendLocalAssistantTranscript(toErrorMessage(error));
          });
        }}
        onClose={close}
      />
    ),
  });
}

async function showCliMemoryList(): Promise<void> {
  appendLocalAssistantTranscript(formatCliMemoryList(await loadMemoryItems()));
}

async function showCliMemoryPreview(inputPath: string): Promise<void> {
  appendLocalAssistantTranscript(await formatCliMemoryPreview(inputPath));
}

function openCliMemoryListForm(): void {
  cliState.activeForm.set({
    commandName: 'memory',
    render: (close, availableRows) => (
      <MemoryListForm
        availableRows={availableRows}
        onSelect={(storagePath) => {
          close();
          void showCliMemoryPreview(storagePath).catch((error: unknown) => {
            appendLocalAssistantTranscript(toErrorMessage(error));
          });
        }}
        onClose={close}
      />
    ),
  });
}

async function handleTuiSlashCommand(
  line: string,
  context: SlashCommandContext,
): Promise<boolean> {
  const parsed = parseSlashInput(line);
  if (!parsed) return false;

  const command = parsed.name.toLowerCase();
  const rest = parsed.remainder.trim();
  // Echo the slash input into the transcript so the user can see what they
  // typed. Slash commands don't go through the agent run, so the usual
  // USER_MESSAGE stream-log entry is never produced. Skip the echo for /clear
  // (it resets the transcript) and exits (the TUI is tearing down).
  if (command !== 'clear' && command !== 'exit' && command !== 'quit') {
    appendLocalUserTranscript(line.trim());
  }
  switch (command) {
    case 'help': {
      const commands = listSlashCommands()
        .map((cmd) => `/${cmd.name} - ${cmd.description}`)
        .join('\n');
      appendLocalAssistantTranscript(commands);
      return true;
    }
    case 'clear':
      context.resetSession();
      return true;
    case 'exit':
    case 'quit':
      context.session.stopRequested = true;
      context.interruptActive();
      context.requestInputExit();
      return true;
    case 'agent':
      if (context.session.runPromise && rest) {
        appendLocalAssistantTranscript(
          'The agent is fixed for this chat session. Start a new chat to use a different agent.',
        );
      } else if (rest) {
        applyInitialCliAgentSelection(rest, context);
      } else {
        openCliAgentListForm(context);
      }
      return true;
    case 'model':
      openCliModelListForm(context);
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
      if (rest) {
        applyCliApprovalPolicySelection(rest, context);
      } else {
        openCliApprovalPolicyForm(context);
      }
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
        openCliResumeListForm(context);
        return true;
      }
      const id = parseCliHistoryId(rest);
      if (!id) {
        appendLocalAssistantTranscript(`Invalid execution id: ${rest}`);
        return true;
      }
      await resumeStoredExecution(id, context);
      return true;
    }
    case 'memory': {
      try {
        if (!rest) {
          openCliMemoryListForm();
        } else if (rest.toLowerCase() === 'list') {
          await showCliMemoryList();
        } else {
          await showCliMemoryPreview(rest);
        }
      } catch (error: unknown) {
        appendLocalAssistantTranscript(toErrorMessage(error));
      }
      return true;
    }
    case 'compact':
      requestCliCompaction({
        streamId: cliState.activeStreamId.get(),
        getFlowContext: getToolUseFlowContext,
        notifyFollowUpSent,
        appendTranscript: appendLocalAssistantTranscript,
      });
      return true;
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
  });
  const { agent, model } = defaults;
  await setCliHelperModel(model);
  const version = await readCliVersion();

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
  cliState.sessionMeta.set({
    agent,
    model,
    cwd: context.cwd,
    apiMode: getCliApiMode(),
    canDelegate: agentSupportsDelegation(agent),
    version,
  });

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
    executionId: undefined,
    runPromise: undefined,
    runExitCode: CliExitCode.Success,
    runCompleted: false,
    stopRequested: false,
  };

  const followUpQueue = new PQueue({ concurrency: 1 });
  let requestInputExit: (() => void) | undefined;

  const interruptActive = (): void => {
    clearApprovals();
    if (!session.streamId) return;
    interruptActiveChildren(session.streamId);
    getInterruptible(session.streamId)?.interrupt();
  };

  const resetSessionForClear = (): void => {
    const activeStreamId = session.streamId ?? cliState.activeStreamId.get();
    const activeStatus = activeStreamId
      ? (cliState.streams.get().get(activeStreamId)?.status ??
        StreamStatusService.get(activeStreamId))
      : undefined;
    const isRunPending = Boolean(session.runPromise && !session.runCompleted);

    if (
      (isRunPending && activeStatus !== STREAM_STATUS.WAITING) ||
      activeStatus === STREAM_STATUS.INITIALIZING ||
      activeStatus === STREAM_STATUS.RUNNING ||
      activeStatus === STREAM_STATUS.RESUMING
    ) {
      appendLocalAssistantTranscript(
        'Wait for the active response to finish, or press Ctrl-C before /clear.',
      );
      return;
    }

    const meta = cliState.sessionMeta.get();
    if (isRunPending) interruptActive();
    clearApprovals();
    followUpQueue.clear();
    clearTuiSessionRunState(session);
    resetCliState(meta);
  };

  const startAgentRun = (config: AgentConfigPayload): void => {
    const currentModel = config.model;
    const sessionContext = currentSessionContext(currentModel);
    cliState.sessionMeta.set({
      ...cliState.sessionMeta.get(),
      agent: config.agent,
      model: config.model,
      canDelegate: agentSupportsDelegation(config.agent),
    });
    const runtimeHost = createCliRuntimeHost(sessionContext);
    const wrapped = wrapRuntimeHost(runtimeHost);
    const unbindApprovals = installTuiApprovals(wrapped, sessionContext);
    disposers.push(unbindApprovals);
    const executionId = generateExecutionId();
    session.executionId = executionId;

    session.runPromise = setCliHelperModel(currentModel)
      .then(() =>
        executeAgent(config, executionId, {
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
    canSelectAgent: () => !session.runPromise,
    onAgentSelect: (nextAgent) =>
      applyInitialCliAgentSelection(nextAgent, {
        session,
        initialAgent: agent,
        initialModel: model,
        interruptActive,
        requestInputExit: () => requestInputExit?.(),
        getApprovalPolicy,
        setApprovalPolicy,
        resetSession: resetSessionForClear,
        startStoredExecution: startAgentRun,
      }),
    getApprovalPolicy,
    onApprovalPolicySelect: (policy) => {
      setApprovalPolicy(policy);
      appendLocalAssistantTranscript(
        `Approval mode set to ${formatApprovalPolicy(policy)}.`,
      );
    },
    canSelectModel: () => !session.runPromise,
    onModelSelect: (nextModel) =>
      applyInitialCliModelSelection(nextModel, {
        session,
        initialAgent: agent,
        initialModel: model,
        interruptActive,
        requestInputExit: () => requestInputExit?.(),
        getApprovalPolicy,
        setApprovalPolicy,
        resetSession: resetSessionForClear,
        startStoredExecution: startAgentRun,
      }),
    onApiModeSelect: applyCliApiModeSelection,
    onMemorySelect: showCliMemoryPreview,
    onMemoryError: (error) => {
      appendLocalAssistantTranscript(toErrorMessage(error));
    },
    onResumeSelect: (id) =>
      resumeStoredExecution(id, {
        session,
        initialAgent: agent,
        initialModel: model,
        interruptActive,
        requestInputExit: () => requestInputExit?.(),
        getApprovalPolicy,
        setApprovalPolicy,
        resetSession: resetSessionForClear,
        startStoredExecution: startAgentRun,
      }),
    onResumeError: (error) => {
      appendLocalAssistantTranscript(toErrorMessage(error));
    },
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
        resetSession: resetSessionForClear,
        startStoredExecution: startAgentRun,
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

  enterTerminalFullScreen();
  const ink = render(
    <App
      onSubmit={handleSubmit}
      canInterruptActiveRun={() => chatTuiCanInterruptActiveRun(session)}
      onInterruptActive={interruptActive}
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
    cliState.pendingExitResumeId.set(undefined);
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
    cliState.pendingExitResumeId.set(session.executionId);
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
