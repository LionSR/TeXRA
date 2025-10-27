// Local imports - webview
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';

// Basic file types
export const FILE_TYPES = [
  'input',
  'reference',
  'auxiliary',
  'media',
  'output',
];

// Single file element IDs
export const INPUT_FILE = 'inputFile';
export const REFERENCE_FILE = 'referenceFile';
export const AUXILIARY_FILE = 'auxiliaryFile';
export const MEDIA_FILE = 'mediaFile';
export const EDITED_FILE = 'editedFile';
export const BASE_FILE = 'baseFile';

export const SINGLE_FILE_ELEMENTS = [
  INPUT_FILE,
  REFERENCE_FILE,
  AUXILIARY_FILE,
  MEDIA_FILE,
  EDITED_FILE,
  BASE_FILE,
];

// Multiple file selection element IDs (derived from FILE_TYPES)
export const MULTIPLE_SELECTIONS = FILE_TYPES.map((type) => `${type}Files`);

// Auto extract checkboxes
export const CHECK_BOXES_AUTO_EXTRACT = [
  'autoExtractFigure',
  'autoExtractTikzFigure',
  'autoCompileInputPdf',
];

// Tool configuration checkboxes
export const CHECK_BOXES_TOOL_USE = ['attachTeXCount', 'attachDiagnostics'];
export const TOOL_CONFIG_VALUES = {
  ATTACH_TEX_COUNT: 'attachTeXCount',
  ATTACH_DIAGNOSTICS: 'attachDiagnostics',
};

// All checkboxes (combined)
export const CHECK_BOXES = [
  ...CHECK_BOXES_AUTO_EXTRACT,
  ...CHECK_BOXES_TOOL_USE,
];

// Form elements with values to save
export const VALUE_ELEMENTS = [
  // parameters
  'sessionType',
  'workflowAgent',
  'toolUseAgent',
  'model',
  // files (single)
  ...SINGLE_FILE_ELEMENTS,
  // instruction
  'instruction',
  // git
  'commit',
];

// All elements that need to be saved
export const ELEMENTS_TO_SAVE = [...VALUE_ELEMENTS, ...CHECK_BOXES];

// Named element IDs used throughout the UI
export const ELEMENT_IDS = {
  PACK_BUTTON: 'packButton',
  CLEAN_BUTTON: 'cleanButton',
  MAGIC_POLISH_BUTTON: 'magicPolishButton',
  ERASE_INSTRUCTION_BUTTON: 'eraseInstructionButton',
  RECORD_INSTRUCTION_BUTTON: 'recordInstructionButton',
  EXECUTE_BUTTON: 'executeButton',
  MERGE_BUTTON: 'mergeButton',
  COMPARE_BUTTON: 'compareButton',
  ACCEPT_BUTTON: 'acceptButton',
  LATEXDIFF_BUTTON: 'latexdiffButton',
  LATEXDIFF_VC_BUTTON: 'latexdiffvcButton',
  PACK_LATEXDIFF_VC_BUTTON: 'packLatexdiffvcButton',
  CLEAN_LATEXDIFF_VC_BUTTON: 'cleanLatexdiffvcButton',
  AGENT_SETTINGS_BUTTON: 'agentSettingsButton',
  MODEL_SETTINGS_BUTTON: 'modelSettingsButton',
  TOGGLE_AUTO_EXTRACT: 'toggleAutoExtract',
  AUTO_EXTRACT_OPTIONS: 'autoExtractOptions',
  TOGGLE_TOOL_CONFIG: 'toggleToolConfig',
  TOOL_CONFIG_OPTIONS: 'toolConfigOptions',
  TOGGLE_LATEXDIFFS: 'toggleLatexdiffs',
  LATEXDIFFS_CONTENT: 'latexdiffsContent',
  COMMIT_SELECT: 'commit',
  OUTPUT_FILES: 'outputFiles',
  OUTPUT_FILES_CONTAINER: 'outputFilesContainer',
  TOGGLE_OUTPUT_FILES: 'toggleOutputFiles',
  INSTRUCTION: 'instruction',
  API_KEY_BANNER: 'apiKeyBanner',
  API_KEY_BANNER_BUTTON: 'apiKeyBannerButton',
  API_KEY_GUIDE_BUTTON: 'apiKeyGuideButton',
  AGENT_CONFIG_BANNER: 'agentConfigBanner',
  AGENT_CONFIG_EDIT_BUTTON: 'agentConfigEditButton',
  AGENT_CONFIG_DIR_BUTTON: 'agentConfigDirButton',
  AGENT_CONFIG_DOC_BUTTON: 'agentConfigDocButton',
  DEPENDENCY_BANNER: 'dependencyBanner',
  DEPENDENCY_RECHECK_BUTTON: 'dependencyRecheckButton',
  DEPENDENCY_DISMISS_BUTTON: 'dependencyDismissButton',
  SESSION_TYPE_TOGGLE: 'sessionTypeToggle',
  WORKFLOW_AGENT_SELECT: 'workflowAgent',
  TOOL_USE_AGENT_SELECT: 'toolUseAgent',
};

export const SESSION_TYPES = {
  WORKFLOW: 'workflow',
  TOOL_USE: 'toolUse',
};

export const SESSION_TYPE_INPUT = 'sessionType';

export const AGENT_SELECT_IDS = {
  [SESSION_TYPES.WORKFLOW]: 'workflowAgent',
  [SESSION_TYPES.TOOL_USE]: 'toolUseAgent',
};

export const AGENT_SELECT_LIST = Object.values(AGENT_SELECT_IDS);

/**
 * Normalizes a session type value to ensure it's a valid SESSION_TYPE.
 * @param {string} sessionType - The session type to normalize
 * @returns {string} Either SESSION_TYPES.TOOL_USE or SESSION_TYPES.WORKFLOW
 */
export function normalizeSessionType(sessionType) {
  return sessionType === SESSION_TYPES.TOOL_USE
    ? SESSION_TYPES.TOOL_USE
    : SESSION_TYPES.WORKFLOW;
}
