/**
 * MainView state types, defaults, and constants.
 *
 * Centralizes state management concerns for MainApp.
 * Uses Zod-derived types from shared schemas for type safety.
 */

import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';
import {
  MainViewPersistedStateSchema,
  type MainViewPersistedState,
  type FileSelectConfig,
  type CheckboxValues,
  type SingleFiles,
  type FileOptions,
  type MultiFiles,
  type MultiFilesVisible,
} from '@shared/schemas';

import {
  SESSION_TYPES,
  type SessionType,
  type MultipleDocumentFileType,
} from './constants';

// =========================================================================
// Default State
// =========================================================================

/** Default persisted state values */
export const DEFAULT_STATE: MainViewPersistedState =
  MainViewPersistedStateSchema.parse({});

/** Default single files state (typed) */
export const DEFAULT_SINGLE_FILES: SingleFiles = {
  inputFile: DEFAULT_STATE.inputFile,
  referenceFile: DEFAULT_STATE.referenceFile,
  auxiliaryFile: DEFAULT_STATE.auxiliaryFile,
  mediaFile: DEFAULT_STATE.mediaFile,
  baseFile: DEFAULT_STATE.baseFile,
  editedFile: DEFAULT_STATE.editedFile,
};

/** Default file options (typed, empty arrays) */
export const DEFAULT_FILE_OPTIONS: FileOptions = {
  inputFile: [],
  referenceFile: [],
  auxiliaryFile: [],
  mediaFile: [],
  editedFile: [],
  baseFile: [],
  commit: [],
};

/** Default multi-files state (typed) */
export const DEFAULT_MULTI_FILES: MultiFiles = {
  inputFiles: [],
  referenceFiles: [],
  auxiliaryFiles: [],
  mediaFiles: [],
  outputFiles: [],
};

/** Default multi-files visibility state (typed) */
export const DEFAULT_MULTI_FILES_VISIBLE: MultiFilesVisible = {
  inputFiles: false,
  referenceFiles: false,
  auxiliaryFiles: false,
  mediaFiles: false,
  outputFiles: false,
};

/** Default checkbox values (typed) */
export const DEFAULT_CHECKBOX_VALUES: CheckboxValues = {
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
export const FILE_UPDATE_COMMANDS: Record<MultipleDocumentFileType, string> = {
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
  media: MAIN_VIEW_COMMANDS.REQUEST_MEDIA_FILE,
};

/** Maps file types to their selected commands */
export const FILE_SELECTED_COMMANDS: Record<string, string> = {
  input: MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED,
  reference: MAIN_VIEW_COMMANDS.REFERENCE_FILE_SELECTED,
  media: MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED,
};

// =========================================================================
// Command-to-Key Mappings (compile-time verifiable)
// =========================================================================

/** Maps SET_*_FILE commands to their single file keys */
export const SINGLE_FILE_COMMAND_TO_KEY: Record<string, keyof SingleFiles> = {
  [MAIN_VIEW_COMMANDS.SET_INPUT_FILE]: 'inputFile',
  [MAIN_VIEW_COMMANDS.SET_REFERENCE_FILE]: 'referenceFile',
  [MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILE]: 'auxiliaryFile',
  [MAIN_VIEW_COMMANDS.SET_MEDIA_FILE]: 'mediaFile',
  [MAIN_VIEW_COMMANDS.SET_EDITED_FILE]: 'editedFile',
};

/** Maps *_FILE_SELECTED commands to their single file keys */
export const FILE_SELECTED_COMMAND_TO_KEY: Record<string, keyof SingleFiles> = {
  [MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED]: 'inputFile',
  [MAIN_VIEW_COMMANDS.REFERENCE_FILE_SELECTED]: 'referenceFile',
  [MAIN_VIEW_COMMANDS.AUXILIARY_FILE_SELECTED]: 'auxiliaryFile',
  [MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED]: 'mediaFile',
  [MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED]: 'editedFile',
};

/** Maps SET_*_FILES commands to their multi-file keys */
export const MULTI_FILE_COMMAND_TO_KEY: Record<string, keyof MultiFiles> = {
  [MAIN_VIEW_COMMANDS.SET_INPUT_FILES]: 'inputFiles',
  [MAIN_VIEW_COMMANDS.SET_REFERENCE_FILES]: 'referenceFiles',
  [MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILES]: 'auxiliaryFiles',
  [MAIN_VIEW_COMMANDS.SET_MEDIA_FILES]: 'mediaFiles',
  [MAIN_VIEW_COMMANDS.SET_OUTPUT_FILES]: 'outputFiles',
};

// =========================================================================
// Placeholder Configuration
// =========================================================================

/** Placeholder rotation interval in milliseconds */
export const PLACEHOLDER_ROTATION_MS = 12000;

/** Onboarding placeholder texts by session type (+ orchestrator override) */
export const ONBOARDING_PLACEHOLDERS = {
  workflow: [
    'Correct LaTeX errors, tighten language, and keep math notation intact.',
    'Convert this section into Beamer slides with bullet points.',
    'Derive the gradient of the loss function step by step.',
  ],
  toolUse: [
    'Find missing citations, then suggest BibTeX entries.',
    'Scan for TODOs and draft fixes with file paths.',
    'Run LaTeX checks and report compilation warnings.',
  ],
  orchestrator: [
    'Use polish on the intro, then have review audit the math.',
    'Run correct across the paper, then have review check every derivation.',
    'Leave blank — the orchestrator will plan the pipeline for you.',
    'Ask the orchestrator which agent to use for your literature review.',
    'Ask which agent should tighten the conclusion — the orchestrator picks and dispatches.',
    'Ask the orchestrator which agent should work on the methodology section.',
  ],
} satisfies Record<SessionType | 'orchestrator', string[]>;

/** Static configuration for each file selector type */
export const FILE_SELECT_CONFIGS: ReadonlyArray<FileSelectConfig> = [
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
    description: 'Read and edited by the agent',
    toolConfig: 'tool',
    focusInstruction: {
      key: 'inputFileSelect',
      text: 'Choose the main LaTeX file to process. Use the Current button to pick the active editor.',
    },
  },
  {
    type: 'reference',
    label: 'Context',
    icon: 'book',
    refreshTitle: 'Refresh context files',
    currentTitle: 'Set current file as context',
    emptyTitle: 'Clear context file',
    toggleTitle: 'Show or hide additional context files',
    addOpenedLabel: 'Add opened files as context',
    emptyListLabel: 'Clear all context files',
    selectListLabel: 'Add context files',
    tooltip:
      "Read-only context the agent sees but won't modify — bibliographies (.bib/.bbl), reference papers, style/macro files (.sty/.cls), or any document the output should match",
    description: 'Read-only context — not modified',
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
    description: 'Images and figures the agent can view',
    toolConfig: 'autoExtract',
  },
];
