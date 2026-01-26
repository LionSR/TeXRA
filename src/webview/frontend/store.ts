/**
 * MainView state types, defaults, and constants.
 *
 * Centralizes state management concerns for MainApp.
 */

import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';
import { SESSION_TYPES, type SessionType, type MultipleFileType, type FileType } from './constants';

// =========================================================================
// State Types
// =========================================================================

/** Persisted state for MainView across sessions */
export interface MainViewPersistedState extends Record<string, unknown> {
  sessionType: SessionType;
  workflowAgent: string;
  toolUseAgent: string;
  model: string;
  commit: string;
  instruction: string;
  inputFile: string;
  referenceFile: string;
  auxiliaryFile: string;
  mediaFile: string;
  editedFile: string;
  baseFile: string;
  inputFiles: string[];
  referenceFiles: string[];
  auxiliaryFiles: string[];
  mediaFiles: string[];
  outputFiles: string[];
  inputFilesVisible: boolean;
  referenceFilesVisible: boolean;
  auxiliaryFilesVisible: boolean;
  mediaFilesVisible: boolean;
  outputFilesVisible: boolean;
  outputFilesActive: boolean;
  latexdiffsVisible: boolean;
  autoExtractFigure: boolean;
  autoExtractTikzFigure: boolean;
  autoCompileInputPdf: boolean;
  attachTeXCount: boolean;
  attachDiagnostics: boolean;
  agent: string;
  isToolUseAgent: boolean;
  openedFiles?: string[];
}

/** Banner display state */
export interface BannerState {
  visible: boolean;
  provider?: string;
  requiresKey?: boolean;
  agentName?: string;
  customDirSet?: boolean;
  missingTools?: string[];
}

/** Single file selections state */
export interface SingleFilesState {
  inputFile: string;
  referenceFile: string;
  auxiliaryFile: string;
  mediaFile: string;
  baseFile: string;
  editedFile: string;
}

/** Checkbox configuration values */
export interface CheckboxValuesState {
  autoExtractFigure: boolean;
  autoExtractTikzFigure: boolean;
  autoCompileInputPdf: boolean;
  attachTeXCount: boolean;
  attachDiagnostics: boolean;
}

// =========================================================================
// Default State
// =========================================================================

/** Default persisted state values */
export const DEFAULT_STATE: MainViewPersistedState = {
  sessionType: SESSION_TYPES.TOOL_USE,
  workflowAgent: 'correct',
  toolUseAgent: 'chat',
  model: 'gemini3p',
  commit: 'HEAD',
  instruction: '',
  inputFile: '',
  referenceFile: '',
  auxiliaryFile: '',
  mediaFile: '',
  editedFile: '',
  baseFile: '',
  inputFiles: [],
  referenceFiles: [],
  auxiliaryFiles: [],
  mediaFiles: [],
  outputFiles: [],
  inputFilesVisible: false,
  referenceFilesVisible: false,
  auxiliaryFilesVisible: false,
  mediaFilesVisible: false,
  outputFilesVisible: false,
  outputFilesActive: false,
  latexdiffsVisible: false,
  autoExtractFigure: false,
  autoExtractTikzFigure: false,
  autoCompileInputPdf: false,
  attachTeXCount: false,
  attachDiagnostics: false,
  agent: '',
  isToolUseAgent: true,
};

/** Default single files state */
export const DEFAULT_SINGLE_FILES: SingleFilesState = {
  inputFile: DEFAULT_STATE.inputFile,
  referenceFile: DEFAULT_STATE.referenceFile,
  auxiliaryFile: DEFAULT_STATE.auxiliaryFile,
  mediaFile: DEFAULT_STATE.mediaFile,
  baseFile: DEFAULT_STATE.baseFile,
  editedFile: DEFAULT_STATE.editedFile,
};

/** Default file options (empty arrays) */
export const DEFAULT_FILE_OPTIONS: Record<string, string[]> = {
  inputFile: [],
  referenceFile: [],
  auxiliaryFile: [],
  mediaFile: [],
  editedFile: [],
  baseFile: [],
};

/** Default multi-files state */
export const DEFAULT_MULTI_FILES: Record<string, string[]> = {
  inputFiles: [],
  referenceFiles: [],
  auxiliaryFiles: [],
  mediaFiles: [],
  outputFiles: [],
};

/** Default multi-files visibility state */
export const DEFAULT_MULTI_FILES_VISIBLE: Record<string, boolean> = {
  inputFiles: false,
  referenceFiles: false,
  auxiliaryFiles: false,
  mediaFiles: false,
  outputFiles: false,
};

/** Default checkbox values */
export const DEFAULT_CHECKBOX_VALUES: CheckboxValuesState = {
  autoExtractFigure: DEFAULT_STATE.autoExtractFigure,
  autoExtractTikzFigure: DEFAULT_STATE.autoExtractTikzFigure,
  autoCompileInputPdf: DEFAULT_STATE.autoCompileInputPdf,
  attachTeXCount: DEFAULT_STATE.attachTeXCount,
  attachDiagnostics: DEFAULT_STATE.attachDiagnostics,
};

// =========================================================================
// Command Mappings
// =========================================================================

/** Maps file types to their update commands */
export const FILE_UPDATE_COMMANDS: Record<MultipleFileType, string> = {
  input: MAIN_VIEW_COMMANDS.UPDATE_INPUT_FILES,
  reference: MAIN_VIEW_COMMANDS.UPDATE_REFERENCE_FILES,
  auxiliary: MAIN_VIEW_COMMANDS.UPDATE_AUXILIARY_FILES,
  media: MAIN_VIEW_COMMANDS.UPDATE_MEDIA_FILES,
  output: MAIN_VIEW_COMMANDS.UPDATE_OUTPUT_FILES,
};

/** Maps file types to their refresh commands */
export const FILE_REFRESH_COMMANDS: Record<string, string> = {
  input: MAIN_VIEW_COMMANDS.REQUEST_INPUT_FILE,
  reference: MAIN_VIEW_COMMANDS.REQUEST_REFERENCE_FILE,
  auxiliary: MAIN_VIEW_COMMANDS.REQUEST_AUXILIARY_FILE,
  media: MAIN_VIEW_COMMANDS.REQUEST_MEDIA_FILE,
};

/** Maps file types to their selected commands */
export const FILE_SELECTED_COMMANDS: Record<string, string> = {
  input: MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED,
  reference: MAIN_VIEW_COMMANDS.REFERENCE_FILE_SELECTED,
  auxiliary: MAIN_VIEW_COMMANDS.AUXILIARY_FILE_SELECTED,
  media: MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED,
};

// =========================================================================
// Placeholder Configuration
// =========================================================================

/** Placeholder rotation interval in milliseconds */
export const PLACEHOLDER_ROTATION_MS = 12000;

/** Onboarding placeholder texts by session type */
export const ONBOARDING_PLACEHOLDERS: Record<SessionType, string[]> = {
  [SESSION_TYPES.WORKFLOW]: [
    'Correct LaTeX errors, tighten language, and keep math notation intact.',
    'Convert this section into Beamer slides with bullet points.',
    'Derive the gradient of the loss function step by step.',
  ],
  [SESSION_TYPES.TOOL_USE]: [
    'Find missing citations, then suggest BibTeX entries.',
    'Scan for TODOs and draft fixes with file paths.',
    'Run LaTeX checks and report compilation warnings.',
  ],
};

// =========================================================================
// File Selector Configuration
// =========================================================================

/** File selector config type (matches FileSelectGroup.ts) */
export interface FileSelectConfigData {
  type: FileType;
  label: string;
  icon: string;
  refreshTitle: string;
  currentTitle: string;
  emptyTitle: string;
  toggleTitle: string;
  addOpenedLabel: string;
  emptyListLabel: string;
  selectListLabel: string;
  tooltip: string;
  toolConfig?: 'tool' | 'autoExtract';
  focusInstruction?: {
    key: string;
    text: string;
  };
}

/** Static configuration for each file selector type */
export const FILE_SELECT_CONFIGS: ReadonlyArray<FileSelectConfigData> = [
  {
    type: 'input',
    label: 'Input',
    icon: 'file-code',
    refreshTitle: 'Refresh input files',
    currentTitle: 'Set current file as input',
    emptyTitle: 'Clear input file',
    toggleTitle: 'Show or hide additional input files',
    addOpenedLabel: 'Add opened files as input',
    emptyListLabel: 'Clear all input files',
    selectListLabel: 'Add input files',
    tooltip: 'Primary files the agent processes, such as .tex, .txt, or .md',
    toolConfig: 'tool',
    focusInstruction: {
      key: 'inputFileSelect',
      text: 'Choose the main LaTeX file to process. Use the Current button to pick the active editor.',
    },
  },
  {
    type: 'reference',
    label: 'Reference',
    icon: 'book',
    refreshTitle: 'Refresh reference files',
    currentTitle: 'Set current file as reference',
    emptyTitle: 'Clear reference file',
    toggleTitle: 'Show or hide additional reference files',
    addOpenedLabel: 'Add opened files as reference',
    emptyListLabel: 'Clear all reference files',
    selectListLabel: 'Add reference files',
    tooltip:
      "Context files such as .bib/.bbl or other papers that guide output but won't be modified",
  },
  {
    type: 'auxiliary',
    label: 'Auxiliary',
    icon: 'archive',
    refreshTitle: 'Refresh auxiliary files',
    currentTitle: 'Set current file as auxiliary',
    emptyTitle: 'Clear auxiliary file',
    toggleTitle: 'Show or hide additional auxiliary files',
    addOpenedLabel: 'Add opened files as auxiliary',
    emptyListLabel: 'Clear all auxiliary files',
    selectListLabel: 'Add auxiliary files',
    tooltip: 'Files such as .cls/.sty that define document structure and styles',
  },
  {
    type: 'media',
    label: 'Media',
    icon: 'device-camera-video',
    refreshTitle: 'Refresh media files',
    currentTitle: 'Set current file as media',
    emptyTitle: 'Clear media file',
    toggleTitle: 'Show or hide additional media files',
    addOpenedLabel: 'Add opened files as media',
    emptyListLabel: 'Clear all media files',
    selectListLabel: 'Add media files',
    tooltip: 'Images, figures, and media assets used by the document',
    toolConfig: 'autoExtract',
  },
];
