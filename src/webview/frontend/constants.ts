// Local imports - shared schemas
import type {
  FileType as SharedFileType,
  MultipleFileType as SharedMultipleFileType,
  SessionType as SharedSessionType,
} from '@shared/schemas';

// Local constants - session types
export const SESSION_TYPES = {
  TOOL_USE: 'toolUse',
  WORKFLOW: 'workflow',
} as const;

export type SessionType = SharedSessionType;

export const FILE_TYPES = ['input', 'reference', 'auxiliary', 'media'] as const;
export type FileType = SharedFileType;

export const MULTIPLE_FILE_TYPES = [...FILE_TYPES, 'output'] as const;
export type MultipleFileType = SharedMultipleFileType;

export const CHECK_BOXES_AUTO_EXTRACT = [
  'autoExtractFigure',
  'autoExtractTikzFigure',
  'autoCompileInputPdf',
] as const;

export const CHECK_BOXES_TOOL_USE = [
  'attachTeXCount',
  'attachDiagnostics',
] as const;

export const ELEMENT_IDS = {
  INSTRUCTION: 'instruction',
  SESSION_TYPE_TOGGLE: 'sessionTypeToggle',
  WORKFLOW_AGENT_SELECT: 'workflowAgent',
  TOOL_USE_AGENT_SELECT: 'toolUseAgent',
  MODEL_SELECT: 'model',
  COMMIT_SELECT: 'commit',
  OUTPUT_FILES: 'outputFiles',
  OUTPUT_FILES_CONTAINER: 'outputFilesContainer',
  TOGGLE_OUTPUT_FILES: 'toggleOutputFiles',
  TOGGLE_AUTO_EXTRACT: 'toggleAutoExtract',
  AUTO_EXTRACT_OPTIONS: 'autoExtractOptions',
  TOGGLE_TOOL_CONFIG: 'toggleToolConfig',
  TOOL_CONFIG_OPTIONS: 'toolConfigOptions',
  BASE_FILE: 'baseFile',
  EDITED_FILE: 'editedFile',
  LATEXDIFFS_CONTENT: 'latexdiffsContent',
  TOGGLE_LATEXDIFFS: 'toggleLatexdiffs',
  API_KEY_BANNER: 'apiKeyBanner',
  AGENT_CONFIG_BANNER: 'agentConfigBanner',
  DEPENDENCY_BANNER: 'dependencyBanner',
  GETTING_STARTED_BANNER: 'gettingStartedBanner',
  LOGIN_BANNER: 'loginBanner',
} as const;

export const AGENT_SELECT_IDS = {
  [SESSION_TYPES.WORKFLOW]: ELEMENT_IDS.WORKFLOW_AGENT_SELECT,
  [SESSION_TYPES.TOOL_USE]: ELEMENT_IDS.TOOL_USE_AGENT_SELECT,
} as const;

export const AGENT_SELECT_LIST = Object.values(AGENT_SELECT_IDS);

export const SESSION_TYPE_VALUES = new Set(Object.values(SESSION_TYPES));

export function parseSessionType(
  sessionType: string | null | undefined,
): SessionType | undefined {
  return SESSION_TYPE_VALUES.has(sessionType as SessionType)
    ? (sessionType as SessionType)
    : undefined;
}
