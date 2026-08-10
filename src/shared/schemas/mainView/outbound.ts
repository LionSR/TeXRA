/**
 * MainView outbound message schemas (backend -> frontend): SET_*, file
 * selection responses, banners, and the dispatcher they compose into.
 */
import { z } from 'zod';

import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import {
  createDispatcher,
  type HandlerRegistry,
} from '@shared/utils/dispatcher';

import {
  CurrentFileTypeSchema,
  ExtendedDocumentFileTypeSchema,
} from '../fileTypes';
import { commandOnly, withFilesArray } from '../messageFactories';
import { OnboardingFunnelStateSchema } from '../onboarding';
import { AgentCategory } from '../agent';
import {
  AgentOptionDataSchema,
  ModelOptionDataSchema,
  TeamOptionDataSchema,
  WorkspaceRootOptionDataSchema,
} from './state';

const FileListSchema = z.array(z.string());

const SetModelOptionsMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS),
  optionsDataByCategory: z.object({
    [AgentCategory.Workflow]: z.array(ModelOptionDataSchema),
    [AgentCategory.ToolUse]: z.array(ModelOptionDataSchema),
  }),
});

const SetAgentOptionsMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS),
  optionsData: z
    .object({
      workflow: z.array(AgentOptionDataSchema).optional(),
      toolUse: z.array(AgentOptionDataSchema).optional(),
    })
    .optional(),
  selectedToolUseAgent: z.string().optional(),
});

const SetTeamOptionsMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_TEAM_OPTIONS),
  optionsData: z.array(TeamOptionDataSchema).prefault([]),
});

const SetWorkspaceRootsMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_WORKSPACE_ROOTS),
  optionsData: z.array(WorkspaceRootOptionDataSchema).prefault([]),
});

const SetBaseFileMessageSchema = withFilesArray(
  MAIN_VIEW_COMMANDS.SET_BASE_FILE,
).extend({
  preserveBaseFile: z.boolean().nullish(),
});

const EditedFileSelectedMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED),
  filePath: z.string(),
});

const AddMediaFileMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.ADD_MEDIA_FILE),
  file: z.string(),
});

const SetRecentCommitsMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS),
  commits: FileListSchema,
  isGitRepo: z.boolean().nullish(),
});

const SetCurrentFileMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_CURRENT_FILE),
  filePath: z.string(),
  fileType: CurrentFileTypeSchema,
});

const SetSelectedCommitMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_SELECTED_COMMIT),
  commitHash: z.string(),
  commitLabel: z.string().nullish(),
});

const SetOpenedFilesMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_OPENED_FILES),
  files: FileListSchema,
  fileType: ExtendedDocumentFileTypeSchema,
  shouldFilter: z.boolean().nullish(),
});

const InstructionTextPolishedMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISHED),
  text: z.string(),
});

const InstructionTextPolishErrorMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISH_ERROR),
  error: z.string().nullish(),
});

const InstructionTextTranscribedMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_TRANSCRIBED),
  text: z.string().nullish(),
});

const ShowApiKeyBannerMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER),
  provider: z.string().nullish(),
  requiresKey: z.boolean().nullish(),
});

const ShowAgentConfigBannerMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER),
  agentName: z.string().nullish(),
  customDirSet: z.boolean().nullish(),
});

const ShowDependencyBannerMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER),
  missingTools: z.array(z.string()).nullish(),
});

const SetSelectedAgentMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT),
  agentId: z.string().nullish(),
  sessionType: z.string().nullish(),
});

/** Host → webview push of the derived onboarding-funnel state. */
const SetOnboardingFunnelMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_ONBOARDING_FUNNEL),
  state: OnboardingFunnelStateSchema,
});

export const MainViewMessageSchema = z.discriminatedUnion('command', [
  SetModelOptionsMessageSchema,
  SetAgentOptionsMessageSchema,
  SetTeamOptionsMessageSchema,
  SetWorkspaceRootsMessageSchema,
  withFilesArray(MAIN_VIEW_COMMANDS.SET_EDITED_FILE),
  SetBaseFileMessageSchema,
  EditedFileSelectedMessageSchema,
  withFilesArray(MAIN_VIEW_COMMANDS.SET_INPUT_FILES),
  withFilesArray(MAIN_VIEW_COMMANDS.SET_CONTEXT_FILES),
  withFilesArray(MAIN_VIEW_COMMANDS.SET_MEDIA_FILES),
  withFilesArray(MAIN_VIEW_COMMANDS.SET_OUTPUT_FILES),
  AddMediaFileMessageSchema,
  SetRecentCommitsMessageSchema,
  SetCurrentFileMessageSchema,
  SetSelectedCommitMessageSchema,
  SetOpenedFilesMessageSchema,
  InstructionTextPolishedMessageSchema,
  InstructionTextPolishErrorMessageSchema,
  InstructionTextTranscribedMessageSchema,
  commandOnly(MAIN_VIEW_COMMANDS.RECORDING_STARTED),
  commandOnly(MAIN_VIEW_COMMANDS.RECORDING_STOPPED),
  commandOnly(MAIN_VIEW_COMMANDS.RECORDING_ERROR),
  ShowApiKeyBannerMessageSchema,
  commandOnly(MAIN_VIEW_COMMANDS.HIDE_API_KEY_BANNER),
  ShowAgentConfigBannerMessageSchema,
  commandOnly(MAIN_VIEW_COMMANDS.HIDE_AGENT_CONFIG_BANNER),
  ShowDependencyBannerMessageSchema,
  commandOnly(MAIN_VIEW_COMMANDS.HIDE_DEPENDENCY_BANNER),
  commandOnly(MAIN_VIEW_COMMANDS.SHOW_GETTING_STARTED_BANNER),
  commandOnly(MAIN_VIEW_COMMANDS.HIDE_GETTING_STARTED_BANNER),
  commandOnly(MAIN_VIEW_COMMANDS.SHOW_ORCHESTRATOR_BANNER),
  commandOnly(MAIN_VIEW_COMMANDS.HIDE_ORCHESTRATOR_BANNER),
  commandOnly(MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER),
  commandOnly(MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER),
  SetSelectedAgentMessageSchema,
  SetOnboardingFunnelMessageSchema,
]);

export type MainViewMessage = z.infer<typeof MainViewMessageSchema>;

/** Handler registry for messages the webview receives (extension → webview). */
export type MainViewHandlerRegistry = HandlerRegistry<MainViewMessage>;

/** Dispatcher for messages the webview receives (extension → webview). */
export const dispatchMainView = createDispatcher(MainViewMessageSchema);
