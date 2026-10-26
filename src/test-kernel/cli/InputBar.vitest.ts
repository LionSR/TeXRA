import { it as effectIt } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
// Test composition imports
import '@test/support/defaultSessionTestSetup';

import stripAnsi from 'strip-ansi';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { ImagePasteQueue } from '@cli/chat/tui/input/imagePasteQueue';
import type { PastedImageEntry } from '@cli/chat/tui/input/draftAttachments';
import { InputBar } from '@cli/chat/tui/panes/InputBar';
import type { InputHistory } from '@cli/chat/tui/history/inputHistory';
import {
  shouldRedactSlashInput,
  installSlashCommands,
} from '@cli/chat/tui/commands/slashRegistry';
import {
  requestDraftRestore,
  resetCliState,
} from '@cli/chat/tui/state/cliState';
import { testRuntime } from '@test/support/testProcessRuntime';
import {
  loadInk,
  renderInteractive,
  type InkRenderHandles,
} from '@test/support/inkTestHarness.ts';
import {
  createDeferred,
  waitForCondition as waitFor,
} from '@test/support/asyncTestUtils';
import { bindTestSessionView } from './fixtures/sessionViewFixture';

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
  it('clamps at the oldest entry and restores the draft at the newest boundary', async () => {
    const { ink, React } = await loadInk();
    const history: InputHistory = {
      push: () => Effect.void,
      reverseFind: () => undefined,
      at: (index) => ['first command', 'second command'][index],
      length: () => 2,
    };
    const { instance, stdin, stdout } = renderInteractive(
      ink,
      React.createElement(InputBar, {
        runtime: testRuntime(),
        onSubmit: vi.fn(),
        history,
      }),
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
  beforeAll(bindTestSessionView);

  it('does not persist commands whose input may contain a credential', () => {
    installSlashCommands([
      {
        pluginId: 'test',
        commands: [
          {
            name: 'key',
            aliases: ['keys'],
            description: 'Add an API key',
            redactInput: true,
          },
          {
            name: 'model',
            description: 'Choose a model',
          },
        ],
      },
    ]);

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
      installSlashCommands([]);
    }
  });

  effectIt.live.each([
    ['submits the latest draft', ' [Image #1]'],
    ['keeps an image chip attached to the typed slash prefix', '[Image #1]'],
  ])('waits for pending image pastes and %s', ([, chipSuffix]) =>
    Effect.gen(function* () {
      const imagePasteQueue = new ImagePasteQueue();
      const paste = createDeferred();
      const submitted: string[] = [];
      let draft = '/h';

      const pasteFiber = yield* Effect.forkChild(
        Effect.promise(() => paste.promise).pipe(
          Effect.map(() => {
            draft = `/h${chipSuffix}`;
          }),
        ),
      );
      imagePasteQueue.add(pasteFiber, testRuntime());

      imagePasteQueue.runWhenIdle(() => {
        submitted.push(draft);
      });

      expect(submitted).toEqual([]);

      paste.resolve();
      yield* Fiber.await(pasteFiber);

      expect(submitted).toEqual([`/h${chipSuffix}`]);
    }),
  );
});

describe('InputBar draft discard', () => {
  effectIt.live(
    'invalidates an image paste that resolves after the draft is cleared',
    () =>
      Effect.gen(function* () {
        const imagePasteQueue = new ImagePasteQueue();
        const paste = createDeferred<string>();
        const inserted: string[] = [];

        imagePasteQueue.add(
          yield* Effect.forkChild(
            Effect.promise(() => paste.promise).pipe(
              Effect.map((chip) => inserted.push(chip)),
              Effect.asVoid,
            ),
          ),
          testRuntime(),
        );
        imagePasteQueue.discardPending();
        paste.resolve('[Image #1]');
        yield* Effect.promise(() => paste.promise);
        yield* Effect.promise(flushPromiseQueue);

        expect(inserted).toEqual([]);
      }),
  );

  effectIt.live(
    'cancels a deferred submit when its pending paste is discarded',
    () =>
      Effect.gen(function* () {
        const imagePasteQueue = new ImagePasteQueue();
        const paste = createDeferred();
        const submitted: string[] = [];

        imagePasteQueue.add(
          yield* Effect.forkChild(Effect.promise(() => paste.promise)),
          testRuntime(),
        );
        imagePasteQueue.deferUntilIdle(() => submitted.push('stale draft'));
        imagePasteQueue.discardPending();
        paste.resolve();
        yield* Effect.promise(() => paste.promise);
        yield* Effect.promise(flushPromiseQueue);

        expect(submitted).toEqual([]);
        expect(imagePasteQueue.hasPending).toBe(false);
        expect(imagePasteQueue.hasDeferredAction).toBe(false);
      }),
  );

  it('restores queued drafts with the image entries captured by each submission', async () => {
    clipboardMock.attachClipboardImage
      .mockReturnValueOnce(
        Effect.succeed({
          ok: true,
          path: '/tmp/first.png',
          mediaType: 'image/png',
          displayName: 'first.png',
        }),
      )
      .mockReturnValueOnce(
        Effect.succeed({
          ok: true,
          path: '/tmp/second.png',
          mediaType: 'image/png',
          displayName: 'second.png',
        }),
      );
    const submitted: Array<{
      readonly text: string;
      readonly mediaFiles: readonly string[] | undefined;
      readonly images: readonly PastedImageEntry[] | undefined;
    }> = [];
    const { ink, React } = await loadInk();
    const { instance, stdin, stdout } = renderInteractive(
      ink,
      React.createElement(InputBar, {
        runtime: testRuntime(),
        onSubmit: (...args: unknown[]) => {
          const [text, mediaFiles, images] = args as [
            string,
            readonly string[] | undefined,
            readonly PastedImageEntry[] | undefined,
          ];
          submitted.push({ text, mediaFiles, images });
        },
      }),
    );

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write('\u0016');
      await waitFor(() => stdout.output.includes('[Image #1]'));
      stdin.write(' first');
      stdin.write('\r');
      await waitFor(() => submitted.length === 1);
      await waitFor(
        () => !latestRenderedFrame(stdout).includes('[Image #1] first'),
      );
      stdout.output = '';

      stdin.write('\u0016');
      await waitFor(
        () => clipboardMock.attachClipboardImage.mock.calls.length === 2,
      );
      await waitFor(() => stdout.output.includes('[Image #1]'));
      stdin.write(' second');
      stdin.write('\r');
      await waitFor(() => submitted.length === 2);

      expect(submitted.slice(0, 2)).toMatchObject([
        {
          mediaFiles: ['/tmp/first.png'],
          images: [{ path: '/tmp/first.png', displayName: 'first.png' }],
        },
        {
          mediaFiles: ['/tmp/second.png'],
          images: [{ path: '/tmp/second.png', displayName: 'second.png' }],
        },
      ]);
      const [first, second] = submitted;
      if (!first?.images || !second?.images) {
        throw new Error('submitted image entries were not captured');
      }

      stdout.output = '';
      requestDraftRestore(first.text, first.images);
      requestDraftRestore(second.text, second.images);
      await waitFor(
        () =>
          stdout.output.includes('first') && stdout.output.includes('second'),
      );
      stdin.write('\r');
      await waitFor(() => submitted.length === 3);

      expect(submitted[2]?.text).toMatch(/first\n.*second/);
      expect(submitted[2]?.mediaFiles).toEqual([
        '/tmp/first.png',
        '/tmp/second.png',
      ]);

      stdout.output = '';
      requestDraftRestore(
        `[Image #999] unmatched [Image #${first.images[0]?.id}] valid [Image #${first.images[0]?.id}] duplicate`,
        first.images,
      );
      await waitFor(() => stdout.output.includes('duplicate'));
      stdin.write('\r');
      await waitFor(() => submitted.length === 4);

      expect(submitted[3]).toMatchObject({
        text: '[Image #999] unmatched [Image #1] valid [Image #1] duplicate',
        mediaFiles: ['/tmp/first.png'],
      });
    } finally {
      instance.unmount();
      resetCliState();
    }
  });
});
