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
import { SETTINGS_VIEW_CMD } from '@common/webview/commands';
export { SETTINGS_VIEW_CMD };

/** Tab name order - single source of truth for tab indices */
export const SETTINGS_TAB_ORDER = [
  'MEMORY',
  'HISTORY',
  'MODELS',
  'AGENTS',
] as const;

export type SettingsTabName = (typeof SETTINGS_TAB_ORDER)[number];

/** Tab indices derived from ordered array */
export const SETTINGS_TAB = Object.fromEntries(
  SETTINGS_TAB_ORDER.map((name, index) => [name, index]),
) as Record<SettingsTabName, number>;

export type SettingsTab = (typeof SETTINGS_TAB)[keyof typeof SETTINGS_TAB];

/** Maximum valid tab index */
const MAX_TAB_INDEX = SETTINGS_TAB_ORDER.length - 1;

/** Outbound schema to switch tabs */
export const SetTabMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_CMD.SET_TAB),
  tabIndex: z.int().min(0).max(MAX_TAB_INDEX),
});

export type SetTabMessage = z.infer<typeof SetTabMessageSchema>;

// Alias for internal use
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
  type ProfileUser,
  type RemoteAgent,
  type ApiAccessMode,
  type TierConstants,
  type ProviderKeyStatus,
  type SelectAgentMessage,
  type SetApiAccessModeMessage,
} from './profileViewMessages';

// ============================================================
// Inbound message schemas (frontend → backend)
// ============================================================

// Memory inbound messages
const GetMemoryDataMessageSchema = z.object({
  command: z.literal(CMD.GET_MEMORY_DATA),
});

const OpenMemoryFileMessageSchema = z.object({
  command: z.literal(CMD.OPEN_MEMORY_FILE),
  storagePath: z.string().min(1),
});

const OpenMemoryFolderMessageSchema = z.object({
  command: z.literal(CMD.OPEN_MEMORY_FOLDER),
});

const DeleteMemoryMessageSchema = z.object({
  command: z.literal(CMD.DELETE_MEMORY),
  storagePath: z.string().min(1),
  displayPath: z.string().min(1),
});

const GetMemoryEnabledMessageSchema = z.object({
  command: z.literal(CMD.GET_MEMORY_ENABLED),
});

const SetMemoryEnabledMessageSchema = z.object({
  command: z.literal(CMD.SET_MEMORY_ENABLED),
  enabled: z.boolean(),
});

// History inbound messages
const GetHistoryDataMessageSchema = z.object({
  command: z.literal(CMD.GET_HISTORY_DATA),
});

const RerunAgentMessageSchema = z.object({
  command: z.literal(CMD.RERUN_AGENT),
  historyId: z.string().min(1),
});

const RestoreAgentMessageSchema = z.object({
  command: z.literal(CMD.RESTORE_AGENT),
  historyId: z.string().min(1),
});

const DeleteAgentMessageSchema = z.object({
  command: z.literal(CMD.DELETE_AGENT),
  historyId: z.string().min(1),
});

const ClearHistoryMessageSchema = z.object({
  command: z.literal(CMD.CLEAR_HISTORY),
});

// Profile inbound messages
const GetProfileDataMessageSchema = z.object({
  command: z.literal(CMD.GET_PROFILE_DATA),
});

const SelectAgentInboundMessageSchema = z.object({
  command: z.literal(CMD.SELECT_AGENT),
  agentName: z.string().min(1),
});

const SignInMessageSchema = z.object({
  command: z.literal(CMD.SIGN_IN),
});

const SignOutMessageSchema = z.object({
  command: z.literal(CMD.SIGN_OUT),
});

const SetApiAccessModeInboundMessageSchema = z.object({
  command: z.literal(CMD.SET_API_ACCESS_MODE),
  mode: z.enum(['included', 'personal']),
});

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

// Navigation inbound messages
const OpenVscodeSettingsMessageSchema = z.object({
  command: z.literal(CMD.OPEN_VSCODE_SETTINGS),
});

// ============================================================
// Discriminated union of all inbound messages
// ============================================================

export const SettingsViewInboundMessageSchema = z.discriminatedUnion(
  'command',
  [
    // Navigation messages
    OpenVscodeSettingsMessageSchema,
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
