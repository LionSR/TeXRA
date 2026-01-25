// Third-party imports
import { z } from 'zod';

// Local imports - commands
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';

const BaseMessageSchema = z.object({
  command: z.string(),
});

const WithFilesSchema = z.object({
  files: z.array(z.string()).nullish(),
});

const WithFilePathSchema = z.object({
  filePath: z.string().nullish(),
});

const WithCommitSchema = z.object({
  commitHash: z.string().nullish(),
  commitLabel: z.string().nullish(),
});

const WithFileTypeSchema = z.object({
  fileType: z.string().nullish(),
});

const WithTextSchema = z.object({
  text: z.string().nullish(),
});

export const MainViewThemeSetMessageSchema = BaseMessageSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.THEME_SET),
  theme: z.string().nullish(),
});

export const MainViewSetModelOptionsMessageSchema = BaseMessageSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS),
  options: z.string().nullish(),
});

export const MainViewSetAgentOptionsMessageSchema = BaseMessageSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS),
  options: z
    .strictObject({
      workflow: z.string().nullish(),
      toolUse: z.string().nullish(),
    })
    .nullish(),
});

export const MainViewSetSingleFileMessageSchema = BaseMessageSchema.extend({
  command: z.enum([
    MAIN_VIEW_COMMANDS.SET_INPUT_FILE,
    MAIN_VIEW_COMMANDS.SET_REFERENCE_FILE,
    MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILE,
    MAIN_VIEW_COMMANDS.SET_MEDIA_FILE,
    MAIN_VIEW_COMMANDS.SET_EDITED_FILE,
  ]),
  files: z.array(z.string()).nullish(),
});

export const MainViewSetBaseFileMessageSchema = BaseMessageSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_BASE_FILE),
  files: z.array(z.string()).nullish(),
  preserveBaseFile: z.boolean().nullish(),
});

export const MainViewFileSelectedMessageSchema = BaseMessageSchema.extend({
  command: z.enum([
    MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED,
    MAIN_VIEW_COMMANDS.REFERENCE_FILE_SELECTED,
    MAIN_VIEW_COMMANDS.AUXILIARY_FILE_SELECTED,
    MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED,
    MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED,
  ]),
  filePath: z.string().nullish(),
});

export const MainViewSetMultipleFilesMessageSchema = BaseMessageSchema.extend({
  command: z.enum([
    MAIN_VIEW_COMMANDS.SET_INPUT_FILES,
    MAIN_VIEW_COMMANDS.SET_REFERENCE_FILES,
    MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILES,
    MAIN_VIEW_COMMANDS.SET_MEDIA_FILES,
    MAIN_VIEW_COMMANDS.SET_OUTPUT_FILES,
  ]),
  files: z.array(z.string()).nullish(),
});

export const MainViewSetDefaultOutputFilesMessageSchema =
  BaseMessageSchema.extend({
    command: z.literal(MAIN_VIEW_COMMANDS.SET_DEFAULT_OUTPUT_FILES),
    files: z.array(z.string()).nullish(),
  });

export const MainViewAddMediaFileMessageSchema = BaseMessageSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.ADD_MEDIA_FILE),
  file: z.string().nullish(),
});

export const MainViewSetRecentCommitsMessageSchema = BaseMessageSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS),
  commits: z.array(z.string()).nullish(),
  isGitRepo: z.boolean().nullish(),
});

export const MainViewSetCurrentFileMessageSchema = BaseMessageSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_CURRENT_FILE),
  ...WithFileTypeSchema.shape,
  ...WithFilePathSchema.shape,
});

export const MainViewSetSelectedCommitMessageSchema = BaseMessageSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_SELECTED_COMMIT),
  ...WithCommitSchema.shape,
});

export const MainViewSetOpenedFilesMessageSchema = BaseMessageSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_OPENED_FILES),
  ...WithFileTypeSchema.shape,
  files: z.array(z.string()).nullish(),
  shouldFilter: z.boolean().nullish(),
});

export const MainViewSetAllSingleFilesMessageSchema = BaseMessageSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_ALL_SINGLE_FILES),
  inputFiles: z.array(z.string()).nullish(),
  referenceFiles: z.array(z.string()).nullish(),
  auxiliaryFiles: z.array(z.string()).nullish(),
  mediaFiles: z.array(z.string()).nullish(),
});

export const MainViewInstructionTextPolishedMessageSchema =
  BaseMessageSchema.extend({
    command: z.literal(MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISHED),
    ...WithTextSchema.shape,
  });

export const MainViewInstructionTextPolishErrorMessageSchema =
  BaseMessageSchema.extend({
    command: z.literal(MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISH_ERROR),
    error: z.string().nullish(),
  });

export const MainViewInstructionTextTranscribedMessageSchema =
  BaseMessageSchema.extend({
    command: z.literal(MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_TRANSCRIBED),
    ...WithTextSchema.shape,
  });

export const MainViewRecordingStartedMessageSchema = BaseMessageSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.RECORDING_STARTED),
});

export const MainViewRecordingStoppedMessageSchema = BaseMessageSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.RECORDING_STOPPED),
});

export const MainViewRecordingErrorMessageSchema = BaseMessageSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.RECORDING_ERROR),
});

export const MainViewShowApiKeyBannerMessageSchema = BaseMessageSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER),
  provider: z.string().nullish(),
  requiresKey: z.boolean().nullish(),
});

export const MainViewShowAgentConfigBannerMessageSchema =
  BaseMessageSchema.extend({
    command: z.literal(MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER),
    agentName: z.string().nullish(),
    customDirSet: z.boolean().nullish(),
  });

export const MainViewShowDependencyBannerMessageSchema =
  BaseMessageSchema.extend({
    command: z.literal(MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER),
    missingTools: z.array(z.string()).nullish(),
  });

export const MainViewToggleBannerMessageSchema = BaseMessageSchema.extend({
  command: z.enum([
    MAIN_VIEW_COMMANDS.HIDE_API_KEY_BANNER,
    MAIN_VIEW_COMMANDS.HIDE_AGENT_CONFIG_BANNER,
    MAIN_VIEW_COMMANDS.HIDE_DEPENDENCY_BANNER,
    MAIN_VIEW_COMMANDS.SHOW_GETTING_STARTED_BANNER,
    MAIN_VIEW_COMMANDS.HIDE_GETTING_STARTED_BANNER,
    MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER,
    MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER,
  ]),
});

export const MainViewStateRestoreMessageSchema = BaseMessageSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.STATE_RESTORE),
  state: z.record(z.string(), z.unknown()).nullish(),
  isResetOperation: z.boolean().nullish(),
  executeImmediately: z.boolean().nullish(),
});

export const MainViewSetSelectedAgentMessageSchema = BaseMessageSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT),
  agentValue: z.string().nullish(),
  sessionType: z.enum(['toolUse', 'workflow']).nullish(),
});

export const MainViewMessageSchema = z.union([
  MainViewThemeSetMessageSchema,
  MainViewSetModelOptionsMessageSchema,
  MainViewSetAgentOptionsMessageSchema,
  MainViewSetSingleFileMessageSchema,
  MainViewSetBaseFileMessageSchema,
  MainViewFileSelectedMessageSchema,
  MainViewSetMultipleFilesMessageSchema,
  MainViewSetDefaultOutputFilesMessageSchema,
  MainViewAddMediaFileMessageSchema,
  MainViewSetRecentCommitsMessageSchema,
  MainViewSetCurrentFileMessageSchema,
  MainViewSetSelectedCommitMessageSchema,
  MainViewSetOpenedFilesMessageSchema,
  MainViewSetAllSingleFilesMessageSchema,
  MainViewInstructionTextPolishedMessageSchema,
  MainViewInstructionTextPolishErrorMessageSchema,
  MainViewInstructionTextTranscribedMessageSchema,
  MainViewRecordingStartedMessageSchema,
  MainViewRecordingStoppedMessageSchema,
  MainViewRecordingErrorMessageSchema,
  MainViewShowApiKeyBannerMessageSchema,
  MainViewShowAgentConfigBannerMessageSchema,
  MainViewShowDependencyBannerMessageSchema,
  MainViewToggleBannerMessageSchema,
  MainViewStateRestoreMessageSchema,
  MainViewSetSelectedAgentMessageSchema,
]);

export type MainViewMessage = z.infer<typeof MainViewMessageSchema>;
