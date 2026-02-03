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

/**
 * Command string literals for schema definitions.
 * Must match SETTINGS_VIEW_COMMANDS values exactly.
 * Exported for use in MessageFor type helper in message handler.
 */
export const SETTINGS_VIEW_CMD = {
  // Navigation commands
  SET_TAB: 'setTab',
  OPEN_VSCODE_SETTINGS: 'openVscodeSettings',
  // Memory commands
  GET_MEMORY_DATA: 'getMemoryData',
  OPEN_MEMORY_FILE: 'openMemoryFile',
  OPEN_MEMORY_FOLDER: 'openMemoryFolder',
  DELETE_MEMORY: 'deleteMemory',
  GET_MEMORY_ENABLED: 'getMemoryEnabled',
  SET_MEMORY_ENABLED: 'setMemoryEnabled',
  // History commands
  GET_HISTORY_DATA: 'getHistoryData',
  RERUN_AGENT: 'rerunAgent',
  RESTORE_AGENT: 'restoreAgent',
  DELETE_AGENT: 'deleteAgent',
  CLEAR_HISTORY: 'clearHistory',
  // Profile commands
  GET_PROFILE_DATA: 'getProfileData',
  SELECT_AGENT: 'selectAgent',
  SIGN_IN: 'signIn',
  SIGN_OUT: 'signOut',
  SET_API_ACCESS_MODE: 'setApiAccessMode',
} as const;

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
  tabIndex: z.number().int().min(0).max(MAX_TAB_INDEX),
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
  type ProfileUser,
  type RemoteAgent,
  type ApiAccessMode,
  type TierConstants,
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
