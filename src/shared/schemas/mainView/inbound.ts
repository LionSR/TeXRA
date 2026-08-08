/**
 * MainView inbound message schemas (frontend -> backend): SELECT_*, REQUEST_*,
 * EXECUTE, git-diff, housekeeping, and the dispatcher they compose into.
 *
 * Messages are grouped by domain into `as const` tuples and spread into a
 * single `discriminatedUnion('command', ...)` so the dispatcher narrows by
 * command literal.
 */
import { z } from 'zod';

import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import {
  createDispatcher,
  type HandlerRegistry,
} from '@shared/utils/dispatcher';

import { SwitchViewMessageSchema, ThemeSchema } from '../commonViewMessages';
import { commandOnly, withFilesArray } from '../messageFactories';
import {
  CurrentFileTypeSchema,
  ExtendedDocumentFileTypeSchema,
  MultipleDocumentFileTypeSchema,
} from '../fileTypes';
import { GettingStartedActionSchema, SessionTypeSchema } from './state';
import {
  MainViewExecuteFilesSchema,
  MainViewExecuteInboundMessageSchema,
} from './executeMessage';

const CommonMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.WEBVIEW_READY),
  commandOnly(MAIN_VIEW_COMMANDS.GET_THEME),
  commandOnly(MAIN_VIEW_COMMANDS.GET_DEBUG_MODE),
  SwitchViewMessageSchema,
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.THEME_SET),
    theme: ThemeSchema,
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

const OpenAgentSettingsMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS),
  sessionType: SessionTypeSchema.optional(),
});

const OpenAgentDirectoryMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY),
  customDirSet: z.boolean().optional(),
});

const SettingsMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.SETTINGS_OPEN),
  commandOnly(MAIN_VIEW_COMMANDS.OPEN_MODEL_SETTINGS),
  commandOnly(MAIN_VIEW_COMMANDS.OPEN_MULTI_AGENT_SETTINGS),
  commandOnly(MAIN_VIEW_COMMANDS.OPEN_AGENT_DOCS),
  commandOnly(MAIN_VIEW_COMMANDS.OPEN_INSTALLATION_DOCS),
  OpenAgentSettingsMessageSchema,
  OpenAgentDirectoryMessageSchema,
] as const;

// MERGE sends the primary input plus the edited file; COMPARE and
// ACCEPT_EDITED send the base/edited pair. Each command
// needs a distinct required-field shape, so they get their own schemas
// instead of a shared loose object — file paths flowing straight into VS
// Code commands (see executionHandlers.handleFileOperation) must be
// validated at the dispatch boundary like every other inbound message.
const MergeMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.MERGE),
  inputFile: z.string(),
  editedFile: z.string(),
});
export type MergeMessage = z.infer<typeof MergeMessageSchema>;

const baseEditedPairFields = {
  baseFile: z.string(),
  editedFile: z.string(),
};

const CompareMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.COMPARE),
  ...baseEditedPairFields,
});
export type CompareMessage = z.infer<typeof CompareMessageSchema>;

const AcceptEditedMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.ACCEPT_EDITED),
  ...baseEditedPairFields,
});
type AcceptEditedMessage = z.infer<typeof AcceptEditedMessageSchema>;

/** Union consumed by `executionHandlers.handleFileOperation`. */
export type FileOperationMessage =
  MergeMessage | CompareMessage | AcceptEditedMessage;

const ExecutionMessages = [
  MainViewExecuteInboundMessageSchema,
  MergeMessageSchema,
  CompareMessageSchema,
  AcceptEditedMessageSchema,
] as const;

const FileSelectionMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.SELECT_EDITED_FILE),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.SELECT_MULTIPLE_FILES),
    fileType: ExtendedDocumentFileTypeSchema,
    currentFile: z.string().optional(),
  }),
] as const;

const RequestFileMessages = [
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE),
    notifyWhenEmpty: z.boolean().nullish(),
    baseFile: z.string().optional(),
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE),
    notifyWhenEmpty: z.boolean().nullish(),
    preserveBaseFile: z.boolean().optional(),
  }),
] as const;

const SetFilesMessages = [
  withFilesArray(MAIN_VIEW_COMMANDS.SET_INPUT_FILES),
  withFilesArray(MAIN_VIEW_COMMANDS.SET_CONTEXT_FILES),
  withFilesArray(MAIN_VIEW_COMMANDS.SET_MEDIA_FILES),
] as const;

const FileOperationMessages = [
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.GET_CURRENT_FILE),
    fileType: CurrentFileTypeSchema.optional(),
    baseFile: z.string().optional(),
  }),
  commandOnly(MAIN_VIEW_COMMANDS.REFRESH_ALL_FILES),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.ADD_OPENED_FILES),
    fileType: ExtendedDocumentFileTypeSchema,
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.ATTACH_DROPPED_FILES),
    paths: z.array(z.string()),
    target: MultipleDocumentFileTypeSchema.nullish(),
  }),
  withFilesArray(MAIN_VIEW_COMMANDS.UPDATE_INPUT_FILES).extend({
    fileType: z.literal('input'),
  }),
  withFilesArray(MAIN_VIEW_COMMANDS.UPDATE_CONTEXT_FILES).extend({
    fileType: z.literal('context'),
  }),
  withFilesArray(MAIN_VIEW_COMMANDS.UPDATE_MEDIA_FILES).extend({
    fileType: z.literal('media'),
  }),
  withFilesArray(MAIN_VIEW_COMMANDS.UPDATE_OUTPUT_FILES).extend({
    fileType: z.literal('output'),
  }),
] as const;

const InstructionMessages = [
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.POLISH_INSTRUCTION_TEXT),
    text: z.string(),
    agent: z.string().optional(),
    model: z.string().optional(),
    ...MainViewExecuteFilesSchema.pick({
      inputFiles: true,
      contextFiles: true,
      mediaFiles: true,
      outputFiles: true,
      inputFilesActive: true,
      contextFilesActive: true,
      mediaFilesActive: true,
    }).shape,
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.CLIPBOARD_IMAGE),
    base64: z.string(),
    mediaType: z.string(),
    fileName: z.string(),
  }),
] as const;

const RecordingMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.START_RECORDING),
  commandOnly(MAIN_VIEW_COMMANDS.STOP_RECORDING),
] as const;

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
  commandOnly(MAIN_VIEW_COMMANDS.DISMISS_ORCHESTRATOR_BANNER),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.GETTING_STARTED_ACTION),
    action: GettingStartedActionSchema,
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER),
    missingTools: z.array(z.string()).optional(),
  }),
  z.object({
    command: z.literal(MAIN_VIEW_COMMANDS.OPEN_INSTALL_GUIDE),
    tool: z.string().min(1),
  }),
] as const;

// ============================================================
// Git diff message schemas. Part of the inbound union, so
// dispatchMainViewInbound validates and narrows them at the
// dispatch boundary before DiffManager's typed handlers run.
// ============================================================

const RequestRecentCommitsMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS),
  notifyWhenEmpty: z.boolean().nullish(),
});

const LatexdiffMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.LATEXDIFF),
  inputFile: z.string(),
  baseFile: z.string(),
  editedFile: z.string(),
});
export type LatexdiffMessage = z.infer<typeof LatexdiffMessageSchema>;

const LatexdiffvcMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.LATEXDIFFVC),
  inputFile: z.string(),
  baseFile: z.string(),
  commitHash: z.string(),
});
export type LatexdiffvcMessage = z.infer<typeof LatexdiffvcMessageSchema>;

const latexdiffvcOperationFields = {
  inputFile: z.string(),
  baseFile: z.string(),
  commitHash: z.string(),
  clean: z.boolean().nullish(),
};

const PackLatexdiffvcMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.PACK_LATEXDIFFVC),
  ...latexdiffvcOperationFields,
});
export type PackLatexdiffvcMessage = z.infer<
  typeof PackLatexdiffvcMessageSchema
>;

const CleanLatexdiffvcMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.CLEAN_LATEXDIFFVC),
  ...latexdiffvcOperationFields,
});

export type LatexdiffvcOperationMessage =
  PackLatexdiffvcMessage | z.infer<typeof CleanLatexdiffvcMessageSchema>;

const GitDiffMessages = [
  RequestRecentCommitsMessageSchema,
  commandOnly(MAIN_VIEW_COMMANDS.REFRESH_COMMITS),
  LatexdiffMessageSchema,
  LatexdiffvcMessageSchema,
  PackLatexdiffvcMessageSchema,
  CleanLatexdiffvcMessageSchema,
] as const;

const singleOperationFields = {
  inputFile: z.string(),
  agent: z.string(),
  model: z.string(),
};

const PackSingleMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.PACK_SINGLE),
  ...singleOperationFields,
});

const CleanSingleMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.CLEAN_SINGLE),
  ...singleOperationFields,
});

const PackMultipleMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.PACK_MULTIPLE),
  ...singleOperationFields,
  inputFiles: z.array(z.string()).optional(),
});
export type PackMultipleMessage = z.infer<typeof PackMultipleMessageSchema>;

const CleanMultipleMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.CLEAN_MULTIPLE),
  ...singleOperationFields,
  inputFiles: z.array(z.string()).optional(),
});

const HousekeepingMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.CLEAN_OUTPUT),
  commandOnly(MAIN_VIEW_COMMANDS.CLEAN_BUILD),
  commandOnly(MAIN_VIEW_COMMANDS.INDENT_TEX),
  PackSingleMessageSchema,
  CleanSingleMessageSchema,
  PackMultipleMessageSchema,
  CleanMultipleMessageSchema,
] as const;

const NavigationMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.SHOW_AGENT_HISTORY),
] as const;

// Onboarding funnel (PRD: agent-native onboarding). Common commands stay
// shared where possible; ChatGPT sign-in and State 1 setup actions need
// explicit messages because they update the funnel after host-side effects.
const OnboardingMessages = [
  commandOnly(MAIN_VIEW_COMMANDS.ONBOARDING_SIGN_IN_CHATGPT),
  commandOnly(MAIN_VIEW_COMMANDS.ONBOARDING_RUN_SETUP),
  commandOnly(MAIN_VIEW_COMMANDS.ONBOARDING_OPEN_GETTING_STARTED),
  commandOnly(MAIN_VIEW_COMMANDS.ONBOARDING_SKIP),
  commandOnly(MAIN_VIEW_COMMANDS.ONBOARDING_SKIP_SETUP),
] as const;

export const MainViewInboundMessageSchema = z.discriminatedUnion('command', [
  ...CommonMessages,
  ...SettingsMessages,
  ...ExecutionMessages,
  ...FileSelectionMessages,
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
  ...OnboardingMessages,
]);

export type MainViewInboundMessage = z.infer<
  typeof MainViewInboundMessageSchema
>;

export type MainViewInboundHandlerRegistry =
  HandlerRegistry<MainViewInboundMessage>;

export const dispatchMainViewInbound = createDispatcher(
  MainViewInboundMessageSchema,
);
