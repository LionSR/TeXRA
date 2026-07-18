// Third-party imports
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - shared constants and types
import { COMMON_COMMANDS, MAIN_VIEW_COMMANDS } from '@shared/ipc';
import { HOST_BRIDGE_API_KEY } from '@shared/hostBridgeTypes';
import type {
  FileStateContextValue,
  MainViewPersistedState,
  SessionContextValue,
} from '@shared/schemas';

// Local imports - component type (type-only: the module loads inside the DOM harness)
import type { MainApp } from '@webview/frontend/MainApp';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

/**
 * Characterization tests for MainApp's persistence/restore machinery.
 *
 * These pin down the shared behavior of the two restore entry points:
 *   1. mount-time webview-storage restore (`restorePersistedState`), and
 *   2. backend-pushed history-rerun/reset restore (`handleRestoreState`),
 * including legacy single-`instruction` migration, transient output-file
 * reset, Files-panel state, and the save-reentrancy guard (exactly one
 * storage write per backend restore).
 *
 * They observe only refactor-stable surfaces — the `@provide`/`@state` context
 * values, host-bridge storage writes, and posted messages — so they must pass
 * unchanged before AND after the slice-store migration.
 */

type PostedMessage = { command: string } & Record<string, unknown>;

const posted: PostedMessage[] = [];
const storageWrites: Array<Record<string, unknown>> = [];
let webviewState: Record<string, unknown>;

/**
 * Legacy persisted blob: predates the per-mode instruction fields (only the
 * single `instruction` field is present) and carries stale output-file state
 * that both restore entry points must discard.
 */
const LEGACY_SEED = {
  sessionType: 'workflow',
  workflowAgent: 'correct',
  toolUseAgent: 'orchestrator',
  model: 'seed-model',
  commit: 'HEAD',
  instruction: 'legacy single-field instruction',
  editedFile: 'main_polish.tex',
  baseFile: 'main.tex',
  inputFiles: ['main.tex', 'appendix.tex'],
  contextFiles: ['refs.bib'],
  mediaFiles: [],
  outputFiles: ['stale-output.tex'],
  outputFilesActive: true,
  latexdiffsVisible: true,
  autoExtractFigure: true,
  autoExtractTikzFigure: false,
  autoCompileInputPdf: true,
  attachTeXCount: true,
};

function seedWebviewState(state: Record<string, unknown> = LEGACY_SEED): void {
  if (!webviewState) {
    webviewState = { mainViewState: structuredClone(state) };
    return;
  }
  for (const key of Object.keys(webviewState)) {
    delete webviewState[key];
  }
  webviewState.mainViewState = structuredClone(state);
}

// Install the host-bridge stub at module scope, BEFORE the DOM harness imports
// the MainApp module — `hostBridge` resolves this global at module load.
seedWebviewState();
(globalThis as Record<string, unknown>)[HOST_BRIDGE_API_KEY] = {
  postMessage: (message: unknown) => {
    posted.push(message as PostedMessage);
  },
  getState: () => webviewState,
  setState: (state: unknown) => {
    webviewState = state as Record<string, unknown>;
    // The storage layer mutates and re-passes one cache object; deep-copy at
    // record time so each entry is a faithful snapshot of that write.
    storageWrites.push(structuredClone(webviewState));
  },
};

function contextsOf(element: MainApp): {
  fileState: FileStateContextValue;
  session: SessionContextValue;
} {
  const internal = element as unknown as {
    fileStateContextValue: FileStateContextValue;
    sessionContextValue: SessionContextValue;
  };
  return {
    fileState: internal.fileStateContextValue,
    session: internal.sessionContextValue,
  };
}

async function mountMainApp(): Promise<MainApp> {
  const element = document.createElement('main-app') as MainApp;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

function dispatchHostMessage(data: Record<string, unknown>): void {
  window.dispatchEvent(new window.MessageEvent('message', { data }));
}

function lastPersistedBlob(): MainViewPersistedState {
  const write = storageWrites.at(-1);
  expect(write, 'expected at least one storage write').toBeDefined();
  return write!.mainViewState as MainViewPersistedState;
}

/** Minimal valid full-shape restore blob; spread overrides per scenario. */
function restoreState(
  overrides: Partial<MainViewPersistedState> & Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sessionType: 'toolUse',
    workflowAgent: 'correct',
    toolUseAgent: 'orchestrator',
    model: 'restored-model',
    commit: 'abc1234',
    instruction: '',
    workflowInstruction: '',
    toolUseInstruction: '',
    editedFile: 'restored_edited.tex',
    baseFile: 'restored.tex',
    inputFiles: ['restored.tex'],
    contextFiles: ['restored.bib'],
    mediaFiles: ['figure.png'],
    outputFiles: ['restored-output.tex'],
    outputFilesActive: true,
    latexdiffsVisible: false,
    autoExtractFigure: false,
    autoExtractTikzFigure: true,
    autoCompileInputPdf: false,
    attachTeXCount: false,
    ...overrides,
  };
}

describe('MainApp persistence and restore characterization', () => {
  useLitComponentTestDom(() => import('@webview/frontend/MainApp'));

  // Dynamically re-imported (module-cache hit) AFTER useLitComponentTestDom's
  // beforeAll has installed the DOM globals and imported MainApp — a static
  // top-level import here would evaluate persistence.ts's `webviewStorage`
  // singleton before the HOST_BRIDGE_API_KEY mock above is wired up.
  let persistence: typeof import('@webview/frontend/persistence');
  let setInstruction: typeof import('@webview/frontend/mainViewActions').setInstruction;
  let fileSelectionOpen: typeof import('@webview/frontend/mainViewState').fileSelectionOpen$;

  beforeAll(async () => {
    persistence = await import('@webview/frontend/persistence');
    ({ setInstruction } = await import('@webview/frontend/mainViewActions'));
    ({ fileSelectionOpen$: fileSelectionOpen } =
      await import('@webview/frontend/mainViewState'));
  });

  beforeEach(() => {
    seedWebviewState();
    posted.length = 0;
    storageWrites.length = 0;
  });

  it('restores persisted state on mount through the canonical state applicator', async () => {
    const element = await mountMainApp();
    const { fileState, session } = contextsOf(element);

    // Session/agent/model fields restored verbatim.
    expect(session.sessionType).toBe('workflow');
    expect(session.workflowAgent).toBe('correct');
    expect(session.toolUseAgent).toBe('orchestrator');
    expect(session.model).toBe('seed-model');
    expect(fileSelectionOpen.get()).toBe(true);

    // Legacy migration: active mode was workflow, so the single legacy
    // `instruction` becomes the workflow instruction and stays active.
    expect(session.instruction).toBe('legacy single-field instruction');

    // File state restored — except output files, which are transient.
    expect(fileState.singleFiles).toEqual({
      editedFile: 'main_polish.tex',
      baseFile: 'main.tex',
    });
    expect(fileState.multiFiles).toEqual({
      inputFiles: ['main.tex', 'appendix.tex'],
      contextFiles: ['refs.bib'],
      mediaFiles: [],
      outputFiles: [],
    });
    expect(fileState).not.toHaveProperty('outputFilesActive');
    expect(fileState.checkboxValues).toEqual({
      autoExtractFigure: true,
      autoExtractTikzFigure: false,
      autoCompileInputPdf: true,
      attachTeXCount: true,
    });

    // Mount-time restore alone must not write back to storage.
    expect(storageWrites).toHaveLength(0);

    // A subsequent save persists the migrated per-mode instructions and the
    // forced-empty output state (never the stale seed values).
    dispatchHostMessage({
      command: MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED,
      filePath: 'other_polish.tex',
    });
    const blob = lastPersistedBlob();
    expect(blob.instruction).toBe('legacy single-field instruction');
    expect(blob.workflowInstruction).toBe('legacy single-field instruction');
    expect(blob.toolUseInstruction).toBe('');
    expect(blob.outputFiles).toEqual([]);
    expect(blob).not.toHaveProperty('outputFilesActive');
    expect(blob.latexdiffsVisible).toBe(true);
    expect(blob.editedFile).toBe('other_polish.tex');
  });

  it('applies a backend-pushed restore with exactly one storage write and forced output reset', async () => {
    const element = await mountMainApp();
    posted.length = 0;
    storageWrites.length = 0;

    dispatchHostMessage({
      command: COMMON_COMMANDS.STATE_RESTORE,
      state: restoreState({
        toolUseInstruction: 'restored tool-use instruction',
        workflowInstruction: 'restored workflow instruction',
      }),
    });
    await element.updateComplete;

    // Reentrancy guard characterization: the whole restore produces exactly
    // one storage write (the trailing save), never intermediate saves.
    expect(storageWrites).toHaveLength(1);

    const blob = lastPersistedBlob();
    expect(blob.sessionType).toBe('toolUse');
    expect(blob.model).toBe('restored-model');
    expect(blob.commit).toBe('abc1234');
    expect(blob.editedFile).toBe('restored_edited.tex');
    expect(blob.baseFile).toBe('restored.tex');
    expect(blob.inputFiles).toEqual(['restored.tex']);
    expect(blob.contextFiles).toEqual(['restored.bib']);
    expect(blob.mediaFiles).toEqual(['figure.png']);
    // Restored output files are dropped, not re-persisted.
    expect(blob.outputFiles).toEqual([]);
    expect(blob).not.toHaveProperty('outputFilesActive');
    expect(blob.instruction).toBe('restored tool-use instruction');
    expect(blob.workflowInstruction).toBe('restored workflow instruction');
    expect(blob.toolUseInstruction).toBe('restored tool-use instruction');

    const { fileState, session } = contextsOf(element);
    expect(session.sessionType).toBe('toolUse');
    expect(session.instruction).toBe('restored tool-use instruction');
    expect(fileSelectionOpen.get()).toBe(false);
    expect(fileState.multiFiles.outputFiles).toEqual([]);
    expect(fileState).not.toHaveProperty('outputFilesActive');
    expect(fileState.checkboxValues.autoExtractTikzFigure).toBe(true);

    // No execute unless explicitly requested.
    expect(
      posted.filter((m) => m.command === MAIN_VIEW_COMMANDS.EXECUTE),
    ).toHaveLength(0);
  });

  it('migrates the legacy instruction to the workflow slot when restoring a workflow session', async () => {
    const element = await mountMainApp();
    storageWrites.length = 0;

    dispatchHostMessage({
      command: COMMON_COMMANDS.STATE_RESTORE,
      state: restoreState({
        sessionType: 'workflow',
        instruction: 'legacy only',
        workflowInstruction: '',
        toolUseInstruction: '',
      }),
    });
    await element.updateComplete;

    const blob = lastPersistedBlob();
    expect(blob.workflowInstruction).toBe('legacy only');
    expect(blob.toolUseInstruction).toBe('');
    expect(blob.instruction).toBe('legacy only');
    expect(contextsOf(element).session.instruction).toBe('legacy only');
  });

  it('migrates the legacy instruction to the tool-use slot when restoring a tool-use session', async () => {
    const element = await mountMainApp();
    storageWrites.length = 0;

    dispatchHostMessage({
      command: COMMON_COMMANDS.STATE_RESTORE,
      state: restoreState({
        sessionType: 'toolUse',
        instruction: 'legacy only',
        workflowInstruction: '',
        toolUseInstruction: '',
      }),
    });
    await element.updateComplete;

    const blob = lastPersistedBlob();
    expect(blob.workflowInstruction).toBe('');
    expect(blob.toolUseInstruction).toBe('legacy only');
    expect(blob.instruction).toBe('legacy only');
    expect(contextsOf(element).session.instruction).toBe('legacy only');
  });

  it('prefers per-mode instructions over the legacy field when both are present', async () => {
    const element = await mountMainApp();
    storageWrites.length = 0;

    dispatchHostMessage({
      command: COMMON_COMMANDS.STATE_RESTORE,
      state: restoreState({
        sessionType: 'workflow',
        instruction: 'legacy loser',
        workflowInstruction: 'workflow winner',
        toolUseInstruction: 'tool-use winner',
      }),
    });
    await element.updateComplete;

    const blob = lastPersistedBlob();
    expect(blob.workflowInstruction).toBe('workflow winner');
    expect(blob.toolUseInstruction).toBe('tool-use winner');
    expect(blob.instruction).toBe('workflow winner');
    expect(contextsOf(element).session.instruction).toBe('workflow winner');
  });

  it('executes immediately after a successful restore when requested', async () => {
    const element = await mountMainApp();
    posted.length = 0;

    dispatchHostMessage({
      command: COMMON_COMMANDS.STATE_RESTORE,
      state: restoreState({ toolUseInstruction: 'run this' }),
      executeImmediately: true,
    });
    await element.updateComplete;

    const executes = posted.filter(
      (m) => m.command === MAIN_VIEW_COMMANDS.EXECUTE,
    );
    expect(executes).toHaveLength(1);
    expect(executes[0].instruction).toBe('run this');
  });

  it('reset operation in workflow mode clears instructions and files and applies checkbox overrides', async () => {
    const element = await mountMainApp();

    // Establish a workflow session with content to clear.
    dispatchHostMessage({
      command: COMMON_COMMANDS.STATE_RESTORE,
      state: restoreState({
        sessionType: 'workflow',
        workflowInstruction: 'about to be cleared',
        autoExtractFigure: true,
        autoExtractTikzFigure: true,
        autoCompileInputPdf: true,
        attachTeXCount: true,
      }),
    });
    await element.updateComplete;
    storageWrites.length = 0;

    dispatchHostMessage({
      command: COMMON_COMMANDS.STATE_RESTORE,
      isResetOperation: true,
    });
    await element.updateComplete;

    expect(storageWrites).toHaveLength(1);
    const blob = lastPersistedBlob();
    expect(blob.instruction).toBe('');
    expect(blob.workflowInstruction).toBe('');
    expect(blob.toolUseInstruction).toBe('');
    expect(blob.editedFile).toBe('');
    expect(blob.baseFile).toBe('');
    expect(blob.inputFiles).toEqual([]);
    expect(blob.contextFiles).toEqual([]);
    expect(blob.mediaFiles).toEqual([]);
    expect(blob.outputFiles).toEqual([]);
    expect(blob).not.toHaveProperty('outputFilesActive');
    // Workflow reset overrides the auto-extract/compile toggles but leaves
    // attachTeXCount as the user set it.
    expect(blob.autoExtractFigure).toBe(false);
    expect(blob.autoExtractTikzFigure).toBe(false);
    expect(blob.autoCompileInputPdf).toBe(false);
    expect(blob.attachTeXCount).toBe(true);

    const { fileState, session } = contextsOf(element);
    expect(session.instruction).toBe('');
    expect(fileState.singleFiles).toEqual({ editedFile: '', baseFile: '' });
    expect(fileState.multiFiles).toEqual({
      inputFiles: [],
      contextFiles: [],
      mediaFiles: [],
      outputFiles: [],
    });
  });

  it('reset operation in tool-use mode clears instructions but keeps file selections', async () => {
    const element = await mountMainApp();

    dispatchHostMessage({
      command: COMMON_COMMANDS.STATE_RESTORE,
      state: restoreState({
        sessionType: 'toolUse',
        toolUseInstruction: 'about to be cleared',
        mediaFiles: ['kept-figure.png'],
        editedFile: 'kept_edited.tex',
      }),
    });
    await element.updateComplete;
    storageWrites.length = 0;

    dispatchHostMessage({
      command: COMMON_COMMANDS.STATE_RESTORE,
      isResetOperation: true,
    });
    await element.updateComplete;

    expect(storageWrites).toHaveLength(1);
    const blob = lastPersistedBlob();
    expect(blob.instruction).toBe('');
    expect(blob.workflowInstruction).toBe('');
    expect(blob.toolUseInstruction).toBe('');
    // Tool-use reset keeps file selections (SESSION_DEFAULTS.toolUse.resetFiles=false).
    expect(blob.mediaFiles).toEqual(['kept-figure.png']);
    expect(blob.editedFile).toBe('kept_edited.tex');

    const { fileState, session } = contextsOf(element);
    expect(session.instruction).toBe('');
    expect(fileState.multiFiles.mediaFiles).toEqual(['kept-figure.png']);
  });

  describe('instruction-save debounce (createFlushableDebounce migration)', () => {
    it('coalesces rapid instruction keystrokes into a single storage write after 300ms', async () => {
      const element = await mountMainApp();
      storageWrites.length = 0;

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        setInstruction('h');
        persistence.scheduleInstructionSave();
        vi.advanceTimersByTime(200);
        // A second keystroke inside the window restarts the 300ms wait — a
        // naive one-shot timer (or a non-restarting batcher) would let the
        // first write land at the 300ms mark below instead of waiting for
        // this call's own full window.
        setInstruction('hello');
        persistence.scheduleInstructionSave();
        vi.advanceTimersByTime(299);
        expect(storageWrites).toHaveLength(0);

        vi.advanceTimersByTime(1);
        expect(storageWrites).toHaveLength(1);
        expect(lastPersistedBlob().instruction).toBe('hello');
      } finally {
        vi.useRealTimers();
      }

      element.remove();
    });

    it('flushPendingInstructionSave (called on disconnect) synchronously persists a pending debounced save', async () => {
      const element = await mountMainApp();
      storageWrites.length = 0;

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        setInstruction('unsaved when disconnected');
        persistence.scheduleInstructionSave();
        expect(storageWrites).toHaveLength(0);

        // disconnectedCallback -> flushPendingInstructionSave(): the pending
        // debounced save must run synchronously, not be dropped on teardown.
        element.remove();
        expect(storageWrites).toHaveLength(1);
        expect(lastPersistedBlob().instruction).toBe(
          'unsaved when disconnected',
        );

        // flush() must clear the timer — letting it "expire" afterward must
        // not produce a second write.
        vi.advanceTimersByTime(1000);
        expect(storageWrites).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('resetPersistenceRuntime cancels a pending debounced save instead of flushing it', async () => {
      const element = await mountMainApp();
      storageWrites.length = 0;

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        setInstruction('discarded by reset, not persisted');
        persistence.scheduleInstructionSave();

        persistence.resetPersistenceRuntime();

        vi.advanceTimersByTime(1000);
        expect(storageWrites).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }

      element.remove();
    });
  });
});
