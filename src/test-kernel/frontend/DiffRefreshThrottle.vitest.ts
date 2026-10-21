// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Type imports
import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  fireViewColumnChange: null as (() => void) | null,
}));

vi.mock('vscode', () => ({
  commands: { executeCommand: mocks.executeCommand },
  window: {
    onDidChangeTextEditorViewColumn: (listener: () => void) => {
      mocks.fireViewColumnChange = listener;
      return { dispose: () => {} };
    },
  },
}));

const { registerDiffRefresh, disposeDiffRefresh } =
  await import('@frontend/ui/diffView');

function uri(fsPath: string): vscode.Uri {
  return { fsPath } as unknown as vscode.Uri;
}

describe('diff refresh debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    disposeDiffRefresh();
    mocks.executeCommand.mockClear();
  });

  it('refreshes once per burst, for the diff registered last', () => {
    registerDiffRefresh(uri('a-left'), uri('a-right'), 'A');
    // A column move fires several events within milliseconds: the burst
    // settles into one refresh, and none of its events is dropped on the
    // floor the way a leading-edge throttle dropped the trailing ones.
    mocks.fireViewColumnChange?.();
    mocks.fireViewColumnChange?.();
    expect(mocks.executeCommand).not.toHaveBeenCalled();

    // A different diff registered inside the window takes the refresh over:
    // the one that fires shows B, and A is never shown.
    registerDiffRefresh(uri('b-left'), uri('b-right'), 'B');
    mocks.fireViewColumnChange?.();
    vi.runAllTimers();

    expect(mocks.executeCommand).toHaveBeenCalledTimes(1);
    expect(mocks.executeCommand).toHaveBeenLastCalledWith(
      'vscode.diff',
      uri('b-left'),
      uri('b-right'),
      'B',
      { preserveFocus: true },
    );
  });
});
