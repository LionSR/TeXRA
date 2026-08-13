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

vi.mock('@logger/logUtils', () => ({
  createLog: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { registerDiffRefresh, disposeDiffRefresh } =
  await import('@frontend/ui/diffView');

function uri(fsPath: string): vscode.Uri {
  return { fsPath } as unknown as vscode.Uri;
}

describe('diff refresh throttle', () => {
  beforeEach(() => {
    disposeDiffRefresh();
    mocks.executeCommand.mockClear();
  });

  it('refreshes a newly registered diff even inside the previous throttle window', () => {
    registerDiffRefresh(uri('a-left'), uri('a-right'), 'A');
    mocks.fireViewColumnChange?.();

    expect(mocks.executeCommand).toHaveBeenCalledTimes(1);

    // Registering a different diff immediately afterwards starts its own
    // window: the previous diff's timestamp must not swallow this refresh.
    registerDiffRefresh(uri('b-left'), uri('b-right'), 'B');
    mocks.fireViewColumnChange?.();

    expect(mocks.executeCommand).toHaveBeenCalledTimes(2);
    expect(mocks.executeCommand).toHaveBeenLastCalledWith(
      'vscode.diff',
      uri('b-left'),
      uri('b-right'),
      'B',
      { preserveFocus: true },
    );
  });

  it('still throttles repeated changes for the same diff', () => {
    registerDiffRefresh(uri('a-left'), uri('a-right'), 'A');
    mocks.fireViewColumnChange?.();
    mocks.fireViewColumnChange?.();

    expect(mocks.executeCommand).toHaveBeenCalledTimes(1);
  });
});
