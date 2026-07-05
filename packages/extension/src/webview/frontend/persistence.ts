/**
 * Persistence machinery for the Main view.
 *
 * Owns the single `PersistedState` instance (backed by the shared
 * `webviewStorage` singleton) and both restore paths:
 *
 *   1. mount-time webview-storage restore (`restorePersistedState`), and
 *   2. backend-pushed history-rerun/reset restore (`handleRestoreState`).
 *
 * Both paths force `outputFiles`/`outputFilesActive` back to empty/false and
 * share `restorePerModeInstructions`'s legacy-migration precedence. Behavior
 * is pinned by `src/test-kernel/webview/MainAppPersistenceRestore.vitest.mts`.
 */

// Third-party imports
import { type ZodError } from 'zod';

// Local imports - shared state and schemas
import { PersistedState } from '@shared/state';
import {
  MainViewPersistedStateSchema,
  type MainViewPersistedState,
} from '@shared/schemas';
import type { MultiFiles } from '@shared/schemas';
import type { StateRestoreMessage } from '@shared/schemas/commonViewMessages';

// Local imports - main view
import { MULTIPLE_DOCUMENT_FILE_TYPES, SESSION_TYPES } from './constants';
import { SESSION_DEFAULTS } from './sessionDefaults';
import {
  checkboxValues$,
  commit$,
  fileSelectionOpen$,
  instruction$,
  latexdiffsVisible$,
  model$,
  multiFiles$,
  outputFilesActive$,
  sessionType$,
  singleFiles$,
  toolUseAgent$,
  toolUseInstruction$,
  workflowAgent$,
  workflowInstruction$,
} from './mainViewState';
import { webviewStorage } from './webviewStorage';

const stateManager = new PersistedState(
  webviewStorage,
  'mainViewState',
  MainViewPersistedStateSchema,
);

/**
 * Reentrancy guard around `saveState()`: while a backend-pushed restore is
 * applying a snapshot, intermediate mutations must not write partially
 * restored state back to storage. Do NOT "simplify away" without a regression
 * test proving it safe — the characterization suite asserts
 * exactly one storage write per backend restore.
 */
let saveBlockCount = 0;
let instructionSaveTimer: number | null = null;

function blockSave(): void {
  saveBlockCount += 1;
}

function unblockSave(): void {
  if (saveBlockCount > 0) {
    saveBlockCount -= 1;
  }
}

export function saveState(): void {
  if (saveBlockCount > 0) {
    return;
  }

  const sf = singleFiles$.get();
  const mf = multiFiles$.get();
  const cv = checkboxValues$.get();

  const persisted: MainViewPersistedState = {
    sessionType: sessionType$.get(),
    workflowAgent: workflowAgent$.get(),
    toolUseAgent: toolUseAgent$.get(),
    model: model$.get(),
    commit: commit$.get(),
    instruction: instruction$.get(),
    workflowInstruction: workflowInstruction$.get(),
    toolUseInstruction: toolUseInstruction$.get(),
    editedFile: sf.editedFile,
    baseFile: sf.baseFile,
    inputFiles: mf.inputFiles,
    contextFiles: mf.contextFiles,
    mediaFiles: mf.mediaFiles,
    outputFiles: [],
    outputFilesActive: false,
    latexdiffsVisible: latexdiffsVisible$.get(),
    autoExtractFigure: cv.autoExtractFigure,
    autoExtractTikzFigure: cv.autoExtractTikzFigure,
    autoCompileInputPdf: cv.autoCompileInputPdf,
    attachTeXCount: cv.attachTeXCount,
  };

  stateManager.setState(persisted);
}

export function restorePersistedState(): void {
  // State is parsed through MainViewPersistedStateSchema which provides all defaults.
  // No manual fallbacks needed - schema handles missing/invalid values.
  const state = stateManager.getState();

  sessionType$.set(state.sessionType);
  fileSelectionOpen$.set(state.sessionType === SESSION_TYPES.WORKFLOW);
  workflowAgent$.set(state.workflowAgent);
  toolUseAgent$.set(state.toolUseAgent);
  model$.set(state.model);
  commit$.set(state.commit);

  restorePerModeInstructions(state);
  singleFiles$.set({
    editedFile: state.editedFile,
    baseFile: state.baseFile,
  });
  multiFiles$.set({
    inputFiles: state.inputFiles,
    contextFiles: state.contextFiles,
    mediaFiles: state.mediaFiles,
    outputFiles: [],
  });
  outputFilesActive$.set(false);
  latexdiffsVisible$.set(state.latexdiffsVisible);
  checkboxValues$.set({
    autoExtractFigure: state.autoExtractFigure,
    autoExtractTikzFigure: state.autoExtractTikzFigure,
    autoCompileInputPdf: state.autoCompileInputPdf,
    attachTeXCount: state.attachTeXCount,
  });
}

/**
 * Restore per-mode instructions from persisted state, migrating the legacy
 * single `instruction` field for users who haven't saved per-mode fields yet.
 */
function restorePerModeInstructions(state: MainViewPersistedState): void {
  const wf =
    state.workflowInstruction ||
    (state.sessionType === SESSION_TYPES.WORKFLOW ? state.instruction : '');
  const tu =
    state.toolUseInstruction ||
    (state.sessionType !== SESSION_TYPES.WORKFLOW ? state.instruction : '');
  workflowInstruction$.set(wf);
  toolUseInstruction$.set(tu);
  instruction$.set(state.sessionType === SESSION_TYPES.WORKFLOW ? wf : tu);
}

/**
 * Apply a backend-pushed restore (history rerun or reset).
 *
 * Returns true only when a state snapshot was successfully applied — the
 * caller uses this to honor `executeImmediately` (a reset or a failed parse
 * must never trigger an execute).
 */
export function handleRestoreState(
  message: StateRestoreMessage,
  onSchemaError: (context: string, error: ZodError) => void,
): boolean {
  if (message.isResetOperation === true) {
    clearForNewSession();
    return false;
  }
  if (!message.state) {
    return false;
  }

  const parsed = MainViewPersistedStateSchema.safeParse(message.state);
  if (!parsed.success) {
    onSchemaError('[MainApp] State restore validation failed.', parsed.error);
    return false;
  }
  const state = parsed.data;
  blockSave();
  try {
    sessionType$.set(state.sessionType);
    workflowAgent$.set(state.workflowAgent);
    toolUseAgent$.set(state.toolUseAgent);
    model$.set(state.model);
    commit$.set(state.commit);
    restorePerModeInstructions(state);
    singleFiles$.set({
      editedFile: state.editedFile,
      baseFile: state.baseFile,
    });

    checkboxValues$.set({
      autoExtractFigure: state.autoExtractFigure,
      autoExtractTikzFigure: state.autoExtractTikzFigure,
      autoCompileInputPdf: state.autoCompileInputPdf,
      attachTeXCount: state.attachTeXCount,
    });
    outputFilesActive$.set(false);
    latexdiffsVisible$.set(state.latexdiffsVisible);

    restoreFileArrays(state);
  } finally {
    unblockSave();
  }
  saveState();
  return true;
}

function restoreFileArrays(state: MainViewPersistedState): void {
  multiFiles$.set(
    Object.fromEntries(
      MULTIPLE_DOCUMENT_FILE_TYPES.map((type) => {
        const key = `${type}Files` as keyof MultiFiles;
        const files =
          type === 'output' ? [] : state[key as keyof MainViewPersistedState];
        return [key, Array.isArray(files) ? files : []];
      }),
    ) as MultiFiles,
  );
}

function clearForNewSession(): void {
  instruction$.set('');
  workflowInstruction$.set('');
  toolUseInstruction$.set('');
  const defaults = SESSION_DEFAULTS[sessionType$.get()];
  if (defaults.resetFiles) {
    singleFiles$.set({
      editedFile: '',
      baseFile: '',
    });
    multiFiles$.set({
      inputFiles: [],
      contextFiles: [],
      mediaFiles: [],
      outputFiles: [],
    });
    if (defaults.checkboxOverrides) {
      checkboxValues$.set({
        ...checkboxValues$.get(),
        ...defaults.checkboxOverrides,
      });
    }
    if (defaults.outputFilesActive !== undefined) {
      outputFilesActive$.set(false);
    }
  }
  saveState();
}

/** Debounce instruction keystrokes so each one doesn't hit storage. */
export function scheduleInstructionSave(): void {
  if (instructionSaveTimer) {
    window.clearTimeout(instructionSaveTimer);
  }
  instructionSaveTimer = window.setTimeout(() => {
    saveState();
    instructionSaveTimer = null;
  }, 300);
}

/** Flush a pending debounced instruction save (on disconnect). */
export function flushPendingInstructionSave(): void {
  if (instructionSaveTimer) {
    window.clearTimeout(instructionSaveTimer);
    instructionSaveTimer = null;
    saveState();
  }
}

/**
 * Reset the transient runtime (save-block counter, pending debounce timer)
 * and reload the cached persisted state from storage. Called from `MainApp`'s
 * constructor on remount in the same JS context, matching the fresh-instance
 * slate the old per-instance fields provided.
 */
export function resetPersistenceRuntime(): void {
  saveBlockCount = 0;
  if (instructionSaveTimer) {
    window.clearTimeout(instructionSaveTimer);
    instructionSaveTimer = null;
  }
  stateManager.reload();
}
