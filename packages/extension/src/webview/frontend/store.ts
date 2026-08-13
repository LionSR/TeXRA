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

/**
 * Default file options. The commit list always carries `HEAD`: it is a valid
 * selector for any repository, so consumers read the list as-is instead of
 * synthesizing the entry at use time.
 */
export const DEFAULT_FILE_OPTIONS: FileOptions = {
  editedFile: [],
  baseFile: [],
  commit: ['HEAD'],
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
// Multi-file list registry
// =========================================================================

interface MultiFileList {
  /** This list's key inside `MultiFiles`. */
  readonly key: keyof MultiFiles;
  /** Command the host pushes to replace the whole list. */
  readonly setCommand: string;
}

/**
 * Everything that varies per multi-file list, one row per
 * `MultipleDocumentFileType`. The `MultiFiles` key and the inbound `SET_*`
 * command are one relation, so they are written once here and looked up
 * through the derived maps below rather than through parallel tables or
 * `${type}Files` string surgery.
 */
export const MULTI_FILE_LISTS = {
  input: {
    key: 'inputFiles',
    setCommand: MAIN_VIEW_COMMANDS.SET_INPUT_FILES,
  },
  context: {
    key: 'contextFiles',
    setCommand: MAIN_VIEW_COMMANDS.SET_CONTEXT_FILES,
  },
  media: {
    key: 'mediaFiles',
    setCommand: MAIN_VIEW_COMMANDS.SET_MEDIA_FILES,
  },
  output: {
    key: 'outputFiles',
    setCommand: MAIN_VIEW_COMMANDS.SET_OUTPUT_FILES,
  },
} as const satisfies Record<MultipleDocumentFileType, MultiFileList>;

const MULTI_FILE_LIST_ENTRIES = Object.entries(MULTI_FILE_LISTS) as Array<
  [MultipleDocumentFileType, MultiFileList]
>;

/** {@link MULTI_FILE_LISTS} keyed by `MultiFiles` key. */
export const MULTI_FILE_LIST_BY_KEY = Object.fromEntries(
  MULTI_FILE_LIST_ENTRIES.map(([fileType, list]) => [
    list.key,
    { fileType, ...list },
  ]),
) as Record<
  keyof MultiFiles,
  MultiFileList & { fileType: MultipleDocumentFileType }
>;

/** {@link MULTI_FILE_LISTS} keyed by the inbound `SET_*_FILES` command. */
export const MULTI_FILE_LIST_BY_SET_COMMAND = Object.fromEntries(
  MULTI_FILE_LIST_ENTRIES.map(([, list]) => [list.setCommand, list]),
) as Record<
  (typeof MULTI_FILE_LISTS)[MultipleDocumentFileType]['setCommand'],
  MultiFileList
>;

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
    toolConfig: 'tool',
  },
  {
    type: 'context',
    label: 'Context',
    icon: 'book',
    addOpenedLabel: 'Add opened files as context',
    emptyListLabel: 'Clear all context files',
    selectListLabel: 'Add context files',
  },
  {
    type: 'media',
    label: 'Media',
    icon: 'video',
    addOpenedLabel: 'Add opened files as media',
    emptyListLabel: 'Clear all media files',
    selectListLabel: 'Add media files',
    toolConfig: 'autoExtract',
  },
];
