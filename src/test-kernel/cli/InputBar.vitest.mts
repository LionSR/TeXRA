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
      fallbackRemainder: '',
      handleSubmit: (value) => submitted.push(value),
      imagePasteQueue,
      readDraft: () => draft,
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
      fallbackRemainder: '',
      handleSubmit: (value) => submitted.push(value),
      imagePasteQueue,
      readDraft: () => draft,
      typedName: 'h',
    });

    paste.resolve();
    await paste.promise;
    await flushPromiseQueue();

    expect(submitted).toEqual(['/help [Image #1]']);
  });
});
