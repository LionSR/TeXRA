/**
 * SettingsView inbound (webview → backend) message schemas, the inbound
 * discriminated union, and its dispatcher. Memory/History/Profile inbound
 * schemas are imported from their own modules so command literals never drift.
 */
import { z } from 'zod';

import { SETTINGS_VIEW_CMD } from '@shared/ipc';
import { LATEX_CONFIG_FIELDS } from '@shared/constants/latex';
import {
  createDispatcher,
  type HandlerRegistry,
} from '@shared/utils/dispatcher';

import { AgentCategorySchema, AgentSourceSchema } from '../agent';
import { StreamTabIdSchema } from '../identifiers';
import { commandOnly } from '../messageFactories';
import { WebviewReadyMessageSchema } from '../commonViewMessages';
import {
  DeleteMemoryMessageSchema,
  GetMemoryDataMessageSchema,
  GetMemoryPreviewMessageSchema,
  OpenMemoryFileMessageSchema,
  OpenMemoryFolderMessageSchema,
  PinMemoryMessageSchema,
  SetMemoryEnabledMessageSchema,
  UnpinMemoryMessageSchema,
} from '../memoryViewMessages';
import {
  ClearHistoryMessageSchema,
  DeleteAgentMessageSchema,
  ExportChatHtmlMessageSchema,
  ExportChatMdMessageSchema,
  ExportChatTexMessageSchema,
  RerunAgentMessageSchema,
  RestoreAgentMessageSchema,
} from '../historyViewMessages';
import {
  SetApiAccessModeInboundMessageSchema,
  SignInMessageSchema,
  SignOutMessageSchema,
} from '../profileViewMessages';
import { ReasoningLevelSchema } from './data';

const CMD = SETTINGS_VIEW_CMD;

/** Inbound message carrying a single boolean `enabled` toggle. */
function enabledFlag<T extends string>(command: T) {
  return z.object({ command: z.literal(command), enabled: z.boolean() });
}

// Provider key inbound messages (settings-only)
// Keep the outer optional: callers may omit apiKey so the host can prompt.
const SubmittedApiKeySchema = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined));

const SetProviderKeyMessageSchema = z.object({
  command: z.literal(CMD.SET_PROVIDER_KEY),
  provider: z.string().min(1),
  apiKey: SubmittedApiKeySchema,
});

const RemoveProviderKeyMessageSchema = z.object({
  command: z.literal(CMD.REMOVE_PROVIDER_KEY),
  provider: z.string().min(1),
});

const OpenProviderKeyUrlMessageSchema = z.object({
  command: z.literal(CMD.OPEN_PROVIDER_KEY_URL),
  provider: z.string().min(1),
});

const SetProviderStreamingMessageSchema = z.object({
  command: z.literal(CMD.SET_PROVIDER_STREAMING),
  provider: z.string().min(1),
  enabled: z.boolean(),
});

const SetProviderEndpointMessageSchema = z.object({
  command: z.literal(CMD.SET_PROVIDER_ENDPOINT),
  provider: z.string().min(1),
  endpoint: z.string(),
});

const SetGlobalStreamingMessageSchema = enabledFlag(CMD.SET_GLOBAL_STREAMING);

const SetProviderVscodeSettingMessageSchema = z.object({
  command: z.literal(CMD.SET_PROVIDER_VSCODE_SETTING),
  key: z.string().min(1),
  value: z.union([z.boolean(), z.number()]),
});

const OpenExternalUrlMessageSchema = z.object({
  command: z.literal(CMD.OPEN_EXTERNAL_URL),
  url: z.url(),
});

// Model selection inbound messages
const SetModelEnabledMessageSchema = z.object({
  command: z.literal(CMD.SET_MODEL_ENABLED),
  modelName: z.string().min(1),
  enabled: z.boolean(),
});

const SetHelperModelMessageSchema = z.object({
  command: z.literal(CMD.SET_HELPER_MODEL),
  modelName: z.string().min(1),
});

const SetModelReasoningLevelMessageSchema = z.object({
  command: z.literal(CMD.SET_MODEL_REASONING_LEVEL),
  modelName: z.string().min(1),
  /** The reasoning level to set, or undefined/null to reset to model default. */
  level: ReasoningLevelSchema.nullable(),
});

const SetPreferShortModelNamesMessageSchema = enabledFlag(
  CMD.SET_PREFER_SHORT_MODEL_NAMES,
);

const RequestModelAccessMessageSchema = z.object({
  command: z.literal(CMD.REQUEST_MODEL_ACCESS),
  modelName: z.string().min(1),
});

// Agent selection inbound messages
const OpenAgentYamlMessageSchema = z.object({
  command: z.literal(CMD.OPEN_AGENT_YAML),
  agentName: z.string().min(1),
  agentSource: AgentSourceSchema,
});

const SetAgentEnabledMessageSchema = z.object({
  command: z.literal(CMD.SET_AGENT_ENABLED),
  agentName: z.string().min(1),
  agentSource: AgentSourceSchema,
  category: AgentCategorySchema,
  enabled: z.boolean(),
});

const SetAllAgentsEnabledMessageSchema = z.object({
  command: z.literal(CMD.SET_ALL_AGENTS_ENABLED),
  category: AgentCategorySchema,
  source: AgentSourceSchema,
  enabled: z.boolean(),
});

const OpenAgentFolderMessageSchema = z.object({
  command: z.literal(CMD.OPEN_AGENT_FOLDER),
  folderType: z.literal('custom'),
});

const CreateAgentMessageSchema = z.object({
  command: z.literal(CMD.CREATE_AGENT),
  category: AgentCategorySchema,
  mode: z.enum(['ai', 'template']).prefault('ai'),
});

const CustomizeAgentMessageSchema = z.object({
  command: z.literal(CMD.CUSTOMIZE_AGENT),
  agentName: z.string().min(1),
  agentSource: AgentSourceSchema,
});

const DeleteCustomAgentMessageSchema = z.object({
  command: z.literal(CMD.DELETE_CUSTOM_AGENT),
  agentName: z.string().min(1),
});

const RevealAgentFileMessageSchema = z.object({
  command: z.literal(CMD.REVEAL_AGENT_FILE),
  agentName: z.string().min(1),
  agentSource: AgentSourceSchema,
});

const ViewRemoteAgentPromptMessageSchema = z.object({
  command: z.literal(CMD.VIEW_REMOTE_AGENT_PROMPT),
  agentName: z.string().min(1),
});

// Custom agent directory inbound messages
const SetCustomAgentDirMessageSchema = commandOnly(CMD.SET_CUSTOM_AGENT_DIR);
const ResetCustomAgentDirMessageSchema = commandOnly(
  CMD.RESET_CUSTOM_AGENT_DIR,
);

// Allow orchestrator kill inbound message
const SetAllowOrchestratorKillMessageSchema = enabledFlag(
  CMD.SET_ALLOW_ORCHESTRATOR_KILL,
);

const SetDetachSubagentsOnStopMessageSchema = enabledFlag(
  CMD.SET_DETACH_SUBAGENTS_ON_STOP,
);

// Agent team inbound messages
const ApplyAgentModePresetMessageSchema = z.object({
  command: z.literal(CMD.APPLY_AGENT_MODE_PRESET),
  presetId: z.string().min(1),
});

const SaveAgentModePresetMessageSchema = commandOnly(
  CMD.SAVE_AGENT_MODE_PRESET,
);

const DeleteAgentModePresetMessageSchema = z.object({
  command: z.literal(CMD.DELETE_AGENT_MODE_PRESET),
  presetId: z.string().min(1),
});

// Tool dashboard inbound messages
const OpenToolInstallUrlMessageSchema = z.object({
  command: z.literal(CMD.OPEN_TOOL_INSTALL_URL),
  url: z.url(),
});

const InstallToolExtensionMessageSchema = z.object({
  command: z.literal(CMD.INSTALL_TOOL_EXTENSION),
  extensionId: z.string().min(1),
});

const RecheckToolStatusMessageSchema = commandOnly(CMD.RECHECK_TOOL_STATUS);

const ToggleToolMessageSchema = z.object({
  command: z.literal(CMD.TOGGLE_TOOL),
  toolId: z.string().min(1),
  enabled: z.boolean(),
});

const RunToolCommandMessageSchema = z.object({
  command: z.literal(CMD.RUN_TOOL_COMMAND),
  toolId: z.string().min(1),
  kind: z.enum(['install', 'auth']),
});
export type ToolCommandKind = z.infer<
  typeof RunToolCommandMessageSchema
>['kind'];

// GitHub token messages (for PR subscription tool)
const GetGitHubTokenStatusMessageSchema = commandOnly(
  CMD.GET_GITHUB_TOKEN_STATUS,
);

const SetGitHubTokenMessageSchema = commandOnly(CMD.SET_GITHUB_TOKEN);

const RemoveGitHubTokenMessageSchema = commandOnly(CMD.REMOVE_GITHUB_TOKEN);

const OpenGitHubTokenUrlMessageSchema = commandOnly(CMD.OPEN_GITHUB_TOKEN_URL);

// ChatGPT subscription (Codex) sign-in messages
const SignInChatGptMessageSchema = commandOnly(CMD.SIGN_IN_CHATGPT);
const SignOutChatGptMessageSchema = commandOnly(CMD.SIGN_OUT_CHATGPT);
const SetChatGptPreferSubscriptionMessageSchema = enabledFlag(
  CMD.SET_CHATGPT_PREFER_SUBSCRIPTION,
);
const SetChatGptSubscriptionToolUseOnlyMessageSchema = enabledFlag(
  CMD.SET_CHATGPT_SUBSCRIPTION_TOOL_USE_ONLY,
);

const GetDesktopCrashReportingMessageSchema = commandOnly(
  CMD.GET_DESKTOP_CRASH_REPORTING,
);
const SetDesktopCrashReportingEnabledMessageSchema = enabledFlag(
  CMD.SET_DESKTOP_CRASH_REPORTING_ENABLED,
);
const SetDesktopCrashReportingDsnMessageSchema = commandOnly(
  CMD.SET_DESKTOP_CRASH_REPORTING_DSN,
);

const GetPRSubscriptionsMessageSchema = commandOnly(CMD.GET_PR_SUBSCRIPTIONS);

const UnsubscribePRMessageSchema = z.object({
  command: z.literal(CMD.UNSUBSCRIBE_PR),
  key: z.string().min(1),
});

const OpenPRSubscriptionStreamMessageSchema = z.object({
  command: z.literal(CMD.OPEN_PR_SUBSCRIPTION_STREAM),
  streamId: StreamTabIdSchema,
});

// LaTeX settings inbound messages
const ApplyLatexSettingsMessageSchema = z.object({
  command: z.literal(CMD.APPLY_LATEX_SETTINGS),
  field: z.enum(['outDir', 'autoRevealExclude']).optional(),
  reset: z.boolean().optional(),
});
const InstallLatexWorkshopMessageSchema = commandOnly(
  CMD.INSTALL_LATEX_WORKSHOP,
);
const RunInstallCommandMessageSchema = z.object({
  command: z.literal(CMD.RUN_INSTALL_COMMAND),
  installCommand: z.string().min(1),
});

// LaTeX/compile/diff config (storage-backed)
/**
 * Single-property write — frontend sends one value at a time. Surface a flat
 * shape (single outer branch keyed on `command`) so it composes into the
 * outer `SettingsViewInboundMessageSchema` discriminatedUnion('command', ...)
 * without producing duplicate command discriminators (which would crash the
 * whole inbound dispatcher at parse time, taking down every Settings view
 * interaction). Per-field value validation happens in the backend handler
 * using `LatexConfigValuesSchema.shape[field]`.
 */
// Use the canonical field list from latex.ts as the schema source so it can
// never drift from `LATEX_FIELD_TO_KEY`. z.enum accepts the readonly array
// directly and preserves the literal types so `LatexConfigField` (re-exported
// from the entry barrel) stays the same union of string literals consumers
// already rely on.
const LatexConfigFieldSchema = z.enum(LATEX_CONFIG_FIELDS);

const SetLatexConfigValueMessageSchema = z.object({
  command: z.literal(CMD.SET_LATEX_CONFIG_VALUE),
  field: LatexConfigFieldSchema,
  // Loose at the schema level — the handler validates per-field via
  // LatexConfigValuesSchema.shape[field] before writing to workspace state.
  // `undefined` clears the key (returns to documented default).
  value: z.union([z.boolean(), z.number(), z.string(), z.null()]).optional(),
});

// Experimental settings inbound messages
const GetInlineCriticismEnabledMessageSchema = commandOnly(
  CMD.GET_INLINE_CRITICISM_ENABLED,
);
const SetInlineCriticismEnabledMessageSchema = enabledFlag(
  CMD.SET_INLINE_CRITICISM_ENABLED,
);

// Approval settings inbound messages
const SetBashApprovalEnabledMessageSchema = enabledFlag(
  CMD.SET_BASH_APPROVAL_ENABLED,
);

// Generic catalog-driven state-setting write. One flat branch (single outer
// discriminator on `command`, per the SET_LATEX_CONFIG_VALUE precedent above)
// carrying the canonical `STATE_SETTINGS` key and a loose value. Per-value
// validation happens in the backend handler via the entry's own schema
// (`stateSettingByKey(key).schema`), so the union stays a plain flat branch and
// never grows a nested per-key discriminator (which would crash the dispatcher).
const UpdateStateSettingMessageSchema = z.object({
  command: z.literal(CMD.UPDATE_STATE_SETTING),
  key: z.string().min(1),
  value: z.union([z.boolean(), z.number(), z.string(), z.null()]).optional(),
});

// Navigation inbound messages
const OpenVscodeSettingsMessageSchema = commandOnly(CMD.OPEN_VSCODE_SETTINGS);

// Settings-tab IPC is read-only: state transitions are owned by the
// agent-side plan tool, not the user. Don't add mutation commands here.
const GetGoalListMessageSchema = commandOnly(CMD.GET_GOAL_LIST);
const RevealGoalStreamMessageSchema = z.object({
  command: z.literal(CMD.REVEAL_GOAL_STREAM),
  streamId: StreamTabIdSchema,
});

// ============================================================
// Discriminated union of all inbound messages
// ============================================================

export const SettingsViewInboundMessageSchema = z.discriminatedUnion(
  'command',
  [
    // Lifecycle
    WebviewReadyMessageSchema,
    // Navigation messages
    OpenVscodeSettingsMessageSchema,
    // Tool dashboard messages
    OpenToolInstallUrlMessageSchema,
    InstallToolExtensionMessageSchema,
    RecheckToolStatusMessageSchema,
    ToggleToolMessageSchema,
    RunToolCommandMessageSchema,
    // LaTeX settings messages
    ApplyLatexSettingsMessageSchema,
    InstallLatexWorkshopMessageSchema,
    RunInstallCommandMessageSchema,
    SetLatexConfigValueMessageSchema,
    GetInlineCriticismEnabledMessageSchema,
    SetInlineCriticismEnabledMessageSchema,
    // Memory messages
    GetMemoryDataMessageSchema,
    GetMemoryPreviewMessageSchema,
    OpenMemoryFileMessageSchema,
    OpenMemoryFolderMessageSchema,
    DeleteMemoryMessageSchema,
    SetMemoryEnabledMessageSchema,
    PinMemoryMessageSchema,
    UnpinMemoryMessageSchema,
    // History messages
    RerunAgentMessageSchema,
    RestoreAgentMessageSchema,
    DeleteAgentMessageSchema,
    ClearHistoryMessageSchema,
    ExportChatMdMessageSchema,
    ExportChatTexMessageSchema,
    ExportChatHtmlMessageSchema,
    // Profile messages
    SignInMessageSchema,
    SignOutMessageSchema,
    SetApiAccessModeInboundMessageSchema,
    SetProviderKeyMessageSchema,
    RemoveProviderKeyMessageSchema,
    OpenProviderKeyUrlMessageSchema,
    SetProviderStreamingMessageSchema,
    SetProviderEndpointMessageSchema,
    SetGlobalStreamingMessageSchema,
    SetProviderVscodeSettingMessageSchema,
    OpenExternalUrlMessageSchema,
    // Model selection messages
    SetModelEnabledMessageSchema,
    SetHelperModelMessageSchema,
    SetModelReasoningLevelMessageSchema,
    SetPreferShortModelNamesMessageSchema,
    RequestModelAccessMessageSchema,
    // Agent selection messages
    OpenAgentYamlMessageSchema,
    SetAgentEnabledMessageSchema,
    SetAllAgentsEnabledMessageSchema,
    OpenAgentFolderMessageSchema,
    CreateAgentMessageSchema,
    CustomizeAgentMessageSchema,
    DeleteCustomAgentMessageSchema,
    RevealAgentFileMessageSchema,
    ViewRemoteAgentPromptMessageSchema,
    // Custom agent directory messages
    SetCustomAgentDirMessageSchema,
    ResetCustomAgentDirMessageSchema,
    // Multi-Agent orchestration messages
    SetAllowOrchestratorKillMessageSchema,
    SetDetachSubagentsOnStopMessageSchema,
    // GitHub token messages
    GetGitHubTokenStatusMessageSchema,
    SetGitHubTokenMessageSchema,
    RemoveGitHubTokenMessageSchema,
    OpenGitHubTokenUrlMessageSchema,
    // ChatGPT subscription sign-in messages
    SignInChatGptMessageSchema,
    SignOutChatGptMessageSchema,
    SetChatGptPreferSubscriptionMessageSchema,
    SetChatGptSubscriptionToolUseOnlyMessageSchema,
    GetDesktopCrashReportingMessageSchema,
    SetDesktopCrashReportingEnabledMessageSchema,
    SetDesktopCrashReportingDsnMessageSchema,
    GetPRSubscriptionsMessageSchema,
    UnsubscribePRMessageSchema,
    OpenPRSubscriptionStreamMessageSchema,
    // Approval settings messages
    SetBashApprovalEnabledMessageSchema,
    // Generic catalog-driven state-setting write (git-author + agent controls)
    UpdateStateSettingMessageSchema,
    // Agent team messages
    ApplyAgentModePresetMessageSchema,
    SaveAgentModePresetMessageSchema,
    DeleteAgentModePresetMessageSchema,
    // Goal settings-tab messages (read-only)
    GetGoalListMessageSchema,
    RevealGoalStreamMessageSchema,
  ],
);

export type SettingsViewInboundMessage = z.infer<
  typeof SettingsViewInboundMessageSchema
>;

/** Type helper for extracting a specific inbound message by command. */
export type SettingsMessageFor<
  C extends SettingsViewInboundMessage['command'],
> = Extract<SettingsViewInboundMessage, { command: C }>;

export type SettingsViewInboundHandlerRegistry =
  HandlerRegistry<SettingsViewInboundMessage>;

export const dispatchSettingsViewInbound = createDispatcher(
  SettingsViewInboundMessageSchema,
);
