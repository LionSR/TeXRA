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
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

/**
 * Characterization tests for MainApp's persistence/restore machinery.
 *
 * These pin down the shared behavior of the two restore entry points:
 *   1. mount-time webview-storage restore (`restorePersistedState`), and
 *   2. backend-pushed history-rerun/reset restore (`handleRestoreState`),
 * including transient output-file reset and the single-writer rules in
 * `persistence.ts` (exactly one storage write per backend restore, no write
 * when nothing persisted changed).
 *
 * They observe only refactor-stable surfaces — the `@provide`/`@state` context
 * values, host-bridge storage writes, and posted messages — so they must pass
 * unchanged before AND after the slice-store migration.
 */

type PostedMessage = { command: string } & Record<string, unknown>;

const posted: PostedMessage[] = [];
const storageWrites: Array<Record<string, unknown>> = [];
let webviewState: Record<string, unknown>;

/** Persisted blob with stale output-file state that restore must discard. */
const PERSISTED_SEED = {
  sessionType: 'workflow',
  agent: { workflow: 'correct', toolUse: 'orchestrator' },
  model: 'seed-model',
  commit: 'HEAD',
  instruction: { workflow: 'persisted workflow instruction', toolUse: '' },
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

function seedWebviewState(
  state: Record<string, unknown> = PERSISTED_SEED,
): void {
  webviewState ??= {};
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

function mountMainApp(): Promise<MainApp> {
  return mountComponent<MainApp>('main-app');
}

/** Mount, then clear mount-time traffic so assertions see only test actions. */
async function mountFreshApp(): Promise<MainApp> {
  const element = await mountMainApp();
  posted.length = 0;
  storageWrites.length = 0;
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
    agent: { workflow: 'correct', toolUse: 'orchestrator' },
    model: 'restored-model',
    commit: 'abc1234',
    instruction: { workflow: '', toolUse: '' },
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

/** Push a backend restore blob and wait for the component to settle. */
async function pushRestore(
  element: MainApp,
  overrides: Parameters<typeof restoreState>[0] = {},
  extra: Record<string, unknown> = {},
): Promise<void> {
  dispatchHostMessage({
    command: COMMON_COMMANDS.STATE_RESTORE,
    state: restoreState(overrides),
    ...extra,
  });
  await element.updateComplete;
}

async function withFakeTimers(run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
}

describe('MainApp persistence and restore characterization', () => {
  useLitComponentTestDom(() => import('@webview/frontend/MainApp'));

  // Dynamically re-imported (module-cache hit) AFTER useLitComponentTestDom's
  // beforeAll has installed the DOM globals and imported MainApp — a static
  // top-level import here would evaluate persistence.ts's `webviewStorage`
  // singleton before the HOST_BRIDGE_API_KEY mock above is wired up.
  let persistence: typeof import('@webview/frontend/persistence');
  let setInstruction: typeof import('@webview/frontend/mainViewActions').setInstruction;
  let setBaseFile: typeof import('@webview/frontend/mainViewActions').setBaseFile;

  beforeAll(async () => {
    persistence = await import('@webview/frontend/persistence');
    ({ setBaseFile, setInstruction } =
      await import('@webview/frontend/mainViewActions'));
  });

  beforeEach(() => {
    seedWebviewState();
    posted.length = 0;
    storageWrites.length = 0;
  });

  it('normalizes stale workflow team state during mount-time restore', async () => {
    seedWebviewState({
      ...PERSISTED_SEED,
      launchTarget: 'team',
      selectedTeamId: 'physicist',
    });

    const element = await mountMainApp();

    expect(contextsOf(element).session).toMatchObject({
      sessionType: 'workflow',
      launchTarget: 'agent',
      selectedTeamId: 'physicist',
    });
  });

  it('restores persisted state on mount through the canonical state applicator', async () => {
    const element = await mountMainApp();
    const { fileState, session } = contextsOf(element);

    // Session/agent/model fields restored verbatim.
    expect(session.sessionType).toBe('workflow');
    expect(session.agent.workflow).toBe('correct');
    expect(session.agent.toolUse).toBe('orchestrator');
    expect(session.model).toBe('seed-model');

    expect(session.instruction).toBe('persisted workflow instruction');

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

    // A subsequent change persists the per-mode instructions and the
    // forced-empty output state (never the stale seed values).
    setBaseFile('other.tex');
    await element.updateComplete;
    const blob = lastPersistedBlob();
    expect(blob.instruction.workflow).toBe('persisted workflow instruction');
    expect(blob.instruction.toolUse).toBe('');
    expect(blob.outputFiles).toEqual([]);
    expect(blob).not.toHaveProperty('outputFilesActive');
    expect(blob.latexdiffsVisible).toBe(true);
    expect(blob.editedFile).toBe('main_polish.tex');
  });

  it('renders file controls without a redundant heading or disclosure', async () => {
    const element = await mountMainApp();

    dispatchHostMessage({
      command: MAIN_VIEW_COMMANDS.SET_ONBOARDING_FUNNEL,
      state: 'done',
    });
    await element.updateComplete;

    const root = element.shadowRoot;
    expect(root?.querySelector('.file-selection-heading')).toBeNull();
    expect(root?.querySelector('wa-details.file-selection-details')).toBeNull();
    expect(
      root?.querySelectorAll('.file-selection file-select-group'),
    ).toHaveLength(3);
  });

  it('normalizes stale workflow team state during backend restore', async () => {
    const element = await mountFreshApp();

    await pushRestore(element, {
      sessionType: 'workflow',
      launchTarget: 'team',
      selectedTeamId: 'physicist',
    });

    expect(contextsOf(element).session).toMatchObject({
      sessionType: 'workflow',
      launchTarget: 'agent',
      selectedTeamId: 'physicist',
    });
    expect(lastPersistedBlob()).toMatchObject({
      sessionType: 'workflow',
      launchTarget: 'agent',
      selectedTeamId: 'physicist',
    });
  });

  it('applies a backend-pushed restore with exactly one storage write and forced output reset', async () => {
    const element = await mountFreshApp();

    await pushRestore(element, {
      instruction: {
        workflow: 'restored workflow instruction',
        toolUse: 'restored tool-use instruction',
      },
    });

    // Single-writer characterization: the whole restore settles into one
    // projection, so it produces exactly one storage write — never one per
    // signal the applicator touches.
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
    expect(blob.instruction.workflow).toBe('restored workflow instruction');
    expect(blob.instruction.toolUse).toBe('restored tool-use instruction');

    const { fileState, session } = contextsOf(element);
    expect(session.sessionType).toBe('toolUse');
    expect(session.instruction).toBe('restored tool-use instruction');
    expect(fileState.multiFiles.outputFiles).toEqual([]);
    expect(fileState).not.toHaveProperty('outputFilesActive');
    expect(fileState.checkboxValues.autoExtractTikzFigure).toBe(true);

    // No execute unless explicitly requested.
    expect(
      posted.filter((m) => m.command === MAIN_VIEW_COMMANDS.EXECUTE),
    ).toHaveLength(0);
  });

  it('restores both per-mode instructions', async () => {
    const element = await mountFreshApp();

    await pushRestore(element, {
      sessionType: 'workflow',
      instruction: {
        workflow: 'workflow winner',
        toolUse: 'tool-use winner',
      },
    });

    const blob = lastPersistedBlob();
    expect(blob.instruction.workflow).toBe('workflow winner');
    expect(blob.instruction.toolUse).toBe('tool-use winner');
    expect(contextsOf(element).session.instruction).toBe('workflow winner');
  });

  it('executes immediately after a successful restore when requested', async () => {
    const element = await mountFreshApp();

    await pushRestore(
      element,
      { instruction: { workflow: '', toolUse: 'run this' } },
      { executeImmediately: true },
    );

    const executes = posted.filter(
      (m) => m.command === MAIN_VIEW_COMMANDS.EXECUTE,
    );
    expect(executes).toHaveLength(1);
    expect(executes[0].instruction).toBe('run this');
  });

  it('reset operation in workflow mode clears instructions and files and applies checkbox overrides', async () => {
    const element = await mountFreshApp();

    // Establish a workflow session with content to clear.
    await pushRestore(element, {
      sessionType: 'workflow',
      instruction: { workflow: 'about to be cleared', toolUse: '' },
      autoExtractFigure: true,
      autoExtractTikzFigure: true,
      autoCompileInputPdf: true,
      attachTeXCount: true,
    });
    storageWrites.length = 0;

    dispatchHostMessage({
      command: COMMON_COMMANDS.STATE_RESTORE,
      isResetOperation: true,
    });
    await element.updateComplete;

    expect(storageWrites).toHaveLength(1);
    const blob = lastPersistedBlob();
    expect(blob.instruction.workflow).toBe('');
    expect(blob.instruction.toolUse).toBe('');
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
    const element = await mountFreshApp();

    await pushRestore(element, {
      sessionType: 'toolUse',
      instruction: { workflow: '', toolUse: 'about to be cleared' },
      mediaFiles: ['kept-figure.png'],
      editedFile: 'kept_edited.tex',
    });
    storageWrites.length = 0;

    dispatchHostMessage({
      command: COMMON_COMMANDS.STATE_RESTORE,
      isResetOperation: true,
    });
    await element.updateComplete;

    expect(storageWrites).toHaveLength(1);
    const blob = lastPersistedBlob();
    expect(blob.instruction.workflow).toBe('');
    expect(blob.instruction.toolUse).toBe('');
    // Tool-use reset keeps file selections (SESSION_DEFAULTS.toolUse.resetFiles=false).
    expect(blob.mediaFiles).toEqual(['kept-figure.png']);
    expect(blob.editedFile).toBe('kept_edited.tex');

    const { fileState, session } = contextsOf(element);
    expect(session.instruction).toBe('');
    expect(fileState.multiFiles.mediaFiles).toEqual(['kept-figure.png']);
  });

  describe('single-writer rules', () => {
    it('writes nothing when a host push moves only non-persisted state', async () => {
      const element = await mountFreshApp();

      // The edited-file option list is presentation state; the selected file
      // (which IS persisted) still resolves, so the projection is unchanged.
      dispatchHostMessage({
        command: MAIN_VIEW_COMMANDS.SET_EDITED_FILE,
        files: ['main_polish.tex', 'other_polish.tex'],
      });
      await element.updateComplete;

      expect(storageWrites).toHaveLength(0);
      element.remove();
    });

    it('writes nothing when a restore reproduces the state already applied', async () => {
      const element = await mountMainApp();

      const state = restoreState({
        instruction: { workflow: '', toolUse: 'same' },
      });
      dispatchHostMessage({ command: COMMON_COMMANDS.STATE_RESTORE, state });
      await element.updateComplete;
      expect(storageWrites).toHaveLength(1);

      storageWrites.length = 0;
      dispatchHostMessage({ command: COMMON_COMMANDS.STATE_RESTORE, state });
      await element.updateComplete;

      expect(storageWrites).toHaveLength(0);
      element.remove();
    });

    it('coalesces rapid instruction keystrokes into a single storage write after 300ms', async () => {
      const element = await mountFreshApp();

      await withFakeTimers(async () => {
        setInstruction('h');
        await Promise.resolve();
        vi.advanceTimersByTime(200);
        // A second keystroke inside the window restarts the 300ms wait — a
        // naive one-shot timer (or a non-restarting batcher) would let the
        // first write land at the 300ms mark below instead of waiting for
        // this call's own full window.
        setInstruction('hello');
        await Promise.resolve();
        vi.advanceTimersByTime(299);
        expect(storageWrites).toHaveLength(0);

        vi.advanceTimersByTime(1);
        expect(storageWrites).toHaveLength(1);
        expect(lastPersistedBlob().instruction.workflow).toBe('hello');
      });

      element.remove();
    });

    it('writes a non-draft change immediately, carrying the pending draft with it', async () => {
      const element = await mountFreshApp();

      await withFakeTimers(async () => {
        setInstruction('typed but not yet due');
        await Promise.resolve();
        expect(storageWrites).toHaveLength(0);

        setBaseFile('other.tex');
        await Promise.resolve();

        expect(storageWrites).toHaveLength(1);
        expect(lastPersistedBlob().instruction.workflow).toBe(
          'typed but not yet due',
        );

        // The draft timer was cancelled by that write, not left to fire again.
        vi.advanceTimersByTime(1000);
        expect(storageWrites).toHaveLength(1);
      });

      element.remove();
    });

    it('flushPendingSave (called on disconnect) synchronously persists a pending draft', async () => {
      const element = await mountFreshApp();

      await withFakeTimers(async () => {
        setInstruction('unsaved when disconnected');
        await Promise.resolve();
        expect(storageWrites).toHaveLength(0);

        // disconnectedCallback -> flushPendingSave(): the pending draft must
        // be written synchronously, not dropped on teardown.
        element.remove();
        expect(storageWrites).toHaveLength(1);
        expect(lastPersistedBlob().instruction.workflow).toBe(
          'unsaved when disconnected',
        );

        // The flush must clear the timer — letting it "expire" afterward must
        // not produce a second write.
        vi.advanceTimersByTime(1000);
        expect(storageWrites).toHaveLength(1);
      });
    });

    it('resetPersistenceRuntime cancels a pending draft instead of flushing it', async () => {
      const element = await mountFreshApp();

      await withFakeTimers(async () => {
        setInstruction('discarded by reset, not persisted');
        await Promise.resolve();

        persistence.resetPersistenceRuntime();

        vi.advanceTimersByTime(1000);
        expect(storageWrites).toHaveLength(0);
      });

      element.remove();
    });
  });
});
