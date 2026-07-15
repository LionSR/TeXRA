import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ImagePasteQueue } from '@cli/chat/tui/input/imagePasteQueue';
import {
  InputBar,
  submitSlashCommandWhenReady,
  type InputBarHandle,
} from '@cli/chat/tui/panes/InputBar';

const clipboardMock = vi.hoisted(() => ({
  attachClipboardImage: vi.fn(),
}));

vi.mock('@cli/runtime/clipboardImage', () => clipboardMock);

const cliRequire = createRequire(
  new URL('../../../packages/cli/package.json', import.meta.url),
);

class FakeStdout extends EventEmitter {
  readonly isTTY = true;
  readonly columns = 80;
  readonly rows = 24;
  buf = '';

  write(chunk: string): boolean {
    this.buf += chunk;
    return true;
  }

  getColorDepth(): number {
    return 24;
  }
}

class FakeStdin extends EventEmitter {
  readonly isTTY = true;
  private readonly chunks: string[] = [];

  write(chunk: string): void {
    this.chunks.push(chunk);
    this.emit('readable');
  }

  read(): string | null {
    return this.chunks.shift() ?? null;
  }

  ref(): void {}
  unref(): void {}
  pause(): void {}
  resume(): void {}
  setEncoding(): void {}
  setRawMode(): void {}
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function deferredValue<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushPromiseQueue(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(() => clipboardMock.attachClipboardImage.mockReset());
afterEach(() => vi.clearAllMocks());

describe('InputBar slash submit', () => {
  it('waits for pending image pastes and submits the latest draft', async () => {
    const imagePasteQueue = new ImagePasteQueue();
    const paste = deferred();
    const submitted: string[] = [];
    let draft = '/h';

    imagePasteQueue.track(
      paste.promise.then(() => {
        draft = '/h [Image #1]';
      }),
    );

    submitSlashCommandWhenReady({
      commandName: 'help',
      handleSubmit: (value) => submitted.push(value),
      imagePasteQueue,
      readDraft: () => draft,
      remainder: '',
      typedName: 'h',
    });

    expect(submitted).toEqual([]);

    paste.resolve();
    await paste.promise;
    await flushPromiseQueue();

    expect(submitted).toEqual(['/help [Image #1]']);
  });

  it('keeps an image chip attached to the typed slash prefix', async () => {
    const imagePasteQueue = new ImagePasteQueue();
    const paste = deferred();
    const submitted: string[] = [];
    let draft = '/h';

    imagePasteQueue.track(
      paste.promise.then(() => {
        draft = '/h[Image #1]';
      }),
    );

    submitSlashCommandWhenReady({
      commandName: 'help',
      handleSubmit: (value) => submitted.push(value),
      imagePasteQueue,
      readDraft: () => draft,
      remainder: '',
      typedName: 'h',
    });

    paste.resolve();
    await paste.promise;
    await flushPromiseQueue();

    expect(submitted).toEqual(['/help [Image #1]']);
  });
});

describe('InputBar draft discard', () => {
  it('invalidates an image paste that resolves after the draft is cleared', async () => {
    const imagePasteQueue = new ImagePasteQueue();
    const attempt = imagePasteQueue.beginAttempt();
    const paste = deferredValue<string>();
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
    const paste = deferred();
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
    const ink = (await import(cliRequire.resolve('ink'))) as any;
    const React = ((await import(cliRequire.resolve('react'))) as any).default;
    const firstPaste = deferredValue<{
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
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const instance = ink.render(
      React.createElement(InputBar, {
        controlRef,
        onSubmit: (value: string, mediaFiles?: readonly string[]) =>
          submitted.push([value, mediaFiles]),
      }),
      {
        stdin,
        stdout,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
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
      expect(stdout.buf).not.toContain('[Image #1]');
      expect(stdout.buf).not.toContain('Image paste failed');

      stdout.buf = '';
      stdin.write('\u0016');
      await waitFor(() => stdout.buf.includes('[Image #1]'));
      expect(stdout.buf).not.toContain('[Image #2]');
      stdin.write('\r');
      await waitFor(() => submitted.length === 1);

      expect(submitted).toEqual([['[Image #1]', ['/tmp/current.png']]]);
    } finally {
      instance.unmount();
    }
  });
});
