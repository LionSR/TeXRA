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

export const DEFAULT_SINGLE_FILES: SingleFiles = {
  baseFile: DEFAULT_STATE.baseFile,
  editedFile: DEFAULT_STATE.editedFile,
};

/** Default file options (typed, empty arrays) */
export const DEFAULT_FILE_OPTIONS: FileOptions = {
  editedFile: [],
  baseFile: [],
  commit: [],
};

/** Default multi-files state (typed) */
export const DEFAULT_MULTI_FILES: MultiFiles = {
  inputFiles: [],
  contextFiles: [],
  mediaFiles: [],
  outputFiles: [],
};

/** Default multi-files visibility state (typed) */
export const DEFAULT_MULTI_FILES_VISIBLE: MultiFilesVisible = {
  inputFiles: false,
  contextFiles: false,
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
  context: MAIN_VIEW_COMMANDS.UPDATE_CONTEXT_FILES,
  media: MAIN_VIEW_COMMANDS.UPDATE_MEDIA_FILES,
  output: MAIN_VIEW_COMMANDS.UPDATE_OUTPUT_FILES,
};

// =========================================================================
// Command-to-Key Mappings (compile-time verifiable)
// =========================================================================

/** Maps SET_*_FILES commands to their multi-file keys */
export const MULTI_FILE_COMMAND_TO_KEY: Record<string, keyof MultiFiles> = {
  [MAIN_VIEW_COMMANDS.SET_INPUT_FILES]: 'inputFiles',
  [MAIN_VIEW_COMMANDS.SET_CONTEXT_FILES]: 'contextFiles',
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

export const FILE_SELECT_CONFIGS: ReadonlyArray<FileSelectConfig> = [
  {
    type: 'input',
    label: 'Input',
    icon: 'file-code',
    toggleTitle: 'Show or hide additional input files',
    addOpenedLabel: 'Add opened files as input',
    emptyListLabel: 'Clear all input files',
    selectListLabel: 'Add input files',
    tooltip: 'Primary files the agent processes, such as .tex, .txt, or .md',
    description: 'Read and edited by the agent',
    toolConfig: 'tool',
  },
  {
    type: 'context',
    label: 'Context',
    icon: 'book',
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
    toggleTitle: 'Show or hide additional media files',
    addOpenedLabel: 'Add opened files as media',
    emptyListLabel: 'Clear all media files',
    selectListLabel: 'Add media files',
    tooltip: 'Images, figures, and media assets used by the document',
    description: 'Images and figures the agent can view',
    toolConfig: 'autoExtract',
  },
];
