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
 * and per-mode instruction restore. Behavior is pinned by
 * `src/test-kernel/webview/MainAppPersistenceRestore.vitest.mts`.
 *
 * ## Single writer
 *
 * The persisted blob is a pure projection of the module-scope signals
 * (`persistedSnapshot$`), and this file is the only thing that writes it.
 * Nothing outside calls a "save" function: one watcher observes the projection
 * and writes when — and only when — it actually changes. That is why mutators
 * and message slices carry no persistence code at all, and why no reentrancy
 * guard is needed: a restore that sets a dozen signals produces one settled
 * projection and therefore one write.
 */

// Third-party imports
import { type ZodError } from 'zod';

// Local imports - shared state and schemas
import { hostBridge } from '@shared/hostBridge';
import {
  AGENT_CATEGORIES,
  byCategory,
  MainViewPersistedStateSchema,
  type ByCategory,
  type MainViewPersistedState,
  type StateRestoreMessage,
} from '@shared/schemas';
import { Signal } from '@shared/signals';
import {
  createWebviewStorage,
  PersistedState,
} from '@shared/state/PersistedState';
import { createFlushableDebounce } from '@utils/core';

// Local imports - main view
import { SESSION_TYPES } from './constants';
import { SESSION_DEFAULTS } from './sessionDefaults';
import {
  agent$,
  checkboxValues$,
  commit$,
  instructionDrafts$,
  latexdiffsVisible$,
  launchTarget$,
  model$,
  multiFiles$,
  selectedTeamId$,
  sessionType$,
  singleFiles$,
  workingDirectory$,
} from './mainViewState';

/**
 * Webview storage for the main view. Deliberately file-local: this module is
 * the only writer of main-view persisted state, so a second instance (each
 * carrying its own cache, able to overwrite the other's writes) has no reason
 * to exist.
 */
const webviewStorage = createWebviewStorage(hostBridge);

const stateManager = new PersistedState(
  webviewStorage,
  'mainViewState',
  MainViewPersistedStateSchema,
);

/**
 * The persisted blob, derived from the signals that own each field. Output
 * files are deliberately transient: they are recomputed per run, so the
 * projection always writes them empty.
 */
const persistedSnapshot$ = new Signal.Computed<MainViewPersistedState>(() => {
  const sf = singleFiles$.get();
  const mf = multiFiles$.get();
  const cv = checkboxValues$.get();

  return {
    sessionType: sessionType$.get(),
    launchTarget: launchTarget$.get(),
    selectedTeamId: selectedTeamId$.get(),
    workingDirectory: workingDirectory$.get(),
    agent: agent$.get(),
    model: model$.get(),
    commit: commit$.get(),
    instruction: instructionDrafts$.get(),
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
});

/**
 * The last projection handed to storage. Comparing against it is what turns
 * "a signal changed" into "the persisted blob changed": mutations that only
 * touch non-persisted signals, and restores that reproduce what is already
 * stored, write nothing.
 */
let lastWritten: MainViewPersistedState | undefined;

/** Fields a keystroke moves. Their writes are rate-limited; nothing else is. */
const DRAFT_FIELDS = new Set<keyof MainViewPersistedState>(['instruction']);

const DRAFT_SAVE_DEBOUNCE_MS = 300;

/**
 * Rate limiter for instruction typing: a keystroke changes only draft fields,
 * so its write waits out the burst instead of hitting storage per character.
 * Any other field change writes immediately and takes the pending drafts with
 * it, because the projection is whole-state.
 */
const draftSaveDebounce = createFlushableDebounce(
  () => writeIfChanged(),
  DRAFT_SAVE_DEBOUNCE_MS,
);

function fieldChanged(
  next: MainViewPersistedState,
  previous: MainViewPersistedState,
  field: keyof MainViewPersistedState,
): boolean {
  const a = next[field];
  const b = previous[field];
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length !== b.length || a.some((item, index) => item !== b[index]);
  }
  if (isByCategoryRecord(a) && isByCategoryRecord(b)) {
    return AGENT_CATEGORIES.some((category) => a[category] !== b[category]);
  }
  return a !== b;
}

/** Which persisted fields the current projection moves since the last write. */
function changedFields(
  next: MainViewPersistedState,
): Array<keyof MainViewPersistedState> {
  const fields = Object.keys(next) as Array<keyof MainViewPersistedState>;
  const previous = lastWritten;
  if (!previous) return fields;
  return fields.filter((field) => fieldChanged(next, previous, field));
}

function writeIfChanged(): void {
  const next = persistedSnapshot$.get();
  if (changedFields(next).length === 0) return;
  draftSaveDebounce.cancel();
  lastWritten = next;
  stateManager.setState(next);
}

/**
 * Watcher callback runs during signal invalidation, where reading a signal is
 * not allowed — so the projection is inspected on a microtask, which also
 * coalesces a burst of `.set()` calls from one handler into one write.
 */
const watcher = new Signal.subtle.Watcher(() => {
  queueMicrotask(() => {
    watcher.watch();
    if (lastWritten === undefined) return;
    const changed = changedFields(persistedSnapshot$.get());
    if (changed.length === 0) return;
    if (changed.every((field) => DRAFT_FIELDS.has(field))) {
      draftSaveDebounce.schedule();
      return;
    }
    writeIfChanged();
  });
});

export function restorePersistedState(): void {
  // The extension-local schema provides defaults and reads the retired VS Code
  // Copilot picker identity. No manual fallbacks are needed.
  const state = stateManager.getState();
  applyState(state);
  // Arm the writer on what the mount produced, not on what storage held: the
  // restore itself must not write back (a legacy blob is migrated in memory
  // and persisted by the user's next real change), and every later change is
  // measured against the state the user is actually looking at.
  lastWritten = persistedSnapshot$.get();
  watcher.watch(persistedSnapshot$);
}

/**
 * Apply a backend-pushed restore (history rerun or reset).
 *
 * Returns true only when a state snapshot was successfully applied — the
 * caller uses this to honor `executeImmediately` (a reset or a failed parse
 * must never trigger an execute).
 *
 * A host push is never per-character, so it writes out on the spot instead of
 * waiting out the draft rate limit — otherwise a reset that only clears the
 * instruction drafts would sit unwritten for the debounce window.
 */
export function handleRestoreState(
  message: StateRestoreMessage,
  onSchemaError: (context: string, error: ZodError) => void,
): boolean {
  if (message.isResetOperation === true) {
    clearForNewSession();
    flushPendingSave();
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
  applyState(parsed.data);
  flushPendingSave();
  return true;
}

/** Apply one parsed snapshot regardless of whether storage or the host sent it. */
function applyState(state: MainViewPersistedState): void {
  sessionType$.set(state.sessionType);
  launchTarget$.set(
    state.sessionType === SESSION_TYPES.WORKFLOW ? 'agent' : state.launchTarget,
  );
  selectedTeamId$.set(state.selectedTeamId);
  workingDirectory$.set(state.workingDirectory);
  agent$.set({ ...state.agent });
  model$.set(state.model);
  commit$.set(state.commit);
  instructionDrafts$.set({ ...state.instruction });
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
  latexdiffsVisible$.set(state.latexdiffsVisible);
  checkboxValues$.set({
    autoExtractFigure: state.autoExtractFigure,
    autoExtractTikzFigure: state.autoExtractTikzFigure,
    autoCompileInputPdf: state.autoCompileInputPdf,
    attachTeXCount: state.attachTeXCount,
  });
}

function clearForNewSession(): void {
  instructionDrafts$.set(byCategory(() => ''));
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
}

/**
 * Write anything the watcher has not flushed yet, synchronously. Called on
 * disconnect, where a queued microtask or a pending draft timer would
 * otherwise lose the user's last edit.
 */
export function flushPendingSave(): void {
  draftSaveDebounce.cancel();
  if (lastWritten === undefined) return;
  writeIfChanged();
}

/**
 * Disarm the writer, drop its pending work, and reload the cached persisted
 * state from storage. Called from `MainApp`'s constructor on remount in the
 * same JS context, matching the fresh-instance slate the old per-instance
 * fields provided; `restorePersistedState` re-arms on the next connect.
 */
export function resetPersistenceRuntime(): void {
  draftSaveDebounce.cancel();
  watcher.unwatch(persistedSnapshot$);
  lastWritten = undefined;
  stateManager.reload();
}

/** Category-keyed persisted fields (`agent`, `instruction`) for {@link fieldChanged}. */
function isByCategoryRecord(value: unknown): value is ByCategory<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    AGENT_CATEGORIES.every((category) => category in value)
  );
}
