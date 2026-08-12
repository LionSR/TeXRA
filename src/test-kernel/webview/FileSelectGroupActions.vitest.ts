// Third-party imports
import { beforeEach, describe, expect, it } from 'vitest';

// Local imports - shared constants and types
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import { HOST_BRIDGE_API_KEY } from '@shared/hostBridgeTypes';
import type { FileStateContextValue } from '@shared/schemas';

// Local imports - component type (type-only: the module loads inside the DOM harness)
import type { MainApp } from '@webview/frontend/MainApp';

// Local imports - test utilities
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

/**
 * Regression coverage for the <file-select-group> row actions.
 *
 * The list container delegates clicks for BOTH remove and reorder. lit rejects
 * duplicate attribute bindings, so binding @click twice on that container made
 * renderFileList() throw and the list render zero rows — silently killing
 * remove AND move together while looking like "no files selected". That shipped
 * undetected because nothing asserted the rows render or that the actions fire.
 *
 * These observe only refactor-stable surfaces: the rendered row count and the
 * resulting fileState context, not the internal handler wiring.
 */

let webviewState: Record<string, unknown>;

const SEED = {
  sessionType: 'workflow',
  agent: { workflow: 'correct', toolUse: 'orchestrator' },
  model: 'seed-model',
  commit: 'HEAD',
  instruction: { workflow: '', toolUse: '' },
  editedFile: '',
  baseFile: '',
  inputFiles: ['main.tex', 'appendix.tex'],
  contextFiles: [],
  mediaFiles: [],
  outputFiles: [],
  outputFilesActive: false,
  latexdiffsVisible: false,
  autoExtractFigure: false,
  autoExtractTikzFigure: false,
  autoCompileInputPdf: false,
  attachTeXCount: false,
};

// Mutate in place rather than reassigning: the persistence layer caches the
// state object by reference, so a fresh object would leave it holding the
// previous test's mutations.
function seedWebviewState(): void {
  webviewState ??= {};
  for (const key of Object.keys(webviewState)) {
    delete webviewState[key];
  }
  webviewState.mainViewState = structuredClone(SEED);
}

// Install the host-bridge stub at module scope, BEFORE the DOM harness imports
// the MainApp module — `hostBridge` resolves this global at module load.
seedWebviewState();
(globalThis as Record<string, unknown>)[HOST_BRIDGE_API_KEY] = {
  postMessage: () => {},
  getState: () => webviewState,
  setState: (state: unknown) => {
    webviewState = state as Record<string, unknown>;
  },
};

type LitElementLike = Element & { updateComplete: Promise<unknown> };

function fileStateOf(element: MainApp): FileStateContextValue {
  return (
    element as unknown as { fileStateContextValue: FileStateContextValue }
  ).fileStateContextValue;
}

// Looks up a row action control, failing loudly (with its purpose) when the
// row did not render it — the regression this suite guards against.
function queryControl(
  group: Element,
  selector: string,
  description: string,
): HTMLElement {
  const control = group.shadowRoot?.querySelector<HTMLElement>(selector);
  expect(control, `expected ${description}`).toBeTruthy();
  return control!;
}

describe('file-select-group row actions', () => {
  useLitComponentTestDom(() => import('@webview/frontend/MainApp'));

  beforeEach(() => {
    seedWebviewState();
  });

  async function mountWithFiles(): Promise<{
    element: MainApp;
    group: Element;
  }> {
    const element = await mountComponent<MainApp>('main-app');
    // The file-selection section only renders once onboarding is done.
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: {
          command: MAIN_VIEW_COMMANDS.SET_ONBOARDING_FUNNEL,
          state: 'done',
        },
      }),
    );
    await element.updateComplete;

    const group = element.shadowRoot?.querySelector(
      '.file-selection file-select-group',
    );
    expect(group, 'expected a <file-select-group>').toBeTruthy();
    await (group as LitElementLike).updateComplete;
    return { element, group: group! };
  }

  it('renders one row per selected file', async () => {
    const { group } = await mountWithFiles();

    // The duplicate-binding bug rendered 0 rows here.
    expect(group.shadowRoot!.querySelectorAll('.file-item')).toHaveLength(2);
  });

  it('removes the clicked file', async () => {
    const { element, group } = await mountWithFiles();

    queryControl(
      group,
      '[data-remove-file="main.tex"]',
      'a remove control for main.tex',
    ).click();
    await element.updateComplete;

    expect(fileStateOf(element).multiFiles.inputFiles).toEqual([
      'appendix.tex',
    ]);
  });

  it('reorders when a move control is clicked', async () => {
    const { element, group } = await mountWithFiles();

    queryControl(
      group,
      '[data-move-index="0"][data-move-direction="1"]',
      'a move-down control on the first row',
    ).click();
    await element.updateComplete;

    expect(fileStateOf(element).multiFiles.inputFiles).toEqual([
      'appendix.tex',
      'main.tex',
    ]);
  });
});
