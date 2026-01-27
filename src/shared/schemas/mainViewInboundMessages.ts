/**
 * Schema-driven inbound message definitions for MainView.
 *
 * These are messages sent FROM the frontend TO the backend.
 * Uses discriminated union for single-parse validation at dispatch.
 *
 * IMPORTANT: This file is shared between frontend and backend.
 * Do NOT import from @agent, @tools, @logger, or other backend-only modules.
 */
import { z } from 'zod';

import {
  createDispatcher,
  type HandlerRegistry,
} from '@shared/utils/dispatcher';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';

import { ExtendedFileTypeSchema, SessionTypeSchema } from './mainViewState';

// ============================================================
// Helpers to reduce boilerplate
// ============================================================

/** Create a command-only message schema (no payload) */
const commandOnly = <T extends string>(command: T) =>
  z.object({ command: z.literal(command) });

/** Create a message schema with optional filePath field */
const withOptionalFilePath = <T extends string>(command: T) =>
  z.object({ command: z.literal(command), filePath: z.string().optional() });

/** Create a message schema with files array */
const withFilesArray = <T extends string>(command: T) =>
  z.object({ command: z.literal(command), files: z.array(z.string()) });

// ============================================================
// Message schemas - grouped by category
// ============================================================

// --- Common messages ---
const CommonMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.WEBVIEW_READY),
  commandOnly(MAIN_VIEW_COMMANDS.GET_THEME),
  commandOnly(MAIN_VIEW_COMMANDS.GET_DEBUG_MODE),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.THEME_SET),
    theme: z.enum(['dark', 'light']),
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.DEBUG_MODE_SET),
    debugMode: z.boolean(),
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE),
    text: z.string().min(1),
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.SHOW_INSTRUCTION),
    key: z.string().min(1),
    text: z.string().min(1),
  }),
] as const;

// --- Settings messages ---
const SettingsMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.SETTINGS_OPEN),
  commandOnly(MAIN_VIEW_COMMANDS.OPEN_MODEL_SETTINGS),
  commandOnly(MAIN_VIEW_COMMANDS.OPEN_AGENT_DOCS),
  commandOnly(MAIN_VIEW_COMMANDS.OPEN_INSTALLATION_DOCS),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS),
    sessionType: SessionTypeSchema.optional(),
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY),
    customDirSet: z.boolean().optional(),
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.MODEL_SELECTED),
    model: z.string().min(1),
  }),
] as const;

// --- Execution messages ---
// EXECUTE carries full agent config - use passthrough to allow all fields
const ExecutionMessages = [
  z.looseObject({ command: z.literal(MAIN_VIEW_COMMANDS.EXECUTE) }),
  z.looseObject({ command: z.literal(MAIN_VIEW_COMMANDS.MERGE) }),
  z.looseObject({ command: z.literal(MAIN_VIEW_COMMANDS.COMPARE) }),
  z.looseObject({ command: z.literal(MAIN_VIEW_COMMANDS.ACCEPT_EDITED) }),
] as const;

// --- File selection messages (command-only) ---
const FileSelectionMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.SELECT_INPUT_FILE),
  commandOnly(MAIN_VIEW_COMMANDS.SELECT_REFERENCE_FILE),
  commandOnly(MAIN_VIEW_COMMANDS.SELECT_AUXILIARY_FILE),
  commandOnly(MAIN_VIEW_COMMANDS.SELECT_MEDIA_FILE),
  commandOnly(MAIN_VIEW_COMMANDS.SELECT_EDITED_FILE),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.SELECT_MULTIPLE_FILES),
    fileType: ExtendedFileTypeSchema,
  }),
] as const;

// --- File selected messages (with optional filePath) ---
const FileSelectedMessages = [
  withOptionalFilePath(MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED),
  withOptionalFilePath(MAIN_VIEW_COMMANDS.REFERENCE_FILE_SELECTED),
  withOptionalFilePath(MAIN_VIEW_COMMANDS.AUXILIARY_FILE_SELECTED),
  withOptionalFilePath(MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED),
  withOptionalFilePath(MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED),
] as const;

// --- Request file messages (command-only) ---
const RequestFileMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.REQUEST_INPUT_FILE),
  commandOnly(MAIN_VIEW_COMMANDS.REQUEST_REFERENCE_FILE),
  commandOnly(MAIN_VIEW_COMMANDS.REQUEST_AUXILIARY_FILE),
  commandOnly(MAIN_VIEW_COMMANDS.REQUEST_MEDIA_FILE),
  commandOnly(MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE),
  commandOnly(MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE),
  commandOnly(MAIN_VIEW_COMMANDS.REQUEST_DEFAULT_OUTPUT_FILES),
] as const;

// --- Set files messages (with files array) ---
const SetFilesMessages = [
  withFilesArray(MAIN_VIEW_COMMANDS.SET_INPUT_FILES),
  withFilesArray(MAIN_VIEW_COMMANDS.SET_REFERENCE_FILES),
  withFilesArray(MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILES),
  withFilesArray(MAIN_VIEW_COMMANDS.SET_MEDIA_FILES),
] as const;

// --- Other file operation messages ---
const FileOperationMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.GET_CURRENT_FILE),
  commandOnly(MAIN_VIEW_COMMANDS.REFRESH_ALL_FILES),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.ADD_OPENED_FILES),
    fileType: ExtendedFileTypeSchema,
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.UPDATE_INPUT_FILES),
    fileType: z.literal('input'),
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.UPDATE_REFERENCE_FILES),
    fileType: z.literal('reference'),
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.UPDATE_AUXILIARY_FILES),
    fileType: z.literal('auxiliary'),
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.UPDATE_MEDIA_FILES),
    fileType: z.literal('media'),
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.UPDATE_OUTPUT_FILES),
    fileType: z.literal('output'),
  }),
] as const;

// --- Instruction messages ---
const InstructionMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.TRANSCRIBE_INSTRUCTION),
  z.looseObject({
    command: z.literal(MAIN_VIEW_COMMANDS.POLISH_INSTRUCTION_TEXT),
    text: z.string(),
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.CLIPBOARD_IMAGE),
    base64: z.string(),
    mediaType: z.string(),
    fileName: z.string(),
  }),
] as const;

// --- Recording messages ---
const RecordingMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.START_RECORDING),
  commandOnly(MAIN_VIEW_COMMANDS.STOP_RECORDING),
] as const;

// --- API key messages ---
const ApiKeyMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.OPEN_SET_API_KEY),
  commandOnly(MAIN_VIEW_COMMANDS.OPEN_API_KEY_GUIDE),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.OPEN_SET_PROVIDER_API_KEY),
    provider: z.string().min(1).optional(),
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.OPEN_PROVIDER_API_KEY_URL),
    provider: z.string().min(1).optional(),
  }),
] as const;

// --- Banner messages ---
const BannerMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER),
  commandOnly(MAIN_VIEW_COMMANDS.HIDE_API_KEY_BANNER),
  commandOnly(MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER),
  commandOnly(MAIN_VIEW_COMMANDS.HIDE_AGENT_CONFIG_BANNER),
  commandOnly(MAIN_VIEW_COMMANDS.HIDE_DEPENDENCY_BANNER),
  commandOnly(MAIN_VIEW_COMMANDS.RECHECK_DEPENDENCIES),
  commandOnly(MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER),
  commandOnly(MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER),
  commandOnly(MAIN_VIEW_COMMANDS.SIGN_IN_FROM_BANNER),
  commandOnly(MAIN_VIEW_COMMANDS.DISMISS_LOGIN_BANNER),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER),
    missingTools: z.array(z.string()).optional(),
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.UPDATE_DEPENDENCY_REMINDER_SETTING),
    value: z.boolean(),
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.OPEN_INSTALL_GUIDE),
    tool: z.string().min(1),
  }),
] as const;

// --- Git/diff messages ---
const GitDiffMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS),
  commandOnly(MAIN_VIEW_COMMANDS.REFRESH_COMMITS),
  commandOnly(MAIN_VIEW_COMMANDS.LATEXDIFF),
  commandOnly(MAIN_VIEW_COMMANDS.LATEXDIFFVC),
  commandOnly(MAIN_VIEW_COMMANDS.PACK_LATEXDIFFVC),
  commandOnly(MAIN_VIEW_COMMANDS.CLEAN_LATEXDIFFVC),
] as const;

// --- Housekeeping messages ---
const HousekeepingMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.CLEAN_OUTPUT),
  commandOnly(MAIN_VIEW_COMMANDS.CLEAN_BUILD),
  commandOnly(MAIN_VIEW_COMMANDS.INDENT_TEX),
  commandOnly(MAIN_VIEW_COMMANDS.PACK_SINGLE),
  commandOnly(MAIN_VIEW_COMMANDS.CLEAN_SINGLE),
  commandOnly(MAIN_VIEW_COMMANDS.PACK_MULTIPLE),
  commandOnly(MAIN_VIEW_COMMANDS.CLEAN_MULTIPLE),
] as const;

// --- Navigation messages ---
const NavigationMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.SHOW_AGENT_HISTORY),
] as const;

// ============================================================
// Discriminated union of all inbound messages
// ============================================================

export const MainViewInboundMessageSchema = z.discriminatedUnion('command', [
  ...CommonMessages,
  ...SettingsMessages,
  ...ExecutionMessages,
  ...FileSelectionMessages,
  ...FileSelectedMessages,
  ...RequestFileMessages,
  ...SetFilesMessages,
  ...FileOperationMessages,
  ...InstructionMessages,
  ...RecordingMessages,
  ...ApiKeyMessages,
  ...BannerMessages,
  ...GitDiffMessages,
  ...HousekeepingMessages,
  ...NavigationMessages,
]);

export type MainViewInboundMessage = z.infer<
  typeof MainViewInboundMessageSchema
>;

// ============================================================
// Type-safe handler registry and dispatcher
// ============================================================

export type MainViewInboundHandlerRegistry =
  HandlerRegistry<MainViewInboundMessage>;

export const dispatchMainViewInbound = createDispatcher(
  MainViewInboundMessageSchema,
);
