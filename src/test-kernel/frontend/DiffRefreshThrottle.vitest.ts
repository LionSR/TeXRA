// Third-party imports
import { it } from '@effect/vitest';
import { Effect, FiberHandle } from 'effect';
import { TestClock } from 'effect/testing';
import { beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import { DIFF_REGISTRATION_DELAY_MS } from '@texra/shared/constants/latexTiming';

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

const { refreshDiffOnLayoutChange } = await import('@frontend/ui/diffView');

function uri(fsPath: string): vscode.Uri {
  return { fsPath } as unknown as vscode.Uri;
}

describe('diff refresh debounce', () => {
  beforeEach(() => {
    mocks.executeCommand.mockClear();
    mocks.fireViewColumnChange = null;
  });

  it.effect('refreshes once per burst, for the diff registered last', () =>
    Effect.gen(function* () {
      const refresh = yield* FiberHandle.make();
      yield* FiberHandle.run(
        refresh,
        refreshDiffOnLayoutChange(uri('a-left'), uri('a-right'), 'A'),
      );
      yield* TestClock.adjust(DIFF_REGISTRATION_DELAY_MS);
      // A column move fires several events within milliseconds: the burst
      // settles into one refresh, and none of its events is dropped on the
      // floor the way a leading-edge throttle dropped the trailing ones.
      mocks.fireViewColumnChange?.();
      mocks.fireViewColumnChange?.();
      yield* Effect.yieldNow;
      expect(mocks.executeCommand).not.toHaveBeenCalled();

      // A different diff registered inside the window takes the refresh over:
      // the one that fires shows B, and A is never shown.
      yield* FiberHandle.run(
        refresh,
        refreshDiffOnLayoutChange(uri('b-left'), uri('b-right'), 'B'),
      );
      yield* TestClock.adjust(DIFF_REGISTRATION_DELAY_MS);
      mocks.fireViewColumnChange?.();
      yield* TestClock.adjust('1 second');

      expect(mocks.executeCommand).toHaveBeenCalledTimes(1);
      expect(mocks.executeCommand).toHaveBeenLastCalledWith(
        'vscode.diff',
        uri('b-left'),
        uri('b-right'),
        'B',
        { preserveFocus: true },
      );
    }),
  );
});
