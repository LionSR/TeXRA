/**
 * MainView state types, defaults, and constants.
 *
 * Centralizes state management concerns for MainApp.
 * Uses Zod-derived types from shared schemas for type safety.
 */

import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import {
  MainViewPersistedStateSchema,
  type MainViewPersistedState,
  type FileSelectConfig,
  type CheckboxValues,
  type SingleFiles,
  type FileOptions,
  type MultiFiles,
} from '@shared/schemas';

import { type SessionType, type MultipleDocumentFileType } from './constants';

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

/** Default checkbox values (typed) */
export const DEFAULT_CHECKBOX_VALUES: CheckboxValues = {
  autoExtractFigure: DEFAULT_STATE.autoExtractFigure,
  autoExtractTikzFigure: DEFAULT_STATE.autoExtractTikzFigure,
  autoCompileInputPdf: DEFAULT_STATE.autoCompileInputPdf,
  attachTeXCount: DEFAULT_STATE.attachTeXCount,
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

/** Maps a `MultipleDocumentFileType` to its `MultiFiles` key. */
export const FILE_TYPE_TO_KEY: Record<
  MultipleDocumentFileType,
  keyof MultiFiles
> = {
  input: 'inputFiles',
  context: 'contextFiles',
  media: 'mediaFiles',
  output: 'outputFiles',
};

/** Reverse of {@link FILE_TYPE_TO_KEY}: maps a `MultiFiles` key back to its file type. */
export const KEY_TO_FILE_TYPE: Record<
  keyof MultiFiles,
  MultipleDocumentFileType
> = {
  inputFiles: 'input',
  contextFiles: 'context',
  mediaFiles: 'media',
  outputFiles: 'output',
};

/** Maps a single-file selection type (`SET_CURRENT_FILE`'s base/edited slot) to its `FileOptions` key. */
export const SINGLE_FILE_TYPE_TO_KEY: Record<
  'base' | 'edited',
  keyof Pick<FileOptions, 'baseFile' | 'editedFile'>
> = {
  base: 'baseFile',
  edited: 'editedFile',
};

// =========================================================================
// Placeholder Configuration
// =========================================================================

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
    addOpenedLabel: 'Add opened files as media',
    emptyListLabel: 'Clear all media files',
    selectListLabel: 'Add media files',
    tooltip: 'Images, figures, and media assets used by the document',
    description: 'Images and figures the agent can view',
    toolConfig: 'autoExtract',
  },
];
