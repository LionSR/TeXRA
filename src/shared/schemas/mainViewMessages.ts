// Third-party imports
import { z } from 'zod';

// Local imports - shared commands
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - shared schemas
import { FileTypeSchema, SessionTypeSchema } from './mainViewState';

const FileListSchema = z.array(z.string());

const FilesPayloadSchema = z.object({
  files: FileListSchema,
});

const SingleFileSelectedSchema = z.object({
  filePath: z.string(),
});

const BaseFileOptionsSchema = z.object({
  preserveBaseFile: z.boolean().nullish(),
});

export const SetModelOptionsMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS),
  options: z.string(),
});

export const SetAgentOptionsMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS),
  options: z
    .object({
      workflow: z.string().nullish(),
      toolUse: z.string().nullish(),
    })
    .nullish(),
});

export const SetInputFileMessageSchema = FilesPayloadSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_INPUT_FILE),
});

export const SetReferenceFileMessageSchema = FilesPayloadSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_REFERENCE_FILE),
});

export const SetAuxiliaryFileMessageSchema = FilesPayloadSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILE),
});

export const SetMediaFileMessageSchema = FilesPayloadSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_MEDIA_FILE),
});

export const SetEditedFileMessageSchema = FilesPayloadSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_EDITED_FILE),
});

export const SetBaseFileMessageSchema = FilesPayloadSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_BASE_FILE),
  preserveBaseFile: BaseFileOptionsSchema.shape.preserveBaseFile,
});

export const InputFileSelectedMessageSchema = SingleFileSelectedSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED),
});

export const ReferenceFileSelectedMessageSchema =
  SingleFileSelectedSchema.extend({
    command: z.literal(MAIN_VIEW_COMMANDS.REFERENCE_FILE_SELECTED),
  });

export const AuxiliaryFileSelectedMessageSchema =
  SingleFileSelectedSchema.extend({
    command: z.literal(MAIN_VIEW_COMMANDS.AUXILIARY_FILE_SELECTED),
  });

export const MediaFileSelectedMessageSchema = SingleFileSelectedSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED),
});

export const EditedFileSelectedMessageSchema = SingleFileSelectedSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED),
});

export const SetInputFilesMessageSchema = FilesPayloadSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_INPUT_FILES),
});

export const SetReferenceFilesMessageSchema = FilesPayloadSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_REFERENCE_FILES),
});

export const SetAuxiliaryFilesMessageSchema = FilesPayloadSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILES),
});

export const SetMediaFilesMessageSchema = FilesPayloadSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_MEDIA_FILES),
});

export const SetOutputFilesMessageSchema = FilesPayloadSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_OUTPUT_FILES),
});

export const SetDefaultOutputFilesMessageSchema = FilesPayloadSchema.extend({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_DEFAULT_OUTPUT_FILES),
});

export const AddMediaFileMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.ADD_MEDIA_FILE),
  file: z.string(),
});

export const SetRecentCommitsMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS),
  commits: FileListSchema,
  isGitRepo: z.boolean().nullish(),
});

export const SetCurrentFileMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_CURRENT_FILE),
  filePath: z.string(),
  fileType: z.enum([...FileTypeSchema.options, 'base', 'edited']),
});

export const SetSelectedCommitMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_SELECTED_COMMIT),
  commitHash: z.string(),
  commitLabel: z.string().nullish(),
});

export const SetOpenedFilesMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_OPENED_FILES),
  files: FileListSchema,
  fileType: FileTypeSchema,
  shouldFilter: z.boolean().nullish(),
});

export const SetAllSingleFilesMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_ALL_SINGLE_FILES),
  inputFiles: FileListSchema.nullish(),
  referenceFiles: FileListSchema.nullish(),
  auxiliaryFiles: FileListSchema.nullish(),
  mediaFiles: FileListSchema.nullish(),
});

export const InstructionTextPolishedMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISHED),
  text: z.string(),
});

export const InstructionTextPolishErrorMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISH_ERROR),
  error: z.string().nullish(),
});

export const InstructionTextTranscribedMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_TRANSCRIBED),
  text: z.string().nullish(),
});

export const RecordingStartedMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.RECORDING_STARTED),
});

export const RecordingStoppedMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.RECORDING_STOPPED),
});

export const RecordingErrorMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.RECORDING_ERROR),
});

export const ShowApiKeyBannerMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER),
  provider: z.string().nullish(),
  requiresKey: z.boolean().nullish(),
});

export const HideApiKeyBannerMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.HIDE_API_KEY_BANNER),
});

export const ShowAgentConfigBannerMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER),
  agentName: z.string().nullish(),
  customDirSet: z.boolean().nullish(),
});

export const HideAgentConfigBannerMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.HIDE_AGENT_CONFIG_BANNER),
});

export const ShowDependencyBannerMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER),
  missingTools: z.array(z.string()).nullish(),
});

export const HideDependencyBannerMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.HIDE_DEPENDENCY_BANNER),
});

export const ShowGettingStartedBannerMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SHOW_GETTING_STARTED_BANNER),
});

export const HideGettingStartedBannerMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.HIDE_GETTING_STARTED_BANNER),
});

export const ShowLoginBannerMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER),
});

export const HideLoginBannerMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER),
});

export const SetSelectedAgentMessageSchema = z.object({
  command: z.literal(MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT),
  agentId: z.string().nullish(),
  sessionType: SessionTypeSchema.nullish(),
});

export const MainViewMessageSchema = z.discriminatedUnion('command', [
  SetModelOptionsMessageSchema,
  SetAgentOptionsMessageSchema,
  SetInputFileMessageSchema,
  SetReferenceFileMessageSchema,
  SetAuxiliaryFileMessageSchema,
  SetMediaFileMessageSchema,
  SetEditedFileMessageSchema,
  SetBaseFileMessageSchema,
  InputFileSelectedMessageSchema,
  ReferenceFileSelectedMessageSchema,
  AuxiliaryFileSelectedMessageSchema,
  MediaFileSelectedMessageSchema,
  EditedFileSelectedMessageSchema,
  SetInputFilesMessageSchema,
  SetReferenceFilesMessageSchema,
  SetAuxiliaryFilesMessageSchema,
  SetMediaFilesMessageSchema,
  SetOutputFilesMessageSchema,
  SetDefaultOutputFilesMessageSchema,
  AddMediaFileMessageSchema,
  SetRecentCommitsMessageSchema,
  SetCurrentFileMessageSchema,
  SetSelectedCommitMessageSchema,
  SetOpenedFilesMessageSchema,
  SetAllSingleFilesMessageSchema,
  InstructionTextPolishedMessageSchema,
  InstructionTextPolishErrorMessageSchema,
  InstructionTextTranscribedMessageSchema,
  RecordingStartedMessageSchema,
  RecordingStoppedMessageSchema,
  RecordingErrorMessageSchema,
  ShowApiKeyBannerMessageSchema,
  HideApiKeyBannerMessageSchema,
  ShowAgentConfigBannerMessageSchema,
  HideAgentConfigBannerMessageSchema,
  ShowDependencyBannerMessageSchema,
  HideDependencyBannerMessageSchema,
  ShowGettingStartedBannerMessageSchema,
  HideGettingStartedBannerMessageSchema,
  ShowLoginBannerMessageSchema,
  HideLoginBannerMessageSchema,
  SetSelectedAgentMessageSchema,
]);

export type MainViewMessage = z.infer<typeof MainViewMessageSchema>;
