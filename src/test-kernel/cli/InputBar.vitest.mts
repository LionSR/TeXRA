import { describe, expect, it } from 'vitest';

import { ImagePasteQueue } from '@cli/chat/tui/input/imagePasteQueue';
import { submitSlashCommandWhenReady } from '@cli/chat/tui/panes/InputBar';

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
});
