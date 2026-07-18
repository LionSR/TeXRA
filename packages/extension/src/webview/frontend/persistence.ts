/**
 * Persistence machinery for the Main view.
 *
 * Owns the single `PersistedState` instance (backed by the shared
 * `webviewStorage` singleton) and both restore paths:
 *
 *   1. mount-time webview-storage restore (`restorePersistedState`), and
 *   2. backend-pushed history-rerun/reset restore (`handleRestoreState`).
 *
 * Both paths apply state through `applyState`, which owns output-file reset
 * and legacy-instruction precedence. Behavior is pinned by
 * `src/test-kernel/webview/MainAppPersistenceRestore.vitest.mts`.
 */

// Third-party imports
import { type ZodError } from 'zod';

// Local imports - shared state and schemas
import { hostBridge } from '@shared/hostBridge';
import {
  MainViewPersistedStateSchema,
  type MainViewPersistedState,
} from '@shared/schemas';
import type { MultiFiles } from '@shared/schemas';
import {
  createWebviewStorage,
  PersistedState,
} from '@shared/state/PersistedState';
import type { StateRestoreMessage } from '@shared/schemas/commonViewMessages';
import { createFlushableDebounce } from '@utils/core';

// Local imports - main view
import { MULTIPLE_DOCUMENT_FILE_TYPES, SESSION_TYPES } from './constants';
import { SESSION_DEFAULTS } from './sessionDefaults';
import { DEFAULT_MULTI_FILES, FILE_TYPE_TO_KEY } from './store';
import {
  checkboxValues$,
  commit$,
  fileSelectionOpen$,
  instruction$,
  latexdiffsVisible$,
  model$,
  multiFiles$,
  sessionType$,
  singleFiles$,
  toolUseAgent$,
  toolUseInstruction$,
  workflowAgent$,
  workflowInstruction$,
} from './mainViewState';

/**
 * Shared webview storage singleton for the main view.
 *
 * All modules in the main view frontend MUST use this shared instance rather
 * than calling `createWebviewStorage(hostBridge)` independently. Multiple
 * independent instances each maintain their own cache, so writes from one
 * instance can silently overwrite changes made by another.
 */
export const webviewStorage = createWebviewStorage(hostBridge);

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
  applyState(state);
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
    applyState(state);
  } finally {
    unblockSave();
  }
  saveState();
  return true;
}

/** Apply one parsed snapshot regardless of whether storage or the host sent it. */
function applyState(state: MainViewPersistedState): void {
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
  restoreFileArrays(state);
  latexdiffsVisible$.set(state.latexdiffsVisible);
  checkboxValues$.set({
    autoExtractFigure: state.autoExtractFigure,
    autoExtractTikzFigure: state.autoExtractTikzFigure,
    autoCompileInputPdf: state.autoCompileInputPdf,
    attachTeXCount: state.attachTeXCount,
  });
}

function restoreFileArrays(state: MainViewPersistedState): void {
  const next = MULTIPLE_DOCUMENT_FILE_TYPES.reduce<MultiFiles>(
    (acc, type) => {
      const key = FILE_TYPE_TO_KEY[type];
      const files =
        type === 'output' ? [] : state[key as keyof MainViewPersistedState];
      acc[key] = Array.isArray(files) ? files : [];
      return acc;
    },
    { ...DEFAULT_MULTI_FILES },
  );
  multiFiles$.set(next);
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
  }
  saveState();
}

const INSTRUCTION_SAVE_DEBOUNCE_MS = 300;

/** Debounces `saveState()` calls triggered by instruction keystrokes. */
const instructionSaveDebounce = createFlushableDebounce(
  saveState,
  INSTRUCTION_SAVE_DEBOUNCE_MS,
);

/** Debounce instruction keystrokes so each one doesn't hit storage. */
export function scheduleInstructionSave(): void {
  instructionSaveDebounce.schedule();
}

/** Flush a pending debounced instruction save (on disconnect). */
export function flushPendingInstructionSave(): void {
  instructionSaveDebounce.flush();
}

/**
 * Reset the transient runtime (save-block counter, pending debounce timer)
 * and reload the cached persisted state from storage. Called from `MainApp`'s
 * constructor on remount in the same JS context, matching the fresh-instance
 * slate the old per-instance fields provided.
 */
export function resetPersistenceRuntime(): void {
  saveBlockCount = 0;
  instructionSaveDebounce.cancel();
  stateManager.reload();
}
