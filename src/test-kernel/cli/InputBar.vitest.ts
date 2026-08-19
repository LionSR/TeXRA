// Test composition imports
import '@test/support/defaultSessionTestSetup';

import stripAnsi from 'strip-ansi';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ImagePasteQueue } from '@cli/chat/tui/input/imagePasteQueue';
import { BaseTextInput } from '@cli/chat/tui/input/BaseTextInput';
import {
  ActiveDraftScope,
  createActiveDraftRegistry,
} from '@cli/chat/tui/input/activeDraft';
import { triggerAppCtrlC } from '@cli/chat/tui/appInteractionPolicy';
import {
  InputBar,
  slashSubmitText,
  type InputBarHandle,
} from '@cli/chat/tui/panes/InputBar';
import { transcriptRowHeadline } from '@cli/chat/tui/panes/transcriptEntries';
import type { InputHistory } from '@cli/chat/tui/history/inputHistory';
import {
  registerSlashCommand,
  shouldRedactSlashInput,
  unregisterSlashCommand,
} from '@cli/chat/tui/commands/slashRegistry';
import {
  activeForm,
  resetCliState,
  streams,
} from '@cli/chat/tui/state/cliState';
import { CLI_LOCAL_STREAM_ID } from '@cli/chat/tui/state/transcript';
import {
  loadInk,
  renderInteractive,
  type InkRenderHandles,
} from '@test/support/inkTestHarness.ts';
import {
  createDeferred,
  waitForCondition as waitFor,
} from '@test/support/asyncTestUtils';

const clipboardMock = vi.hoisted(() => ({
  attachClipboardImage: vi.fn(),
}));

vi.mock('@cli/runtime/clipboardImage', () => clipboardMock);

async function flushPromiseQueue(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function latestRenderedFrame(stdout: InkRenderHandles['stdout']): string {
  return stripAnsi(stdout.writes.findLast((write) => write.length > 0) ?? '');
}

beforeEach(() => clipboardMock.attachClipboardImage.mockReset());
afterEach(() => vi.clearAllMocks());

describe('InputBar history arrow boundaries', () => {
  it('keeps idle arrows in the input when there is no history to walk', async () => {
    const { ink, React } = await loadInk();
    const { instance, stdin, stdout } = renderInteractive(
      ink,
      React.createElement(InputBar, { onSubmit: vi.fn() }),
      { debug: true },
    );

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write('draft');
      await waitFor(() => latestRenderedFrame(stdout).includes('draft'));
      stdin.write('\u001b[B');
      stdin.write('\u001b[A');
      await flushPromiseQueue();

      expect(latestRenderedFrame(stdout)).toContain('draft');
    } finally {
      instance.unmount();
    }
  });

  it('clamps at the oldest entry and restores the draft at the newest boundary', async () => {
    const { ink, React } = await loadInk();
    const history: InputHistory = {
      push: async () => undefined,
      reverseFind: () => undefined,
      at: (index) => ['first command', 'second command'][index],
      length: () => 2,
    };
    const { instance, stdin, stdout } = renderInteractive(
      ink,
      React.createElement(InputBar, { onSubmit: vi.fn(), history }),
      { debug: true },
    );

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write('draft');
      await waitFor(() => latestRenderedFrame(stdout).includes('draft'));
      stdin.write('\u001b[A');
      await waitFor(() =>
        latestRenderedFrame(stdout).includes('second command'),
      );
      stdin.write('\u001b[A');
      await waitFor(() =>
        latestRenderedFrame(stdout).includes('first command'),
      );
      stdin.write('\u001b[A');
      stdin.write('\u001b[A');
      await flushPromiseQueue();
      expect(latestRenderedFrame(stdout)).toContain('first command');
      expect(latestRenderedFrame(stdout)).not.toContain('second command');

      stdin.write('\u001b[B');
      await waitFor(() =>
        latestRenderedFrame(stdout).includes('second command'),
      );
      stdin.write('\u001b[B');
      await waitFor(() => latestRenderedFrame(stdout).includes('draft'));
      stdin.write('\u001b[B');
      await flushPromiseQueue();

      expect(latestRenderedFrame(stdout)).toContain('draft');
      expect(latestRenderedFrame(stdout)).not.toContain('second command');
    } finally {
      instance.unmount();
    }
  });
});

describe('InputBar slash submit', () => {
  it('threads deferred echo through a palette-opened form', async () => {
    const { ink, React } = await loadInk();
    registerSlashCommand({
      name: 'model',
      description: 'Choose a model',
      echo: 'ifPersists',
      formComponent: () => null,
    });
    const { instance, stdin, stdout } = renderInteractive(
      ink,
      React.createElement(InputBar, { onSubmit: vi.fn() }),
    );

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write('/model');
      await waitFor(() => stdout.output.includes('/model'));
      stdin.write('\r');
      await waitFor(() => activeForm.get()?.commandName === 'model');

      const form = activeForm.get()?.render(() => undefined, 20) as {
        props?: { onPersist?: () => void };
      };
      expect(streams.get().get(CLI_LOCAL_STREAM_ID)?.entries ?? []).toEqual([]);

      form.props?.onPersist?.();

      expect(
        streams
          .get()
          .get(CLI_LOCAL_STREAM_ID)
          ?.entries.map((row) => ({
            kind: row.kind,
            text: transcriptRowHeadline(row),
          })),
      ).toEqual([{ kind: 'user', text: '/model' }]);
    } finally {
      instance.unmount();
      unregisterSlashCommand('model');
      resetCliState();
    }
  });

  it('does not persist commands whose input may contain a credential', () => {
    registerSlashCommand({
      name: 'key',
      aliases: ['keys'],
      description: 'Add an API key',
      redactInput: true,
    });
    registerSlashCommand({
      name: 'model',
      description: 'Choose a model',
    });

    try {
      const cases: ReadonlyArray<readonly [string, boolean]> = [
        ['/key private-value', false],
        ['/keys private-value', false],
        ['/key=private-value', false],
        ['/key:private-value', false],
        ['/key/private-value', false],
        ['/keysk-private-value', false],
        ['/keyArbitraryCredentialValue', false],
        ['/ky private-value', false],
        ['/kye:sk-private-value', false],
        ['/apikey private-value', false],
        ['/unknown', true],
        ['/unknown private-value', false],
        ['/unknown=value', true],
        ['/tmp=backup', true],
        ['/keyboard shortcuts', false],
        ['/keynote.tex', true],
        ['/model openai', true],
        ['ordinary message', true],
      ];
      for (const [input, expected] of cases) {
        expect(!shouldRedactSlashInput(input)).toBe(expected);
      }
    } finally {
      unregisterSlashCommand('key');
      unregisterSlashCommand('model');
    }
  });

  it.each([
    ['submits the latest draft', ' [Image #1]'],
    ['keeps an image chip attached to the typed slash prefix', '[Image #1]'],
  ])('waits for pending image pastes and %s', async (_caseName, chipSuffix) => {
    const imagePasteQueue = new ImagePasteQueue();
    const paste = createDeferred();
    const submitted: string[] = [];
    let draft = '/h';

    imagePasteQueue.track(
      paste.promise.then(() => {
        draft = `/h${chipSuffix}`;
      }),
    );

    imagePasteQueue.runWhenIdle(() => {
      submitted.push(slashSubmitText(draft, 'help', '', 'h'));
    });

    expect(submitted).toEqual([]);

    paste.resolve();
    await paste.promise;
    await flushPromiseQueue();

    expect(submitted).toEqual(['/help [Image #1]']);
  });
});

describe('InputBar draft discard', () => {
  it('clears a mounted foreground text input before exiting', async () => {
    const { ink, React } = await loadInk();
    const registry = createActiveDraftRegistry();
    const onExit = vi.fn();
    let currentValue = 'dialog answer';

    function Harness() {
      const [value, setValue] = React.useState(currentValue);
      ink.useInput((input: string, key: { readonly ctrl?: boolean }) => {
        if (key.ctrl && input === 'c') {
          triggerAppCtrlC({
            discardDraft: registry.discard,
            canStopActiveRun: () => false,
            onInterruptActive: vi.fn(),
            onExit,
          });
        }
      });
      return React.createElement(
        ActiveDraftScope,
        { active: true, registry },
        React.createElement(BaseTextInput, {
          value,
          onChange: (next: string) => {
            currentValue = next;
            setValue(next);
          },
          onSubmit: () => undefined,
        }),
      );
    }

    const { instance, stdin } = renderInteractive(
      ink,
      React.createElement(Harness),
    );

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write('\u0003');
      await waitFor(() => currentValue === '');

      expect(onExit).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('invalidates an image paste that resolves after the draft is cleared', async () => {
    const imagePasteQueue = new ImagePasteQueue();
    const attempt = imagePasteQueue.beginAttempt();
    const paste = createDeferred<string>();
    const inserted: string[] = [];

    imagePasteQueue.track(
      paste.promise.then((chip) => {
        if (attempt.isCurrent()) inserted.push(chip);
      }),
    );
    imagePasteQueue.discardPending();
    paste.resolve('[Image #1]');
    await paste.promise;
    await flushPromiseQueue();

    expect(attempt.isCurrent()).toBe(false);
    expect(inserted).toEqual([]);
  });

  it('cancels a deferred submit when its pending paste is discarded', async () => {
    const imagePasteQueue = new ImagePasteQueue();
    const paste = createDeferred();
    const submitted: string[] = [];

    imagePasteQueue.track(paste.promise);
    imagePasteQueue.deferUntilIdle(() => submitted.push('stale draft'));
    imagePasteQueue.discardPending();
    paste.resolve();
    await paste.promise;
    await flushPromiseQueue();

    expect(submitted).toEqual([]);
    expect(imagePasteQueue.hasPending).toBe(false);
    expect(imagePasteQueue.hasDeferredAction).toBe(false);
  });

  it('discards a pending image submit from an otherwise empty mounted input', async () => {
    const { ink, React } = await loadInk();
    const firstPaste = createDeferred<{
      readonly ok: true;
      readonly path: string;
      readonly mediaType: string;
      readonly displayName: string;
    }>();
    clipboardMock.attachClipboardImage
      .mockReturnValueOnce(firstPaste.promise)
      .mockResolvedValueOnce({
        ok: true,
        path: '/tmp/current.png',
        mediaType: 'image/png',
        displayName: 'current.png',
      });
    const submitted: Array<readonly [string, readonly string[] | undefined]> =
      [];
    const controlRef = React.createRef() as {
      current: InputBarHandle | null;
    };
    const { instance, stdin, stdout } = renderInteractive(
      ink,
      React.createElement(InputBar, {
        controlRef,
        onSubmit: (value: string, mediaFiles?: readonly string[]) =>
          submitted.push([value, mediaFiles]),
      }),
    );

    try {
      await waitFor(
        () =>
          controlRef.current !== null && stdin.listenerCount('readable') > 0,
      );
      stdin.write('\u0016');
      await waitFor(
        () => clipboardMock.attachClipboardImage.mock.calls.length === 1,
      );
      stdin.write('\r');

      expect(controlRef.current?.discardDraft()).toBe(true);
      firstPaste.resolve({
        ok: true,
        path: '/tmp/stale.png',
        mediaType: 'image/png',
        displayName: 'stale.png',
      });
      await flushPromiseQueue();

      expect(submitted).toEqual([]);
      expect(stdout.output).not.toContain('[Image #1]');
      expect(stdout.output).not.toContain('Image paste failed');

      stdout.output = '';
      stdin.write('\u0016');
      await waitFor(() => stdout.output.includes('[Image #1]'));
      expect(stdout.output).not.toContain('[Image #2]');
      stdin.write('\r');
      await waitFor(() => submitted.length === 1);

      expect(submitted).toEqual([['[Image #1]', ['/tmp/current.png']]]);
    } finally {
      instance.unmount();
    }
  });
});
