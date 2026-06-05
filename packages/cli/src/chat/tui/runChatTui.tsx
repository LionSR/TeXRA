// `texra chat` entry point — single Ink-based session.
//
// The legacy line-based renderer was retired in favour of one canonical
// path: the Ink TUI runs for every interactive `texra chat` invocation, and
// non-TTY callers are pointed at `texra run` (which is what they actually
// want for piping/scripting).

import { render, type Instance as InkInstance } from 'ink';
import PQueue from 'p-queue';

import { flushPendingRunTraces, getDefaultStreamLogStore } from '@transcript';
import { tryPlatform } from '@platform/platform';
import { getAgent, loadAgents } from '@agent/index';
import { registerExecution, writeTerminalStatus } from '@agent/storage';
import {
  AgentConfigSchema,
  type AgentConfig,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  interruptActiveChildren,
  killExecution,
} from '@agent/runtime/executionRegistry';
import {
  executeAgent,
  resumeToolUseFromSnapshot,
} from '@agent/runtime/executeAgent';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import {
  notifyFollowUpSent,
  sendFollowUp,
} from '@agent/toolUse/ToolUseFollowUp';
import {
  getInterruptible,
  getToolUseFlowContext,
} from '@agent/toolUse/ToolUseAgentRegistry';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import { DEFAULT_OAUTH_PROVIDER } from '@auth/config';
import { isOAuthProvider, type OAuthProvider } from '@auth/sharedConfig';
import { type CliContext, readCliVersion } from '@cli/runtime/cliContext';
import { formatCliAccountLabelForDisplay } from '@cli/runtime/accountDisplay';
import { hasCliApprovalDenied } from '@cli/runtime/approvalAdapter';
import { approvalPromptsUnavailable } from '@cli/runtime/approvalPolicyAvailability';
import {
  effectiveCliApiMode,
  formatCliApiMode,
  parseCliApiMode,
  setCliApiMode,
  type CliApiMode,
} from '@cli/runtime/apiAccessMode';
import { loadCliApiStatusLines } from '@cli/runtime/apiStatus';
import { resolveChatDefaults } from '@cli/runtime/chatDefaults';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { initCliPlatform, setCliHelperModel } from '@cli/runtime/initPlatform';
import {
  cliRunnableModelOptionsForSource,
  type CliModelFallbackMode,
  type CliRunnableModelResolution,
  formatCliNoAvailableModelsRecovery,
  resolveCliRunnableModel,
} from '@cli/runtime/modelAccess';
import { createCliRuntimeHost } from '@cli/runtime/runtimeHost';
import { writeTextStderr, writeTextStdout } from '@cli/runtime/logSinks';
import {
  formatCliManualAuthUrlMessage,
  signInCliSupabase,
  signOutCliSupabase,
} from '@cli/runtime/supabaseAuth';
import {
  formatInteractiveTerminalFailure,
  interactiveTerminalFailure,
} from '@cli/runtime/terminalRequirements';
import {
  CLI_APPROVAL_POLICIES,
  type CliApprovalPolicy,
} from '@cli/schemas/cliSettings';
import { parseCliHistoryId } from '@cli/runtime/history';
import {
  explainNonResumable,
  resolveCliResumeSnapshot,
} from '@cli/runtime/sessionResume';
import {
  formatCliMemoryList,
  formatCliMemoryPreview,
} from '@cli/runtime/memory';
import { isInFlightStatus } from '@common/constants/streamStatus';
import { toErrorMessage } from '@common/errors/errorMessage';
import {
  EXECUTION_STATUS,
  LIVE_ELAPSED_STREAM_STATUSES,
  STREAM_STATUS,
  StreamStatusSchema,
  type StreamStatus,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { DELEGATION_TOOLS } from '@shared/constants/delegationTools';
import { escapeText } from '@shared/utils/xmlEscape';
import { loadMemoryItems } from '@tools/memory/memoryFileSystem';
import { filterNotNullish } from '@utils/core';
import { generateExecutionId } from '@utils/core/executionId';
import { truncateSummary } from '@utils/text/stringUtils';

import { App } from './App';
import { assertNever } from './assertNever';
import { formatApprovalPolicyForCli as formatApprovalPolicy } from './forms/ApprovalPolicyForm';
import { registerBuiltinSlashCommands } from './commands/registerBuiltins';
import {
  listSlashCommands,
  parseSlashInput,
  type SlashCommand,
} from './commands/slashRegistry';
import { loadInputHistory } from './history/inputHistory';
import { notify } from './notifications/terminalNotifier';
import { tuiOutputStreamForColor } from './render/noColorOutput';
import { formatCliSessionStatus } from './sessionStatus';
import { clearApprovals } from './state/approvalQueue';
import { cliState, resetCliState } from './state/cliState';
import { collectResumeTargets, formatResumeHint } from './state/resumeHint';
import { installTuiApprovals } from './state/subscribeApprovals';
import { wrapRuntimeHost } from './state/subscribeRuntimeHost';
import { subscribeStreamLog } from './state/subscribeStreamLog';
import { subscribeStreamStatus } from './state/subscribeStreamStatus';
import { discoverTerminalCapabilities } from './state/terminalCapabilities';
import { requestCliCompaction } from './state/compactionRequest';
import {
  appendLocalAssistantTranscript,
  appendLocalErrorTranscript,
  appendLocalUserTranscript,
  clearLocalTranscript,
  moveLocalTranscriptToStream,
} from './state/transcript';
import { projectStreamTranscript } from './state/transcriptProjection';
import {
  cleanupTerminalModes,
  clearTerminalScrollback,
} from './terminalCleanup';
import {
  transcriptViewportRepaintOptions,
  type TranscriptViewportChange,
} from './state/transcriptViewportMode';

export interface ChatResult {
  exitCode: number;
}

export interface RunChatInit {
  /** `--agent` override from the CLI; falls through `resolveChatDefaults`. */
  readonly agentOverride?: string;
  /** `--model` override from the CLI; falls through `resolveChatDefaults`. */
  readonly modelOverride?: string;
  /** Visible team identity when chat was launched from a multi-agent preset. */
  readonly teamName?: string;
  /** Multi-agent preset id when chat was launched from a team preset. */
  readonly cliMultiAgentPresetId?: string;
  /**
   * Continue (resume) a stored tool-use session by its execution id instead of
   * starting fresh: the interactive `texra --resume <id>` path. Set by the
   * resume command for TTY sessions; the prior transcript is rehydrated and the
   * suspended tool-use flow is continued on mount (see `resumeAgentRun`).
   */
  readonly resumeExecutionId?: ExecutionId;
}

const QUEUED_FOLLOW_UP_NOTICE_LENGTH = 96;

export interface BuildInitialChatAgentConfigInput {
  readonly agent: string;
  readonly model: string;
  readonly instruction: string;
  readonly displayInstruction?: string;
  readonly workingDirectory: string;
  readonly mediaFiles?: readonly string[];
  readonly cliMultiAgentPresetId?: string;
}

export function buildInitialChatAgentConfig({
  agent,
  model,
  instruction,
  displayInstruction,
  workingDirectory,
  mediaFiles,
  cliMultiAgentPresetId,
}: BuildInitialChatAgentConfigInput): AgentConfigPayload {
  return {
    agent,
    model,
    instruction,
    ...(displayInstruction !== undefined ? { displayInstruction } : {}),
    agentCategory: AgentCategory.ToolUse,
    workingDirectory,
    ...(mediaFiles?.length ? { mediaFiles: [...mediaFiles] } : {}),
    ...(cliMultiAgentPresetId ? { cliMultiAgentPresetId } : {}),
  };
}

export interface ReservedSkillActivation {
  readonly name: string;
  readonly activationPrompt: string;
}

export interface PreparedChatInstruction {
  readonly instruction: string;
  readonly displayInstruction?: string;
  readonly reservedSkillActivations: readonly ReservedSkillActivation[];
}

export function takePendingSkillActivations(
  pendingSkillActivations: Map<string, string>,
  line: string,
): PreparedChatInstruction {
  if (pendingSkillActivations.size === 0) {
    return { instruction: line, reservedSkillActivations: [] };
  }

  const entries = [...pendingSkillActivations.entries()].map(
    ([name, activationPrompt]) => ({ name, activationPrompt }),
  );
  for (const { name } of entries) {
    pendingSkillActivations.delete(name);
  }

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

export function restorePendingSkillActivations(
  pendingSkillActivations: Map<string, string>,
  activations: readonly ReservedSkillActivation[],
): void {
  for (const { name, activationPrompt } of activations) {
    if (!pendingSkillActivations.has(name)) {
      pendingSkillActivations.set(name, activationPrompt);
    }
  }
}

export async function registerFreshChatExecution(
  executionId: ExecutionId,
  configPayload: AgentConfigPayload,
): Promise<AgentConfig> {
  const config = AgentConfigSchema.parse(configPayload);
  await registerExecution(executionId, config, config.agent);
  return config;
}

export async function markRegisteredChatExecutionError(
  executionId: ExecutionId,
  options: {
    readonly executionRegistered: boolean;
    readonly agentSettled: boolean;
  },
): Promise<void> {
  if (!options.executionRegistered || options.agentSettled) return;
  await writeTerminalStatus(executionId, EXECUTION_STATUS.ERROR);
}

export interface ClearableTuiSessionState {
  streamId: StreamTabId | undefined;
  executionId: string | undefined;
  runPromise: Promise<void> | undefined;
  runExitCode: CliExitCode;
  runCompleted: boolean;
  stopRequested: boolean;
}

type TuiSession = ClearableTuiSessionState;
type InterruptibleTuiSessionState = Pick<
  ClearableTuiSessionState,
  'streamId' | 'runPromise' | 'runCompleted'
>;
type PendingTuiRunSessionState = Pick<
  ClearableTuiSessionState,
  'runPromise' | 'runCompleted'
>;

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

export function markChatTuiRunPending(
  session: ClearableTuiSessionState,
  runPromise: Promise<void>,
): void {
  session.streamId = undefined;
  session.runPromise = runPromise;
  session.runExitCode = CliExitCode.Success;
  session.runCompleted = false;
  session.stopRequested = false;
}

export function chatTuiCanInterruptActiveRun(
  session: InterruptibleTuiSessionState,
): boolean {
  return Boolean(
    session.streamId && session.runPromise && !session.runCompleted,
  );
}

export function chatTuiCanStopActiveRun(
  session: InterruptibleTuiSessionState,
  status: StreamStatus | undefined,
): boolean {
  if (!session.runPromise || session.runCompleted) return false;
  if (!session.streamId) return true;
  return status === undefined || LIVE_ELAPSED_STREAM_STATUSES.has(status);
}

export function chatTuiCanStopVisibleRun(
  session: InterruptibleTuiSessionState,
  status: StreamStatus | undefined,
): boolean {
  return (
    chatTuiCanStopActiveRun(session, status) ||
    Boolean(session.streamId && LIVE_ELAPSED_STREAM_STATUSES.has(status ?? ''))
  );
}

export function chatTuiCanStartRootRun(
  session: PendingTuiRunSessionState,
): boolean {
  return !session.runPromise || session.runCompleted;
}

export function chatTuiCanSelectModel(input: {
  readonly canStartRootRun: boolean;
  readonly streamId: StreamTabId | undefined;
  readonly status: StreamStatus | undefined;
  readonly hasActiveToolUseFlow: boolean;
}): boolean {
  return (
    input.canStartRootRun ||
    Boolean(
      input.streamId &&
      input.status === STREAM_STATUS.WAITING &&
      input.hasActiveToolUseFlow,
    )
  );
}

export type ChatTuiSigintAction =
  | 'clean-exit'
  | 'force-exit'
  | 'interrupt-and-arm-exit';

export function chatTuiSigintAction(input: {
  readonly exitArmed: boolean;
  readonly canStopActiveRun: boolean;
  readonly canInterruptActiveRun: boolean;
}): ChatTuiSigintAction {
  if (input.exitArmed) return 'force-exit';
  if (input.canStopActiveRun) return 'interrupt-and-arm-exit';
  // Resumable-idle (interruptible but not actively running): exit WITHOUT
  // interrupting so the suspended tool-use flow record survives for resume —
  // interrupting would clear it in runToolUseFlow's finally. force-exit calls
  // process.exit, leaving the suspended flow on disk for `texra --resume`.
  if (input.canInterruptActiveRun) return 'force-exit';
  return 'clean-exit';
}

/**
 * On exit, a tool-use session suspended at the WAIT node (idle/WAITING) must
 * NOT be interrupted: interrupting clears its per-execution flow record in
 * `runToolUseFlow`'s finally, destroying the only resumable state. The record
 * survives only when the process dies while the flow is still suspended.
 *
 * The discriminator: `canInterruptActiveRun` is true for any pending run, but
 * `canStopActiveRun` is true only while a turn is *actively* running. So
 * "interruptible but not stoppable" is exactly the resumable-idle case. Kept
 * pure (takes the two precomputed booleans) so the exit policy is unit-testable
 * without the live status plumbing. Used by the graceful-exit `finally`; the
 * SIGINT path encodes the same idle→preserve rule via `chatTuiSigintAction`.
 */
export function chatTuiIsResumableIdleOnExit(input: {
  readonly canInterruptActiveRun: boolean;
  readonly canStopActiveRun: boolean;
}): boolean {
  return input.canInterruptActiveRun && !input.canStopActiveRun;
}

function chatTuiActiveChildStreamId(): StreamTabId | undefined {
  const activeStreamId = cliState.activeStreamId.get();
  if (!activeStreamId) return undefined;
  return cliState.parentStream.get().has(activeStreamId)
    ? activeStreamId
    : undefined;
}

function chatTuiStreamStatuses(streamId: StreamTabId): readonly string[] {
  const streams = cliState.streams.get();
  const parentStreamId = cliState.parentStream.get().get(streamId);
  const childStreamStatus = parentStreamId
    ? streams
        .get(parentStreamId)
        ?.childStreams.find((child) => child.childStreamId === streamId)?.status
    : undefined;
  return [
    childStreamStatus,
    streams.get(streamId)?.status,
    StreamStatusService.get(streamId),
  ].filter(filterNotNullish);
}

function chatTuiCanAcceptFollowUp(statuses: readonly string[]): boolean {
  // A focused child normally has at least one status source. Keep the previous
  // permissive behavior during the brief edge where parent focus arrives first.
  if (statuses.length === 0) return true;
  return statuses.every((status) => {
    const parsed = StreamStatusSchema.safeParse(status);
    return parsed.success && isInFlightStatus(parsed.data);
  });
}

export function chatTuiActiveChildFollowUpTarget(): StreamTabId | undefined {
  const activeStreamId = chatTuiActiveChildStreamId();
  if (!activeStreamId) return undefined;
  return chatTuiCanAcceptFollowUp(chatTuiStreamStatuses(activeStreamId))
    ? activeStreamId
    : undefined;
}

export function chatTuiShouldAnnounceQueuedFollowUp(
  targetStreamId: StreamTabId | undefined,
): boolean {
  if (!targetStreamId) return true;
  return !chatTuiStreamStatuses(targetStreamId).includes(STREAM_STATUS.WAITING);
}

export function chatTuiRejectedChildFollowUpTarget(): StreamTabId | undefined {
  const activeStreamId = chatTuiActiveChildStreamId();
  if (!activeStreamId) return undefined;
  return chatTuiCanAcceptFollowUp(chatTuiStreamStatuses(activeStreamId))
    ? undefined
    : activeStreamId;
}

interface SlashCommandContext {
  readonly session: TuiSession;
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
  if (!chatTuiCanStartRootRun(context.session)) {
    appendLocalAssistantTranscript(
      'Agent changes are only available before the first message. Start a new chat with texra chat --agent=<name> to choose a different root agent.',
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

async function applyCliModelSelection(
  model: string,
  context: SlashCommandContext,
): Promise<void> {
  const nextModel = model.trim();
  if (chatTuiCanStartRootRun(context.session)) {
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
    return;
  }

  if (!context.canSelectModel()) {
    appendLocalAssistantTranscript(
      'Finish the active response before switching models.',
    );
    return;
  }

  const activeFlow = context.session.streamId
    ? getToolUseFlowContext(context.session.streamId)
    : undefined;
  if (!activeFlow) {
    appendLocalAssistantTranscript(
      'Model switching is only available for an active tool-use chat. Start a new chat with texra chat --model=<name> to choose a different root model.',
    );
    return;
  }

  try {
    await activeFlow.switchModel(nextModel);
    cliState.sessionMeta.set({
      ...cliState.sessionMeta.get(),
      model: nextModel,
    });
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

function chatApiModeRecoveryMessage(apiMode: CliApiMode): string {
  return formatCliNoAvailableModelsRecovery(apiMode, {
    includedModeAction: 'switch to included relay with `/api included`',
    personalModeAction: 'switch to personal API keys with `/api personal`',
  });
}

export async function resolveChatRootModelForApiMode(
  model: string,
  apiMode: CliApiMode,
  fallbackMode: CliModelFallbackMode,
): Promise<CliRunnableModelResolution> {
  return resolveCliRunnableModel(model, {
    fallbackMode,
    apiMode,
    noAvailableModelsMessage: chatApiModeRecoveryMessage(apiMode),
  });
}

async function reconcileRootModelAfterApiModeChange(
  context: SlashCommandContext | undefined,
  apiMode: CliApiMode,
): Promise<string | undefined> {
  if (!context || !chatTuiCanStartRootRun(context.session)) return undefined;

  const currentModel = cliState.sessionMeta.get().model;
  const resolution = await resolveChatRootModelForApiMode(
    currentModel,
    apiMode,
    'notice',
  );
  if (resolution.model === currentModel) return undefined;

  await setCliHelperModel(resolution.model);
  cliState.sessionMeta.set({
    ...cliState.sessionMeta.get(),
    model: resolution.model,
  });
  return resolution.notice;
}

async function applyCliApiModeSelection(
  mode: string | CliApiMode,
  context?: SlashCommandContext,
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
  appendLocalAssistantTranscript((await loadCliApiStatusLines()).join('\n'));
}

export const CHAT_LOGIN_USAGE =
  'Usage: /login [github | google] [--no-browser] [--select-account] [--login-hint <account>]';

interface ChatLoginSlashArgs {
  readonly provider: OAuthProvider;
  readonly noBrowser: boolean;
  readonly selectAccount: boolean;
  readonly loginHint?: string;
}

export function parseChatLoginSlashArgs(
  input: string,
): ChatLoginSlashArgs | undefined {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  let provider: string = DEFAULT_OAUTH_PROVIDER;
  let providerSet = false;
  let noBrowser = false;
  let selectAccount = false;
  let loginHint: string | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--no-browser') {
      noBrowser = true;
      continue;
    }
    if (token === '--select-account') {
      selectAccount = true;
      continue;
    }
    if (token === '--login-hint') {
      const next = tokens[index + 1];
      if (!next || next.startsWith('--')) return undefined;
      loginHint = next;
      index += 1;
      continue;
    }
    if (token.startsWith('--login-hint=')) {
      const value = token.slice('--login-hint='.length).trim();
      if (!value || value.startsWith('--')) return undefined;
      loginHint = value;
      continue;
    }
    if (token.startsWith('--') || providerSet) return undefined;
    provider = token;
    providerSet = true;
  }

  if (!isOAuthProvider(provider)) return undefined;
  return { provider, noBrowser, selectAccount, loginHint };
}

async function loginFromChat(input: string): Promise<void> {
  const args = parseChatLoginSlashArgs(input);
  if (!args) {
    appendLocalAssistantTranscript(CHAT_LOGIN_USAGE);
    return;
  }

  if (args.provider === 'github' && args.selectAccount && !args.loginHint) {
    appendLocalAssistantTranscript(
      'GitHub does not support --select-account by itself. Use --login-hint <username> to request a specific GitHub account.',
    );
  }
  appendLocalAssistantTranscript(
    args.noBrowser
      ? `Starting TeXRA ${args.provider} sign-in.`
      : `Opening browser for TeXRA ${args.provider} sign-in...`,
  );

  try {
    const session = await signInCliSupabase({
      provider: args.provider,
      openBrowser: !args.noBrowser,
      selectAccount: args.selectAccount,
      loginHint: args.loginHint,
      manualBrowserHint: '/login --no-browser',
      onAuthUrl: (url) => {
        if (args.noBrowser) {
          appendLocalAssistantTranscript(formatCliManualAuthUrlMessage(url));
        }
      },
    });
    appendLocalAssistantTranscript(
      [
        `Signed in as ${formatCliAccountLabelForDisplay(session.account.label)}.`,
        ...(await loadCliApiStatusLines()),
      ].join('\n'),
    );
  } catch (error: unknown) {
    appendLocalAssistantTranscript(toErrorMessage(error));
  }
}

async function logoutFromChat(): Promise<void> {
  try {
    await signOutCliSupabase();
    appendLocalAssistantTranscript(
      ['Signed out.', ...(await loadCliApiStatusLines())].join('\n'),
    );
  } catch (error: unknown) {
    appendLocalAssistantTranscript(toErrorMessage(error));
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

const YOLO_USAGE = 'Usage: /yolo [ask | never | yolo]';

function applyCliApprovalPolicySelection(
  input: string,
  context: SlashCommandContext,
  usage = YOLO_USAGE,
): void {
  const normalized = input.trim().toLowerCase();
  if (!normalized || normalized === 'status') {
    openRegisteredCliSlashCommandForm('approval', '');
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

async function showCliMemoryList(): Promise<void> {
  appendLocalAssistantTranscript(formatCliMemoryList(await loadMemoryItems()));
}

async function showCliMemoryPreview(inputPath: string): Promise<void> {
  appendLocalAssistantTranscript(await formatCliMemoryPreview(inputPath));
}

export function openRegisteredCliSlashForm(
  command: SlashCommand,
  remainder: string,
): boolean {
  const Form = command.formComponent;
  if (!Form) return false;
  cliState.activeForm.set({
    commandName: command.name,
    escapeAction: command.formEscapeAction,
    render: (close, availableRows) => (
      <Form
        availableRows={availableRows}
        remainder={remainder.trimStart()}
        onDone={() => close()}
      />
    ),
  });
  return true;
}

function findRegisteredCliSlashCommand(
  commandName: string,
): SlashCommand | undefined {
  const lower = commandName.toLowerCase();
  return listSlashCommands().find(
    (cmd) =>
      cmd.name.toLowerCase() === lower ||
      cmd.aliases?.some((alias) => alias.toLowerCase() === lower) === true,
  );
}

function openRegisteredCliSlashCommandForm(
  commandName: string,
  remainder: string,
): boolean {
  const registered = findRegisteredCliSlashCommand(commandName);
  return registered ? openRegisteredCliSlashForm(registered, remainder) : false;
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
  // USER_MESSAGE stream-log entry is never produced. Skip the echo for the
  // exit commands (the TUI is tearing down); /clear still echoes because
  // resetSessionForClear refuses while a run is active and surfaces an
  // error — without the echo the user wouldn't see what triggered it.
  if (command !== 'exit' && command !== 'quit' && command !== 'login') {
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
    case 'agents':
      if (!chatTuiCanStartRootRun(context.session) && rest) {
        appendLocalAssistantTranscript(
          'The agent is fixed for this chat session. Start a new chat to use a different agent.',
        );
      } else if (rest) {
        applyInitialCliAgentSelection(rest, context);
      } else {
        openRegisteredCliSlashCommandForm('agent', rest);
      }
      return true;
    case 'model':
    case 'models':
      openRegisteredCliSlashCommandForm('model', rest);
      return true;
    case 'api':
      if (!rest) {
        openRegisteredCliSlashCommandForm('api', rest);
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
        openRegisteredCliSlashCommandForm('approval', rest);
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
          approval: formatApprovalPolicy(context.getApprovalPolicy()),
          approvalBypasses: slice?.bypass,
          status: slice?.status ?? 'not started',
          queuedFollowUpMessages:
            activeStreamId === undefined
              ? []
              : ToolUseFollowUpQueue.getAll(activeStreamId),
        }),
      );
      return true;
    }
    case 'resume': {
      if (!rest) {
        openRegisteredCliSlashCommandForm('resume', rest);
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
          openRegisteredCliSlashCommandForm('memory', rest);
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
      const registered = findRegisteredCliSlashCommand(command);
      if (registered) {
        if (openRegisteredCliSlashForm(registered, parsed.remainder)) {
          return true;
        }
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

  await initCliPlatform({ ...context, quietLogs: true });
  // First-run gate (interactive only; headless already rejected above). A
  // credential-less user signs in or saves a key here; the apiMode + model
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
  const apiMode = effectiveCliApiMode(context);
  const defaults = await resolveChatDefaults({
    cwd: context.cwd,
    agentOverride: init.agentOverride,
    modelOverride: init.modelOverride,
    envAgent: context.envAgent,
    envModel: context.envModel,
  });
  // One API mode for the whole session: an explicit --api-mode/env override
  // wins, otherwise the persisted account default. Model resolution, the
  // no-models hints, and the header/status all read this same value so they can
  // never disagree.
  let modelResolution: Awaited<ReturnType<typeof resolveCliRunnableModel>>;
  try {
    modelResolution = await resolveCliRunnableModel(
      defaults.model,
      cliRunnableModelOptionsForSource(defaults.modelSource, {
        apiMode,
        noAvailableModelsMessage: formatCliNoAvailableModelsRecovery(apiMode, {
          includedModeAction: 'retry with `texra chat --api-mode included`',
          personalModeAction: 'retry with `texra chat --api-mode personal`',
        }),
      }),
    );
  } catch (error: unknown) {
    writeTextStderr(toErrorMessage(error));
    return { exitCode: CliExitCode.Usage };
  }
  const { agent } = defaults;
  const model = modelResolution.model;
  await setCliHelperModel(model);
  const version = await readCliVersion();

  let activeApprovalPolicy = context.approvalPolicy;
  const currentSessionContext = (helperModel: string): CliContext => ({
    ...context,
    apiMode: cliState.sessionMeta.get().apiMode,
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
  // The slash-command context is identical at every call site; build it once
  // lazily so the closures it captures (interruptActive, resetSessionForClear,
  // resumeAgentRun) are all defined before the first use.
  const slashCommandContext = (): SlashCommandContext => ({
    session,
    initialAgent: agent,
    initialModel: model,
    interruptActive,
    requestInputExit,
    getApprovalPolicy,
    setApprovalPolicy,
    canSelectModel: canSelectCurrentModel,
    resetSession: resetSessionForClear,
    resumeExecution: resumeAgentRun,
  });
  await loadAgents();
  cliState.sessionMeta.set({
    agent,
    model,
    cwd: context.cwd,
    apiMode,
    canDelegate: agentSupportsDelegation(agent),
    teamName: init.teamName,
    version,
  });
  if (modelResolution.notice) {
    appendLocalAssistantTranscript(modelResolution.notice);
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

  // Enable StreamLog persistence for the interactive session so transcripts
  // survive exit and can be reopened on resume. Uses the shared (extension-
  // compatible) StreamLogStore, so a workspace opened in either surface reads
  // the same `streamLogs/<id>.json`. load() is summaries-only (lazy) and must
  // run before any append — it clears in-memory logs on entry — hence before
  // subscribeStreamLog wires the append→sync bridge below. Best-effort: a load
  // failure leaves persistence off (save() no-ops) rather than breaking chat.
  try {
    await getDefaultStreamLogStore().load();
  } catch {
    // Persistence stays disabled; the session still runs in-memory as before.
  }

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
  const pendingSkillActivations = new Map<string, string>();
  let pendingSkillActivationClearEpoch = 0;
  const rootStreamStatus = (): StreamStatus | undefined =>
    session.streamId
      ? (cliState.streams.get().get(session.streamId)?.status ??
        StreamStatusService.get(session.streamId))
      : undefined;
  const hasActiveToolUseFlow = (): boolean =>
    Boolean(session.streamId && getToolUseFlowContext(session.streamId));
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
      ? getToolUseFlowContext(session.streamId)
      : undefined;
    return activeFlow?.modelSwitchDisabledReason(candidateModel);
  };
  const activateSkillForNextMessage = (selection: {
    readonly name: string;
    readonly activationPrompt: string;
  }): void => {
    const wasPending = pendingSkillActivations.has(selection.name);
    pendingSkillActivations.set(selection.name, selection.activationPrompt);
    appendLocalAssistantTranscript(
      [
        `Skill ${wasPending ? 'refreshed' : 'activated'}: ${selection.name}.`,
        'It will be applied to your next message.',
      ].join(' '),
    );
  };
  const canInterruptActiveRun = (): boolean =>
    chatTuiCanInterruptActiveRun(session);
  const canStopActiveRun = (): boolean =>
    chatTuiCanStopVisibleRun(session, rootStreamStatus());
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
    pendingSkillActivationClearEpoch += 1;
    pendingSkillActivations.clear();
    clearTuiSessionRunState(session);
    // StreamLogStore entries outlive resetCliState (which only clears the
    // React/signal view). Drop them so transcript projection can't replay
    // the cleared conversation into the fresh `<Static>` scrollback.
    const store = getDefaultStreamLogStore();
    for (const streamId of cliState.streams.get().keys()) {
      store.delete(streamId).catch(() => {
        // Best-effort: a KV failure leaves the log on disk, but the run
        // is already torn down — nothing actionable to surface here.
      });
    }
    resetCliState(meta);
    clearTerminalScrollback();
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
    let waitingTurn = 0;
    let executionRegistered = false;
    let agentSettled = false;
    session.executionId = executionId;
    const approvalsUnavailable = approvalPromptsUnavailable(sessionContext);

    const runPromise = setCliHelperModel(currentModel)
      .then(() => registerFreshChatExecution(executionId, config))
      .then((registeredConfig) => {
        executionRegistered = true;
        return executeAgent(registeredConfig, executionId, {
          runtimeHost: wrapped,
          enforceCategory: true,
          approvalPromptsUnavailable: approvalsUnavailable,
          onStreamResolved: (resolvedStreamId) => {
            session.streamId = resolvedStreamId;
            moveLocalTranscriptToStream(resolvedStreamId);
            cliState.activeStreamId.set(resolvedStreamId);
            if (session.stopRequested) interruptActive();
          },
          onBeforeWaiting: (lastResponse) => {
            if (!session.streamId) return;
            projectStreamTranscript(session.streamId, {
              fallbackAssistant: {
                text: lastResponse,
                idPrefix: `waiting:${executionId}:${waitingTurn++}`,
              },
              finalize: true,
            });
          },
        });
      })
      .then((result) => {
        agentSettled = true;
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
        if (result.streamId) {
          // The run is definitively done. Pull any final log chunks into
          // cliState, add the result text only if the log did not render it,
          // and promote deferred assistant/tool rows into `<Static>`.
          projectStreamTranscript(result.streamId, {
            finalize: true,
            ...(result.category === AgentCategory.ToolUse
              ? {
                  fallbackAssistant: {
                    text: result.lastResponse,
                    idPrefix: `final:${result.executionId}`,
                  },
                }
              : {}),
          });
        }
        notify({ kind: 'agentFinished' });
      })
      .catch(async (error: unknown) => {
        await markRegisteredChatExecutionError(executionId, {
          executionRegistered,
          agentSettled,
        });
        if (!session.stopRequested) {
          // Ink owns stdout while the TUI is mounted; surface the failure
          // inline so the user sees why the agent stopped.
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
    markChatTuiRunPending(session, runPromise);
  };

  // Interactive resume: continue a suspended tool-use session by execution id.
  // Mirrors startAgentRun's runtimeHost/approvals/runPromise lifecycle, but
  // (a) resolves a persisted snapshot instead of building a fresh config, and
  // (b) the streamId is already known (re-derived from the prior run), so we
  // set session.streamId up front and rehydrate that stream's transcript so
  // the user sees the prior conversation before the continued turn streams in.
  const resumeAgentRun = async (id: ExecutionId): Promise<void> => {
    if (!chatTuiCanStartRootRun(session)) {
      appendLocalAssistantTranscript(
        'Finish the active chat before resuming a previous session.',
      );
      return;
    }

    const resolution = await resolveCliResumeSnapshot(id);
    if (resolution.kind !== 'toolUse') {
      // Workflows / missing / already-completed sessions can't continue here —
      // surface why and leave the session idle so the user can still chat.
      appendLocalErrorTranscript(explainNonResumable(resolution, id));
      return;
    }

    clearLocalTranscript();
    followUpQueue.clear();
    session.runCompleted = false;
    session.stopRequested = false;
    session.runExitCode = CliExitCode.Success;
    session.streamId = resolution.streamId;
    session.executionId = resolution.snapshot.executionId;

    const currentModel = resolution.config.model;
    const sessionContext = currentSessionContext(currentModel);
    cliState.sessionMeta.set({
      ...cliState.sessionMeta.get(),
      agent: resolution.config.agent,
      model: resolution.config.model,
      canDelegate: agentSupportsDelegation(resolution.config.agent),
    });

    // Rehydrate the prior transcript so the user sees the conversation they're
    // continuing. ensureLoaded pulls the persisted entries off disk into the
    // store; projection promotes already-final rows into `<Static>` scrollback.
    // An older run with no persisted entries simply shows whatever exists
    // (possibly nothing) — the continued turn streams in regardless.
    await getDefaultStreamLogStore().ensureLoaded(resolution.streamId);
    projectStreamTranscript(resolution.streamId);
    cliState.activeStreamId.set(resolution.streamId);

    const runtimeHost = createCliRuntimeHost(sessionContext);
    const wrapped = wrapRuntimeHost(runtimeHost);
    const unbindApprovals = installTuiApprovals(wrapped, sessionContext);
    disposers.push(unbindApprovals);
    const approvalsUnavailable = approvalPromptsUnavailable(sessionContext);

    session.runPromise = setCliHelperModel(currentModel)
      .then(() =>
        resumeToolUseFromSnapshot(resolution.snapshot, wrapped, {
          approvalPromptsUnavailable: approvalsUnavailable,
        }),
      )
      .then(() => {
        // resumeToolUseFromSnapshot resolves void (no result object), so the
        // streamId we already know is the only handle: flush the tail and
        // promote any deferred assistant/tool rows into `<Static>`.
        if (session.streamId) {
          projectStreamTranscript(session.streamId, { finalize: true });
        }
        session.runExitCode = CliExitCode.Success;
        notify({ kind: 'agentFinished' });
      })
      .catch((error: unknown) => {
        if (!session.stopRequested) {
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
    // Don't await session.runPromise here: a resumed session that suspends at
    // the WAIT node leaves runPromise unresolved (mirrors startAgentRun's
    // fire-and-forget). The exit `finally` handles the dangling-promise case.
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
        `Approval mode set to ${formatApprovalPolicy(policy)}.`,
      );
    },
    canSelectModel: canSelectCurrentModel,
    getModelSwitchDisabledReason,
    onModelSelect: (nextModel) =>
      applyCliModelSelection(nextModel, slashCommandContext()),
    onApiModeSelect: (nextMode) =>
      applyCliApiModeSelection(nextMode, slashCommandContext()),
    onMemorySelect: showCliMemoryPreview,
    onSkillSelect: activateSkillForNextMessage,
    onResumeSelect: resumeAgentRun,
    onError: (error) => {
      appendLocalAssistantTranscript(toErrorMessage(error));
    },
  });

  const startSession = async (
    instruction: string,
    mediaFiles?: readonly string[],
    displayInstruction?: string,
  ): Promise<boolean> => {
    followUpQueue.clear();
    session.executionId = undefined;
    let started = false;
    // Queue the async startup body after the reservation below so a second
    // submit cannot pass chatTuiCanStartRootRun during model/auth resolution.
    const pendingStart = Promise.resolve().then(async (): Promise<void> => {
      try {
        const meta = cliState.sessionMeta.get();
        const currentAgent = meta.agent || agent;
        const currentModel = meta.model || model;
        const resolution = await resolveChatRootModelForApiMode(
          currentModel,
          meta.apiMode,
          'reject',
        );
        if (session.stopRequested) {
          session.runCompleted = true;
          return;
        }

        startAgentRun(
          buildInitialChatAgentConfig({
            agent: currentAgent,
            model: resolution.model,
            instruction,
            displayInstruction,
            mediaFiles,
            workingDirectory: context.cwd,
            cliMultiAgentPresetId: init.cliMultiAgentPresetId,
          }),
        );
        started = true;
      } catch (error: unknown) {
        if (!session.stopRequested) {
          appendLocalUserTranscript(displayInstruction ?? instruction);
          appendLocalErrorTranscript(toErrorMessage(error));
        }
        session.runExitCode = session.stopRequested
          ? CliExitCode.Success
          : CliExitCode.AgentError;
        session.runCompleted = true;
      }
    });
    markChatTuiRunPending(session, pendingStart);
    await pendingStart;
    return started;
  };

  const handleSubmit = (line: string, mediaFiles?: readonly string[]): void => {
    void handleSubmittedLine(line, mediaFiles);
  };

  const handleSubmittedLine = async (
    line: string,
    mediaFiles?: readonly string[],
  ): Promise<void> => {
    if (await handleTuiSlashCommand(line, slashCommandContext())) {
      return;
    }
    await submitChatMessage(line, mediaFiles);
  };

  const submitChatMessage = async (
    line: string,
    mediaFiles?: readonly string[],
  ): Promise<void> => {
    const rejectedChildFollowUpTarget = chatTuiRejectedChildFollowUpTarget();
    if (rejectedChildFollowUpTarget) {
      appendLocalAssistantTranscript(
        'The selected subagent is no longer accepting follow-ups.',
        rejectedChildFollowUpTarget,
      );
      return;
    }
    const childFollowUpTarget = chatTuiActiveChildFollowUpTarget();
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
    if (!childFollowUpTarget && chatTuiCanStartRootRun(session)) {
      const started = await startSession(
        prepared.instruction,
        mediaFiles,
        prepared.displayInstruction,
      );
      if (!started) {
        restoreReservedSkillActivations();
      }
      return;
    }
    // PRD success criterion: follow-ups must not be silently dropped when the
    // user submits before `onStreamResolved` populates `session.streamId`.
    // p-queue serializes work but doesn't have an "await predicate" primitive,
    // so the task itself waits for the stream id via a tiny poll loop.
    const initialFollowUpTarget = childFollowUpTarget ?? session.streamId;
    if (chatTuiShouldAnnounceQueuedFollowUp(initialFollowUpTarget)) {
      appendLocalAssistantTranscript(
        `Queued follow-up: ${truncateSummary(
          line,
          QUEUED_FOLLOW_UP_NOTICE_LENGTH,
        )}`,
        initialFollowUpTarget,
      );
    }
    void followUpQueue.add(async () => {
      let delivered = false;
      let followUpTarget = childFollowUpTarget;
      try {
        while (
          !followUpTarget &&
          !session.stopRequested &&
          !session.runCompleted
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
          followUpTarget = session.streamId;
        }
        if (!followUpTarget || session.stopRequested) return;
        const result = await sendFollowUp(
          followUpTarget,
          prepared.instruction,
          mediaFiles,
          prepared.displayInstruction,
        );
        delivered = result.status === 'sent' || result.status === 'queued';
        if (result.status === 'no_session') {
          // Child stream ids are keys in parentStream; the root session id is not.
          if (followUpTarget === session.streamId) {
            session.stopRequested = true;
          } else {
            appendLocalAssistantTranscript(
              'The selected subagent is no longer accepting follow-ups.',
              followUpTarget,
            );
          }
        }
      } finally {
        if (!delivered) {
          restoreReservedSkillActivations();
        }
      }
    });
  };

  const stdoutColorEnabled = context.stdoutColorEnabled ?? context.colorEnabled;
  const inkRef: { current?: InkInstance } = {};
  const repaintTranscriptViewport = (
    change: TranscriptViewportChange,
  ): void => {
    inkRef.current?.repaint(transcriptViewportRepaintOptions(change));
  };
  const ink = render(
    <App
      onSubmit={handleSubmit}
      canInterruptActiveRun={canInterruptActiveRun}
      canStopActiveRun={canStopActiveRun}
      colorEnabled={stdoutColorEnabled}
      onInterruptActive={interruptActive}
      onTranscriptViewportChange={repaintTranscriptViewport}
      onCtrlC={() => handleSigint()}
      onKillExecution={(executionId) => {
        clearApprovals();
        killExecution(executionId);
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
      },
    },
  );
  inkRef.current = ink;

  let pendingExitTimer: ReturnType<typeof setTimeout> | undefined;
  let exitArmed = false;
  // Set once a signal exit (exitNow) starts: its ink.unmount() resolves
  // waitUntilExit and re-enters the post-waitUntilExit finally, so the finally
  // guards on this to avoid draining persistence / printing the resume hint a
  // second time.
  let exiting = false;
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
  // Persist the reopen hint to native scrollback: the main session plus each
  // resumable tool-use subagent, so any route can be continued by its own id.
  // Read cliState before resetCliState() clears it.
  const printResumeHintOnExit = (): void => {
    if (!session.executionId) return;
    const hint = formatResumeHint(
      collectResumeTargets({
        rootExecutionId: session.executionId,
        streams: cliState.streams.get(),
      }),
    );
    if (hint) writeTextStdout(`\n${hint}`);
  };
  // Materialize buffered trace chunks, then drain the debounced StreamLog disk
  // writes so the tail of the session isn't lost (SAVE_DEBOUNCE_MS window).
  // flush() is bounded (MAX_WRITE_RETRIES) and a no-op when persistence never
  // loaded, so this can neither hang nor affect headless paths.
  const drainPersistence = (): Promise<void> => {
    flushPendingRunTraces();
    return getDefaultStreamLogStore().flush();
  };
  // These TUI exit paths call process.exit() directly, so bin/texra.ts's
  // `finally` (which runs platform shutdown) never fires. Run it here too so
  // shutdown handlers — notably UsageLogService.dispose(), which flushes any
  // queued usage entries — execute before the process dies. runShutdown is
  // idempotent, so the normal return path can still rely on bin/texra.ts.
  const runPlatformShutdown = (): Promise<void> =>
    tryPlatform()?.lifecycle.runShutdown() ?? Promise.resolve();
  const exitNow = (exitCode: number): void => {
    exiting = true;
    removeProcessHandlers();
    clearPendingExit();
    ink.unmount();
    // Print the resume hint while the cursor is still parked at the bottom of
    // the unmounted frame — BEFORE cleanupTerminalModes, whose `?1049l` jumps
    // the cursor mid-screen on this (never-alt-screen) TUI and makes the hint
    // overprint the transcript. Mirrors the requestInputExit path's order.
    printResumeHintOnExit();
    cleanupTerminalModes({ clearItermProgress });
    // Synchronous signal exits (SIGINT double-tap / SIGTERM / SIGHUP) own the
    // whole teardown here (the finally skips when `exiting`), so drain
    // persistence and run platform shutdown before exiting. allSettled never
    // rejects, so a flush failure can't become an unhandled rejection under
    // --unhandled-rejections=strict.
    void Promise.allSettled([
      drainPersistence(),
      runPlatformShutdown(),
    ]).finally(() => process.exit(exitCode));
  };
  const armExit = (): void => {
    exitArmed = true;
    cliState.pendingExitHint.set(true);
    cliState.pendingExitResumeId.set(session.executionId);
    if (pendingExitTimer) clearTimeout(pendingExitTimer);
    pendingExitTimer = setTimeout(clearPendingExit, 800);
  };
  const handleSigint = (): void => {
    const sigintAction = chatTuiSigintAction({
      exitArmed,
      canStopActiveRun: canStopActiveRun(),
      canInterruptActiveRun: canInterruptActiveRun(),
    });
    switch (sigintAction) {
      case 'clean-exit':
        session.stopRequested = true;
        interruptActive();
        requestInputExit();
        return;
      case 'force-exit':
        // exitArmed OR resumable-idle: exit WITHOUT interrupting. For an
        // idle/WAITING session this preserves the suspended tool-use flow
        // record (executions/<id>/flow-*.json) so `texra --resume` can
        // continue it — interrupting would clear it in runToolUseFlow's
        // finally. exitNow() calls process.exit, leaving the flow on disk.
        exitNow(130);
        return;
      case 'interrupt-and-arm-exit':
        session.stopRequested = true;
        interruptActive();
        armExit();
        return;
      default:
        assertNever(sigintAction, 'Unhandled chat TUI SIGINT action');
    }
  };
  // Only interrupt an actively-running turn; an idle/WAITING session is left
  // suspended so its flow record survives for resume (see handleSigint).
  const handleTermSignal = (exitCode: number): void => {
    if (canStopActiveRun()) {
      session.stopRequested = true;
      interruptActive();
    }
    exitNow(exitCode);
  };
  const handleSigterm = (): void => handleTermSignal(143);
  const handleSighup = (): void => handleTermSignal(129);
  function requestInputExit(): void {
    removeProcessHandlers();
    clearPendingExit();
    ink.unmount();
  }
  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', handleSigterm);
  process.on('SIGHUP', handleSighup);

  // Interactive resume: kick off the continued tool-use run now that Ink is
  // mounted (so the rehydrated transcript + streamed continuation render) and
  // the signal handlers are armed. Fire-and-forget — resumeAgentRun installs
  // session.runPromise, and the normal first-input path stays available so the
  // user can keep chatting (follow-ups target session.streamId as usual).
  if (init.resumeExecutionId) {
    // Guard the void: resumeAgentRun awaits snapshot resolution / ensureLoaded
    // before installing its own .then/.catch, so an early throw there would
    // otherwise surface as an unhandled rejection.
    void resumeAgentRun(init.resumeExecutionId).catch((error: unknown) => {
      appendLocalErrorTranscript(toErrorMessage(error));
    });
  }

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
    // A signal exit (SIGINT/SIGTERM/SIGHUP) runs exitNow(), which does the full
    // teardown and process.exit()s itself; its ink.unmount() resolves
    // waitUntilExit and re-enters this finally. Skip the entire graceful
    // teardown in that case — re-running it would duplicate the drain / hint /
    // cleanup, and the resumableIdle process.exit() below would race exitNow's
    // async exit, dropping the flush and the signal exit code.
    if (!exiting) {
      removeProcessHandlers();
      clearPendingExit();
      for (const dispose of disposers) dispose();
      await followUpQueue.onIdle();
      // A suspended (idle/WAITING) root session is resumable: its flow record
      // survives only if we DON'T interrupt the flow (interrupt clears it). See
      // chatTuiIsResumableIdleOnExit for why "interruptible but not stoppable"
      // is exactly the idle-but-suspended case we must leave untouched.
      const resumableIdle = chatTuiIsResumableIdleOnExit({
        canInterruptActiveRun: canInterruptActiveRun(),
        canStopActiveRun: canStopActiveRun(),
      });
      if (session.runPromise && !session.runCompleted && !resumableIdle) {
        session.stopRequested = true;
        interruptActive();
        // Only await a run we actually interrupted/finished. A resumableIdle run
        // is parked at the WAIT node and its runPromise NEVER resolves, so
        // awaiting it would hang the process here.
        await session.runPromise;
      }
      await drainPersistence();
      printResumeHintOnExit();
      resetCliState();
      cleanupTerminalModes({ clearItermProgress });
      if (resumableIdle) {
        // The dangling runPromise keeps the event loop alive, so a normal return
        // would never let the process exit. Force-exit here, AFTER persistence
        // is flushed and the resume hint is printed, preserving the suspended
        // flow record on disk for `texra --resume`. Run platform shutdown first
        // so queued usage logs flush — bin/texra.ts's finally won't on exit().
        await runPlatformShutdown();
        process.exit(session.runExitCode);
      }
    }
  }
  return { exitCode: session.runExitCode };
}
