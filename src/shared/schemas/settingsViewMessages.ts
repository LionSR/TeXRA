/**
 * Schema definitions for SettingsView messages.
 *
 * Combines all messages from MemoryView, HistoryView, and ProfileView
 * into a single unified schema for the settings view.
 */
import { z } from 'zod';

import {
  createDispatcher,
  type HandlerRegistry,
} from '@shared/utils/dispatcher';

// SETTINGS_VIEW_CMD is defined in commands.ts to avoid circular dependency.
// Re-exported here for consumers that expect it from the schema module.
import {
  SETTINGS_VIEW_CMD,
  SETTINGS_VIEW_COMMANDS,
} from '@common/webview/commands';
import { AgentCategorySchema, AgentSourceSchema } from './agent';
import {
  DeleteMemoryMessageSchema,
  GetMemoryDataMessageSchema,
  GetMemoryEnabledMessageSchema,
  OpenMemoryFileMessageSchema,
  OpenMemoryFolderMessageSchema,
  SetMemoryEnabledMessageSchema,
} from './memoryViewMessages';
import {
  ClearHistoryMessageSchema,
  DeleteAgentMessageSchema,
  GetHistoryDataMessageSchema,
  RerunAgentMessageSchema,
  RestoreAgentMessageSchema,
} from './historyViewMessages';
import { commandOnly } from './messageFactories';
import {
  GetProfileDataMessageSchema,
  NumberVscodeSettingSchema,
  SelectAgentInboundMessageSchema,
  SetApiAccessModeInboundMessageSchema,
  SignInMessageSchema,
  SignOutMessageSchema,
} from './profileViewMessages';
export { SETTINGS_VIEW_CMD };

/** Tab name order - single source of truth for tab indices */
export const SETTINGS_TAB_ORDER = [
  'MEMORY',
  'HISTORY',
  'MODELS',
  'AGENTS',
  'MULTI_AGENT',
  'TOOLS',
] as const;

export type SettingsTabName = (typeof SETTINGS_TAB_ORDER)[number];

/** Tab indices derived from ordered array */
export const SETTINGS_TAB = Object.fromEntries(
  SETTINGS_TAB_ORDER.map((name, index) => [name, index]),
) as Record<SettingsTabName, number>;

export type SettingsTab = (typeof SETTINGS_TAB)[keyof typeof SETTINGS_TAB];

/** Outbound schema to switch tabs */
export const SetTabMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_CMD.SET_TAB),
  tabIndex: z
    .int()
    .min(0)
    .max(SETTINGS_TAB_ORDER.length - 1),
  agentSubTab: AgentCategorySchema.optional(),
});

export type SetTabMessage = z.infer<typeof SetTabMessageSchema>;

const CMD = SETTINGS_VIEW_CMD;

// Re-export data schemas from individual view messages
export {
  MemoryViewItemSchema,
  type MemoryViewItem,
  type MemoryPathMessage,
  type MemoryDeleteMessage,
  type MemoryEnabledMessage,
} from './memoryViewMessages';

export {
  HistoryItemSchema,
  type HistoryItem,
  type HistoryIdMessage,
} from './historyViewMessages';

export {
  ProfileUserSchema,
  RemoteAgentSchema,
  ApiAccessModeSchema,
  TierConstantsSchema,
  ProviderKeyStatusSchema,
  ProviderVscodeSettingSchema,
  NumberVscodeSettingSchema,
  type ProfileUser,
  type RemoteAgent,
  type ApiAccessMode,
  type TierConstants,
  type ProviderKeyStatus,
  type ProviderVscodeSetting,
  type NumberVscodeSetting,
  type SelectAgentMessage,
  type SetApiAccessModeMessage,
} from './profileViewMessages';

// ============================================================
// Agent selection data schema
// ============================================================

export const AgentSelectionItemSchema = z.object({
  name: z.string(),
  source: AgentSourceSchema,
  category: AgentCategorySchema,
  description: z.string().optional(),
  hasPath: z.boolean(),
  filePath: z.string().optional(),
  tools: z.array(z.string()).optional(),
  hasMultiple: z.boolean(), // supports multiple outputs (informational)
  hasMultiplePath: z.boolean(), // has openable _multiple YAML file
  enabled: z.boolean(),
});
export type AgentSelectionItem = z.infer<typeof AgentSelectionItemSchema>;

/** Outbound: backend → frontend agent selection data */
export const UpdateAgentSelectionMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION),
  workflow: z.array(AgentSelectionItemSchema),
  toolUse: z.array(AgentSelectionItemSchema),
});
export type UpdateAgentSelectionMessage = z.infer<
  typeof UpdateAgentSelectionMessageSchema
>;

// ============================================================
// Model selection data schema
// ============================================================

export const ModelSelectionItemSchema = z.object({
  name: z.string(),
  provider: z.string(),
  enabled: z.boolean(),
  deprecated: z.boolean(),
  contextWindow: z.string().optional(),
  cost: z.string().optional(),
});
export type ModelSelectionItem = z.infer<typeof ModelSelectionItemSchema>;

/** Outbound: backend → frontend model selection data */
export const UpdateModelSelectionMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION),
  models: z.array(ModelSelectionItemSchema),
  polishModel: z.string(),
});
export type UpdateModelSelectionMessage = z.infer<
  typeof UpdateModelSelectionMessageSchema
>;

// ============================================================
// Auto-show remote agents data schema
// ============================================================

/** Outbound: backend → frontend auto-show remote agents toggle */
export const UpdateAutoShowRemoteMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_AUTO_SHOW_REMOTE),
  enabled: z.boolean(),
});
export type UpdateAutoShowRemoteMessage = z.infer<
  typeof UpdateAutoShowRemoteMessageSchema
>;

// ============================================================
// Custom agent directory data schema
// ============================================================

/** Outbound: backend → frontend custom agent directory info */
export const UpdateCustomAgentDirMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_CUSTOM_AGENT_DIR),
  path: z.string(),
  isDefault: z.boolean(),
});
export type UpdateCustomAgentDirMessage = z.infer<
  typeof UpdateCustomAgentDirMessageSchema
>;

// ============================================================
// Super YOLO enabled data schema
// ============================================================

/** Outbound: backend → frontend Super YOLO enabled toggle + reliability settings */
export const UpdateSuperYoloEnabledMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_SUPER_YOLO_ENABLED),
  enabled: z.boolean(),
  reliabilitySettings: z.array(NumberVscodeSettingSchema).prefault([]),
});
export type UpdateSuperYoloEnabledMessage = z.infer<
  typeof UpdateSuperYoloEnabledMessageSchema
>;

// ============================================================
// Tool dashboard data schemas
// ============================================================

/** Status of a tool dependency */
export const ToolStatusSchema = z.enum(['available', 'not-found', 'unknown']);
export type ToolStatus = z.infer<typeof ToolStatusSchema>;

/** Category for grouping tools in the dashboard */
export const ToolCategorySchema = z.enum([
  'file',
  'latex',
  'academic',
  'web',
  'computation',
  'lean',
  'workflow',
  'system',
]);
export type ToolCategory = z.infer<typeof ToolCategorySchema>;

/** Individual tool within a group — carries an optional description for tooltips. */
export const ToolInfoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});
export type ToolInfo = z.infer<typeof ToolInfoSchema>;

/** Single tool entry in the dashboard */
export const ToolDashboardItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: ToolCategorySchema,
  description: z.string(),
  tools: z.array(ToolInfoSchema),
  status: ToolStatusSchema,
  requiresSetup: z.boolean(),
  installGuide: z.string().optional(),
  installUrl: z.string().optional(),
  configNotes: z.string().optional(),
});
export type ToolDashboardItem = z.infer<typeof ToolDashboardItemSchema>;

/** Outbound: backend → frontend tool dashboard data */
export const UpdateToolDashboardMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD),
  items: z.array(ToolDashboardItemSchema),
});
export type UpdateToolDashboardMessage = z.infer<
  typeof UpdateToolDashboardMessageSchema
>;

// ============================================================
// Inbound message schemas (frontend → backend)
// ============================================================

// Memory, History, and Profile inbound schemas are imported from their
// respective modules (memoryViewMessages, historyViewMessages, profileViewMessages)
// to avoid duplicating definitions. The command literal strings are identical.

// Provider key inbound messages (settings-only)
const SetProviderKeyMessageSchema = z.object({
  command: z.literal(CMD.SET_PROVIDER_KEY),
  provider: z.string().min(1),
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

const SetGlobalStreamingMessageSchema = z.object({
  command: z.literal(CMD.SET_GLOBAL_STREAMING),
  enabled: z.boolean(),
});

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
const GetModelSelectionMessageSchema = commandOnly(CMD.GET_MODEL_SELECTION);

const SetModelEnabledMessageSchema = z.object({
  command: z.literal(CMD.SET_MODEL_ENABLED),
  modelName: z.string().min(1),
  enabled: z.boolean(),
});

const SetPolishModelMessageSchema = z.object({
  command: z.literal(CMD.SET_POLISH_MODEL),
  modelName: z.string().min(1),
});

// Agent selection inbound messages
const GetAgentSelectionMessageSchema = commandOnly(CMD.GET_AGENT_SELECTION);

const OpenAgentYamlMessageSchema = z.object({
  command: z.literal(CMD.OPEN_AGENT_YAML),
  agentName: z.string().min(1),
  agentSource: AgentSourceSchema,
  variant: z.enum(['base', 'multiple']),
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
  folderType: z.enum(['custom', 'builtInWorkflow', 'builtInToolUse']),
});

const CreateAgentMessageSchema = z.object({
  command: z.literal(CMD.CREATE_AGENT),
  category: AgentCategorySchema,
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

// Auto-show remote agents inbound messages
const GetAutoShowRemoteMessageSchema = commandOnly(CMD.GET_AUTO_SHOW_REMOTE);

const SetAutoShowRemoteMessageSchema = z.object({
  command: z.literal(CMD.SET_AUTO_SHOW_REMOTE),
  enabled: z.boolean(),
});

// Custom agent directory inbound messages
const GetCustomAgentDirMessageSchema = commandOnly(CMD.GET_CUSTOM_AGENT_DIR);
const SetCustomAgentDirMessageSchema = commandOnly(CMD.SET_CUSTOM_AGENT_DIR);
const ResetCustomAgentDirMessageSchema = commandOnly(
  CMD.RESET_CUSTOM_AGENT_DIR,
);

// Super YOLO inbound messages
const GetSuperYoloEnabledMessageSchema = commandOnly(
  CMD.GET_SUPER_YOLO_ENABLED,
);

const SetSuperYoloEnabledMessageSchema = z.object({
  command: z.literal(CMD.SET_SUPER_YOLO_ENABLED),
  enabled: z.boolean(),
});

// Tool dashboard inbound messages
const GetToolDashboardDataMessageSchema = z.object({
  command: z.literal(CMD.GET_TOOL_DASHBOARD_DATA),
});

const OpenToolInstallUrlMessageSchema = z.object({
  command: z.literal(CMD.OPEN_TOOL_INSTALL_URL),
  url: z.string().url(),
});

const RecheckToolStatusMessageSchema = z.object({
  command: z.literal(CMD.RECHECK_TOOL_STATUS),
});

// Navigation inbound messages
const OpenVscodeSettingsMessageSchema = commandOnly(CMD.OPEN_VSCODE_SETTINGS);

// ============================================================
// Discriminated union of all inbound messages
// ============================================================

export const SettingsViewInboundMessageSchema = z.discriminatedUnion(
  'command',
  [
    // Navigation messages
    OpenVscodeSettingsMessageSchema,
    // Tool dashboard messages
    GetToolDashboardDataMessageSchema,
    OpenToolInstallUrlMessageSchema,
    RecheckToolStatusMessageSchema,
    // Memory messages
    GetMemoryDataMessageSchema,
    OpenMemoryFileMessageSchema,
    OpenMemoryFolderMessageSchema,
    DeleteMemoryMessageSchema,
    GetMemoryEnabledMessageSchema,
    SetMemoryEnabledMessageSchema,
    // History messages
    GetHistoryDataMessageSchema,
    RerunAgentMessageSchema,
    RestoreAgentMessageSchema,
    DeleteAgentMessageSchema,
    ClearHistoryMessageSchema,
    // Profile messages
    GetProfileDataMessageSchema,
    SelectAgentInboundMessageSchema,
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
    GetModelSelectionMessageSchema,
    SetModelEnabledMessageSchema,
    SetPolishModelMessageSchema,
    // Agent selection messages
    GetAgentSelectionMessageSchema,
    OpenAgentYamlMessageSchema,
    SetAgentEnabledMessageSchema,
    SetAllAgentsEnabledMessageSchema,
    OpenAgentFolderMessageSchema,
    CreateAgentMessageSchema,
    CustomizeAgentMessageSchema,
    DeleteCustomAgentMessageSchema,
    // Auto-show remote agents messages
    GetAutoShowRemoteMessageSchema,
    SetAutoShowRemoteMessageSchema,
    // Custom agent directory messages
    GetCustomAgentDirMessageSchema,
    SetCustomAgentDirMessageSchema,
    ResetCustomAgentDirMessageSchema,
    // Super YOLO messages
    GetSuperYoloEnabledMessageSchema,
    SetSuperYoloEnabledMessageSchema,
  ],
);

export type SettingsViewInboundMessage = z.infer<
  typeof SettingsViewInboundMessageSchema
>;

// ============================================================
// Type-safe handler registry and dispatcher
// ============================================================

export type SettingsViewInboundHandlerRegistry =
  HandlerRegistry<SettingsViewInboundMessage>;

export const dispatchSettingsViewInbound = createDispatcher(
  SettingsViewInboundMessageSchema,
);
