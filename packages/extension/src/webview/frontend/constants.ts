// Local imports - shared schemas
import {
  DocumentFileTypeSchema,
  MULTIPLE_DOCUMENT_FILE_TYPES,
  SessionTypeSchema,
  type DocumentFileType,
  type MultipleDocumentFileType,
  type SessionType,
} from '@shared/schemas';

const [toolUseSessionType, workflowSessionType] = SessionTypeSchema.options;

// Local constants - session types
export const SESSION_TYPES = {
  TOOL_USE: toolUseSessionType,
  WORKFLOW: workflowSessionType,
} as const;

export type { SessionType, DocumentFileType, MultipleDocumentFileType };

export const DOCUMENT_FILE_TYPES = DocumentFileTypeSchema.options;
export { MULTIPLE_DOCUMENT_FILE_TYPES };

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

export function parseSessionType(
  sessionType: string | null | undefined,
): SessionType | undefined {
  const result = SessionTypeSchema.safeParse(sessionType);
  return result.success ? result.data : undefined;
}
