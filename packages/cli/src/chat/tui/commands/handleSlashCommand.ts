import { getAgent } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { executionRegistry } from '@agent/runtime/executionRegistry';
import { notifyFollowUpSent } from '@agent/toolUse/ToolUseFollowUp';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import {
  formatCliApiMode,
  parseCliApiMode,
  setCliApiMode,
  type CliApiMode,
} from '@cli/runtime/apiAccessMode';
import { loadCliApiStatusLines } from '@cli/runtime/apiStatus';
import { assertCliAgentLaunch } from '@cli/runtime/agents';
import { type CliContext, CliUsageError } from '@cli/runtime/cliContext';
import { setCliHelperModel } from '@cli/runtime/initPlatform';
import {
  githubSelectAccountWarning,
  parseChatLoginSlashArgs,
  type CliLoginSlashArgs,
} from '@cli/runtime/loginOptions';
import {
  formatCliMemoryList,
  formatCliMemoryPreview,
} from '@cli/runtime/memory';
import {
  formatCliNoAvailableModelsRecovery,
  resolveCliRunnableModel,
  type CliNoAvailableModelsRecoveryOptions,
} from '@cli/runtime/modelAccess';
import {
  formatCliApprovalPolicy,
  parseCliApprovalPolicy,
} from '@cli/runtime/approvalPolicyText';
import { parseCliHistoryId } from '@cli/runtime/history';
import { defaultShortcutModifierLabel } from '@cli/runtime/shortcutLabels';
import {
  formatCliManualAuthUrlMessage,
  relayTokenStillActiveNotice,
  signInCliSupabase,
  signInCliSupabaseDeviceCode,
  signOutCliSupabase,
} from '@cli/runtime/supabaseAuth';
import { formatCliDeviceAuthMessage } from '@cli/runtime/supabaseAuthDeviceCode';
import type { CliApprovalPolicy } from '@cli/schemas/cliSettings';
import { toErrorMessage } from '@common/errors/errorMessage';
import { type ExecutionId } from '@shared/schemas';
import { DELEGATION_TOOLS } from '@shared/constants/delegationTools';
import { GoalStore } from '@tools/goal';
import { loadMemoryItems } from '@tools/memory/memoryFileSystem';

import { formatCliSessionStatus } from '../sessionStatus';
import { requestCliCompaction } from '../state/compactionRequest';
import { cliState, setCliSessionModelOverride } from '../state/cliState';
import {
  chatTuiCanStartRootRun,
  type TuiSession,
} from '../state/sessionRunState';
import { terminalCapabilities } from '../state/terminalCapabilities';
import {
  appendLocalAssistantTranscript,
  appendLocalUserTranscript,
} from '../state/transcript';
import { formatSlashCommandHelp, GOAL_MODE_HELP } from './helpText';
import {
  openCliSlashCommandForm,
  openRegisteredCliSlashForm,
} from './slashForms';
import {
  findSlashCommand,
  listSlashCommands,
  parseSlashInput,
  suggestSlashCommand,
} from './slashRegistry';

export interface SlashCommandContext {
  readonly session: TuiSession;
  readonly commandName?: string;
  readonly cwd: CliContext['cwd'];
  readonly initialAgent: string;
  readonly initialModel: string;
  readonly interruptActive: () => void;
  readonly requestInputExit: () => void;
  readonly getApprovalPolicy: () => CliApprovalPolicy;
  readonly setApprovalPolicy: (policy: CliApprovalPolicy) => void;
  readonly canSelectModel: () => boolean;
  readonly resetSession: () => void;
  readonly resumeExecution: (id: ExecutionId) => Promise<void>;
}

export const CHAT_API_MODE_MODEL_RECOVERY = {
  includedModeAction: 'switch to included relay with `/api included`',
  loginAction: 'run `/login`',
  personalModeAction: 'switch to personal API keys with `/api personal`',
  configureKeyAction: 'configure a provider API key',
} satisfies CliNoAvailableModelsRecoveryOptions;

export function chatAgentSupportsDelegation(agentName: string): boolean {
  return (
    getAgent(agentName, AgentCategory.ToolUse)?.tools?.some((toolName) =>
      DELEGATION_TOOLS.has(toolName),
    ) ?? false
  );
}

export function chatToolUseAgentUsageError(
  agentName: string,
): string | undefined {
  try {
    assertCliAgentLaunch(
      agentName,
      getAgent(agentName, AgentCategory.ToolUse),
      'chat',
    );
    return undefined;
  } catch (error) {
    if (error instanceof CliUsageError) return error.message;
    throw error;
  }
}

export function applyInitialCliAgentSelection(
  agentName: string,
  context: SlashCommandContext,
): void {
  if (!chatTuiCanStartRootRun(context.session)) {
    appendLocalAssistantTranscript(
      'Agent changes are only available before the first message. Start a new chat with texra chat --agent=<name> to choose a different root agent.',
    );
    return;
  }

  const nextAgent = agentName.trim();
  const usageError = chatToolUseAgentUsageError(nextAgent);
  if (usageError) {
    appendLocalAssistantTranscript(usageError);
    return;
  }
  cliState.sessionMeta.set({
    ...cliState.sessionMeta.get(),
    agent: nextAgent,
    canDelegate: chatAgentSupportsDelegation(nextAgent),
  });
  appendLocalAssistantTranscript(`Root agent set to ${nextAgent}.`);
}

export async function applyCliModelSelection(
  model: string,
  context: SlashCommandContext,
): Promise<void> {
  const nextModel = model.trim();
  if (chatTuiCanStartRootRun(context.session)) {
    try {
      await setCliHelperModel(nextModel);
      setCliSessionModelOverride(nextModel);
      appendLocalAssistantTranscript(`Root model set to ${nextModel}.`);
    } catch (error: unknown) {
      appendLocalAssistantTranscript(toErrorMessage(error));
    }
    return;
  }

  if (!context.canSelectModel()) {
    appendLocalAssistantTranscript(
      'Finish the active response before switching models.',
    );
    return;
  }

  const activeFlow = context.session.streamId
    ? executionRegistry.getToolUseFlowContext(context.session.streamId)
    : undefined;
  if (!activeFlow) {
    appendLocalAssistantTranscript(
      'Model switching is only available for an active tool-use chat. Start a new chat with texra chat --model=<name> to choose a different root model.',
    );
    return;
  }

  try {
    await activeFlow.switchModel(nextModel);
    setCliSessionModelOverride(nextModel);
  } catch (error: unknown) {
    appendLocalAssistantTranscript(toErrorMessage(error));
    return;
  }

  try {
    await setCliHelperModel(nextModel);
  } catch (error: unknown) {
    appendLocalAssistantTranscript(
      `Model switched to ${nextModel}. Could not persist it as the default helper model: ${toErrorMessage(error)}`,
    );
    return;
  }

  appendLocalAssistantTranscript(
    `Model switched to ${nextModel}. Future turns will use it.`,
  );
}

async function reconcileRootModelAfterApiModeChange(
  context: SlashCommandContext | undefined,
  apiMode: CliApiMode,
): Promise<string | undefined> {
  if (!context || !chatTuiCanStartRootRun(context.session)) return undefined;

  const { model: currentModel, modelSource } = cliState.sessionMeta.get();
  const selection = await resolveCliRunnableModel(currentModel, {
    fallbackSource: modelSource,
    apiMode,
    noAvailableModelsMessage: formatCliNoAvailableModelsRecovery(
      apiMode,
      CHAT_API_MODE_MODEL_RECOVERY,
    ),
  });
  if (selection.model === currentModel) return undefined;

  await setCliHelperModel(selection.model);
  cliState.sessionMeta.set({
    ...cliState.sessionMeta.get(),
    model: selection.model,
  });
  return selection.notice;
}

function setCliSessionApiMode(apiMode: CliApiMode): void {
  cliState.sessionMeta.set({
    ...cliState.sessionMeta.get(),
    apiMode,
  });
}

export async function applyCliApiModeSelection(
  mode: string | CliApiMode,
  context?: SlashCommandContext,
): Promise<void> {
  const normalized = mode.trim().toLowerCase();

  if (!normalized || normalized === 'status') {
    const lines = await loadCliApiStatusLines({
      apiMode: cliState.sessionMeta.get().apiMode,
    });
    appendLocalAssistantTranscript(
      [...lines, 'Usage: /api personal | /api included'].join('\n'),
    );
    return;
  }

  const apiMode = parseCliApiMode(normalized);
  if (apiMode) {
    await setCliApiMode(apiMode);
    setCliSessionApiMode(apiMode);
    let modelNotice: string | undefined;
    try {
      modelNotice = await reconcileRootModelAfterApiModeChange(
        context,
        apiMode,
      );
    } catch (error: unknown) {
      modelNotice = toErrorMessage(error);
    }
    appendLocalAssistantTranscript(
      [
        `API mode set to ${formatCliApiMode(apiMode)}.`,
        ...(modelNotice ? [modelNotice] : []),
      ].join('\n'),
    );
    return;
  }

  appendLocalAssistantTranscript('Usage: /api personal | /api included');
}

async function showCliAuthStatus(): Promise<void> {
  appendLocalAssistantTranscript(
    (
      await loadCliApiStatusLines({
        apiMode: cliState.sessionMeta.get().apiMode,
      })
    ).join('\n'),
  );
}

const CHAT_LOGIN_USAGE =
  'Usage: /login [github | google] [--no-browser] [--device] [--select-account] [--login-hint <account>]';

function loginStartMessage(args: CliLoginSlashArgs): string {
  if (args.device) return 'Starting TeXRA device-code sign-in.';
  if (args.noBrowser) return `Starting TeXRA ${args.provider} sign-in.`;
  return `Opening browser for TeXRA ${args.provider} sign-in...`;
}

async function loginFromChat(input: string): Promise<void> {
  const args = parseChatLoginSlashArgs(input);
  if (!args) {
    appendLocalAssistantTranscript(CHAT_LOGIN_USAGE);
    return;
  }

  const accountWarning = githubSelectAccountWarning(args);
  if (accountWarning) appendLocalAssistantTranscript(accountWarning);
  appendLocalAssistantTranscript(loginStartMessage(args));

  try {
    const session = args.device
      ? await signInCliSupabaseDeviceCode({
          onDeviceCode: (authorization) => {
            appendLocalAssistantTranscript(
              formatCliDeviceAuthMessage(authorization),
            );
          },
        })
      : await signInCliSupabase({
          provider: args.provider,
          openBrowser: !args.noBrowser,
          selectAccount: args.selectAccount,
          loginHint: args.loginHint,
          manualBrowserHint: '/login --no-browser',
          onAuthUrl: (url) => {
            if (args.noBrowser) {
              appendLocalAssistantTranscript(
                formatCliManualAuthUrlMessage(url),
              );
            }
          },
        });
    setCliSessionApiMode('included');
    appendLocalAssistantTranscript(
      [
        `Signed in as ${session.account.label}.`,
        ...(await loadCliApiStatusLines({ apiMode: 'included' })),
      ].join('\n'),
    );
  } catch (error: unknown) {
    appendLocalAssistantTranscript(toErrorMessage(error));
  }
}

async function logoutFromChat(): Promise<void> {
  try {
    await signOutCliSupabase();
    // Sign-out only clears the stored session; a configured TEXRA_RELAY_TOKEN
    // keeps authenticating relay calls, so report it — and keep the session
    // in included mode so the notice matches what actually happens.
    const relayNotice = relayTokenStillActiveNotice();
    const apiMode = relayNotice ? 'included' : 'personal';
    setCliSessionApiMode(apiMode);
    appendLocalAssistantTranscript(
      [
        'Signed out.',
        ...(relayNotice ? [relayNotice] : []),
        ...(await loadCliApiStatusLines({ apiMode })),
      ].join('\n'),
    );
  } catch (error: unknown) {
    appendLocalAssistantTranscript(toErrorMessage(error));
  }
}

const YOLO_USAGE = 'Usage: /yolo [ask | never | yolo]';

function applyCliApprovalPolicySelection(
  input: string,
  context: SlashCommandContext,
  usage = YOLO_USAGE,
): void {
  const normalized = input.trim().toLowerCase();
  if (!normalized || normalized === 'status') {
    openCliSlashCommandForm('approval', '');
    return;
  }

  const policy = parseCliApprovalPolicy(normalized);
  if (!policy) {
    appendLocalAssistantTranscript(usage);
    return;
  }

  context.setApprovalPolicy(policy);
  appendLocalAssistantTranscript(
    `Approval mode set to ${formatCliApprovalPolicy(policy)}.`,
  );
}

async function showCliMemoryList(): Promise<void> {
  appendLocalAssistantTranscript(formatCliMemoryList(await loadMemoryItems()));
}

export async function showCliMemoryPreview(inputPath: string): Promise<void> {
  appendLocalAssistantTranscript(await formatCliMemoryPreview(inputPath));
}

export async function handleTuiSlashCommand(
  line: string,
  context: SlashCommandContext,
): Promise<boolean> {
  const parsed = parseSlashInput(line);
  if (!parsed) return false;

  const command = parsed.name.toLowerCase();
  const rest = parsed.remainder.trim();
  // Echo the slash input into the transcript so the user can see what they
  // typed. Slash commands don't go through the agent run, so the usual
  // USER_MESSAGE stream-log entry is never produced. Skip the echo for the
  // exit commands (the TUI is tearing down); /clear still echoes because
  // resetSessionForClear refuses while a run is active and surfaces an
  // error — without the echo the user wouldn't see what triggered it.
  if (command !== 'exit' && command !== 'quit' && command !== 'login') {
    appendLocalUserTranscript(line.trim());
  }
  switch (command) {
    case 'help': {
      appendLocalAssistantTranscript(
        formatSlashCommandHelp(listSlashCommands(), {
          shortcutModifierLabel: defaultShortcutModifierLabel(),
          shiftEnterNewline: terminalCapabilities.get().kittyKeyboard,
        }),
      );
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
    case 'agents':
      if (!chatTuiCanStartRootRun(context.session) && rest) {
        appendLocalAssistantTranscript(
          'The agent is fixed for this chat session. Start a new chat to use a different agent.',
        );
      } else if (rest) {
        applyInitialCliAgentSelection(rest, context);
      } else {
        openCliSlashCommandForm('agent', rest);
      }
      return true;
    case 'model':
    case 'models':
      openCliSlashCommandForm('model', rest);
      return true;
    case 'api':
      if (!rest) {
        openCliSlashCommandForm('api', rest);
        return true;
      }
      try {
        await applyCliApiModeSelection(rest, context);
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
    case 'login':
      await loginFromChat(rest);
      return true;
    case 'logout':
      await logoutFromChat();
      return true;
    case 'approval':
      if (rest) {
        applyCliApprovalPolicySelection(rest, context);
      } else {
        openCliSlashCommandForm('approval', rest);
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
        formatCliSessionStatus({
          agent: meta.agent || context.initialAgent,
          model: meta.model || context.initialModel,
          teamName: meta.teamName,
          // Read the session's own mode (which honors a --api-mode/env override)
          // so /status agrees with the header instead of re-reading the global.
          api: formatCliApiMode(meta.apiMode),
          approval: formatCliApprovalPolicy(context.getApprovalPolicy()),
          approvalBypasses: slice?.bypass,
          status: slice?.status ?? 'not started',
          goal: activeStreamId
            ? GoalStore.getForStream(activeStreamId)
            : undefined,
          // Only surface the resume id once a stream exists — never next to
          // a "not started" status.
          sessionId: slice ? context.session.executionId : undefined,
          commandName: context.commandName,
          cwd: context.cwd,
          processCwd: process.cwd(),
          approvalPolicy: context.getApprovalPolicy(),
          queuedFollowUpMessages:
            activeStreamId === undefined
              ? []
              : ToolUseFollowUpQueue.getAll(activeStreamId),
        }),
      );
      return true;
    }
    case 'goal':
    case 'goals':
      appendLocalAssistantTranscript(GOAL_MODE_HELP);
      return true;
    case 'resume': {
      if (!rest) {
        openCliSlashCommandForm('resume', rest);
        return true;
      }
      const id = parseCliHistoryId(rest);
      if (!id) {
        appendLocalAssistantTranscript(`Invalid execution id: ${rest}`);
        return true;
      }
      await context.resumeExecution(id);
      return true;
    }
    case 'memory': {
      try {
        if (!rest) {
          openCliSlashCommandForm('memory', rest);
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
        getFlowContext: (streamId) =>
          executionRegistry.getToolUseFlowContext(streamId),
        notifyFollowUpSent,
        appendTranscript: appendLocalAssistantTranscript,
      });
      return true;
    default: {
      const registered = findSlashCommand(command);
      if (registered) {
        if (openRegisteredCliSlashForm(registered, parsed.remainder)) {
          return true;
        }
        appendLocalAssistantTranscript(
          `/${parsed.name} is registered but is not available in this CLI view yet.`,
        );
      } else {
        const suggestion = suggestSlashCommand(command);
        const didYouMean = suggestion
          ? ` Did you mean /${suggestion.name}?`
          : '';
        appendLocalAssistantTranscript(
          `Unknown command: /${parsed.name}.${didYouMean} Type /help to list commands.`,
        );
      }
      return true;
    }
  }
}
