// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clipboardImageFiles: vi.fn(),
  generatePastedImageName: vi.fn(),
  readFileAsBase64: vi.fn(),
}));

vi.mock('@utils/files/pastedImageName', () => ({
  generatePastedImageName: mocks.generatePastedImageName,
}));

vi.mock('@shared/utils/clipboardImages', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@shared/utils/clipboardImages')>();
  return {
    ...actual,
    clipboardImageFiles: mocks.clipboardImageFiles,
    readFileAsBase64: mocks.readFileAsBase64,
  };
});

// Local imports
import {
  clearFollowUpInputTransientStateStore,
  getFollowUpInputTransientState,
  type FollowUpInputTransientState,
} from '@progressView/frontend/followUpInputState';
import type { ExtractedClipboardImage } from '@shared/utils/clipboardImages';

// Local file imports
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

useLitComponentTestDom(
  () => import('@progressView/frontend/components/FollowUpInput'),
);

interface FollowUpSendDetail {
  streamId: string;
  images: readonly ExtractedClipboardImage[];
}

interface FollowUpChangeDetail {
  streamId: string;
  value: string;
  mode: 'replace' | 'append';
}

type FollowUpInputInternals = HTMLElement & {
  visible: boolean;
  value: string;
  streamId: string;
  transientState: FollowUpInputTransientState | null;
  followUpEventSink: (event: CustomEvent) => void;
  updateComplete: Promise<boolean>;
  handlePaste: (event: ClipboardEvent) => void;
  emitSend: () => void;
  flushPendingImagePasteSend: (
    streamId: string,
    transientState: FollowUpInputTransientState,
  ) => void;
};

function bindStream(
  element: FollowUpInputInternals,
  streamId: string,
): FollowUpInputTransientState {
  const state = getFollowUpInputTransientState(streamId);
  element.streamId = streamId;
  element.transientState = state;
  return state;
}

function createFollowUpInput(streamId: string): FollowUpInputInternals {
  const element = document.createElement(
    'follow-up-input',
  ) as unknown as FollowUpInputInternals;
  element.visible = true;
  bindStream(element, streamId);
  document.body.append(element);
  return element;
}

function captureSend(
  element: FollowUpInputInternals,
): () => FollowUpSendDetail | undefined {
  let sent: FollowUpSendDetail | undefined;
  element.addEventListener('followup-send', (event) => {
    sent = (event as CustomEvent<FollowUpSendDetail>).detail;
  });
  return () => sent;
}

function image(fileName: string): ExtractedClipboardImage {
  return {
    fileName,
    base64: `base64-${fileName}`,
    mediaType: 'image/png',
  };
}

/** Give a stream one pending pasted image and hand the image back. */
function seedPendingImage(
  streamId: string,
  fileName: string,
): ExtractedClipboardImage {
  const pendingImage = image(fileName);
  getFollowUpInputTransientState(streamId).pendingImages = [pendingImage];
  return pendingImage;
}

/** Emit a send and assert it carried exactly these images for the stream. */
function expectSend(
  element: FollowUpInputInternals,
  streamId: string,
  images: readonly ExtractedClipboardImage[],
): void {
  const getSent = captureSend(element);
  element.emitSend();
  expect(getSent()).toEqual({ streamId, images });
}

describe('follow-up-input layout', () => {
  // The composer sizes from its own content rather than reserving a fixed
  // block for an empty draft, and keeps the manual drag affordance. Not Web
  // Awesome's "auto" mode: it holds an oversized row for an empty draft inside
  // a constrained composer, which is the failure the two-line floor avoids.
  it('rests at two rows and stays vertically resizable', async () => {
    const element = createFollowUpInput('stream-layout');
    await element.updateComplete;

    const textarea = element.shadowRoot?.querySelector('wa-textarea') as
      | (HTMLElement & {
          rows: number;
          resize: string;
          input: HTMLTextAreaElement;
          updateComplete: Promise<boolean>;
        })
      | null;
    await textarea?.updateComplete;

    expect(textarea?.rows).toBe(2);
    expect(textarea?.resize).toBe('vertical');
    expect(textarea?.input.rows).toBe(2);
  });
});

describe('follow-up-input pasted-image state across stream switches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFollowUpInputTransientStateStore();
    mocks.generatePastedImageName.mockReturnValue('pasted-test.png');
  });

  it('restores stream A images after an A -> B -> A round trip', async () => {
    const element = createFollowUpInput('stream-a');
    await element.updateComplete;

    const streamB = getFollowUpInputTransientState('stream-b');
    const imageA = seedPendingImage('stream-a', 'pasted-a.png');
    const imageB = image('pasted-b.png');

    bindStream(element, 'stream-b');
    streamB.pendingImages = [imageB];
    await element.updateComplete;

    bindStream(element, 'stream-a');
    await element.updateComplete;

    expectSend(element, 'stream-a', [imageA]);
    expect(streamB.pendingImages).toEqual([imageB]);
  });

  it('finishes a deferred stream A send while stream B is active', async () => {
    const element = createFollowUpInput('stream-a');
    await element.updateComplete;

    const streamA = getFollowUpInputTransientState('stream-a');
    const imageA = seedPendingImage('stream-a', 'pasted-a.png');
    const pendingPaste = new Promise<void>(() => {});
    streamA.pendingImagePastes.add(pendingPaste);

    const getSent = captureSend(element);
    element.emitSend();
    expect(getSent()).toBeUndefined();
    expect(streamA.sendAfterImagePastes).toBe(true);

    bindStream(element, 'stream-b');
    await element.updateComplete;

    // Mirrors handlePaste's finally block after stream A's file read settles.
    streamA.pendingImagePastes.delete(pendingPaste);
    element.flushPendingImagePasteSend('stream-a', streamA);

    expect(getSent()).toEqual({ streamId: 'stream-a', images: [imageA] });
  });

  it('keeps a pending image across a same-stream re-render', async () => {
    const element = createFollowUpInput('stream-a');
    await element.updateComplete;

    const imageA = seedPendingImage('stream-a', 'pasted-a.png');

    element.value = 'follow-up text';
    await element.updateComplete;

    expectSend(element, 'stream-a', [imageA]);
  });

  it('delivers a completed paste and deferred send after unmount', async () => {
    let resolveRead: (value: string) => void = () => {};
    mocks.readFileAsBase64.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveRead = resolve;
      }),
    );
    mocks.clipboardImageFiles.mockReturnValue([
      { file: {} as File, type: 'image/png' },
    ]);

    const element = createFollowUpInput('stream-a');
    await element.updateComplete;
    const streamA = getFollowUpInputTransientState('stream-a');
    const durableTarget = document.createElement('div');
    element.followUpEventSink = (event) => {
      durableTarget.dispatchEvent(event);
    };

    let changed: FollowUpChangeDetail | undefined;
    let sent: FollowUpSendDetail | undefined;
    durableTarget.addEventListener('followup-change', (event) => {
      changed = (event as CustomEvent<FollowUpChangeDetail>).detail;
    });
    durableTarget.addEventListener('followup-send', (event) => {
      sent = (event as CustomEvent<FollowUpSendDetail>).detail;
    });

    const pasteEvent = {
      clipboardData: { getData: () => '' },
      preventDefault: vi.fn(),
    } as unknown as ClipboardEvent;
    element.handlePaste(pasteEvent);
    const pendingPaste = [...streamA.pendingImagePastes][0];
    if (!pendingPaste) throw new Error('Expected an in-flight image paste');

    element.emitSend();
    element.remove();
    resolveRead('encoded-image');
    await pendingPaste;
    await Promise.resolve();

    expect(pasteEvent.preventDefault).toHaveBeenCalledOnce();
    expect(changed).toEqual({
      streamId: 'stream-a',
      value: '[pasted-test.png]',
      mode: 'append',
    });
    expect(sent).toEqual({
      streamId: 'stream-a',
      images: [
        {
          fileName: 'pasted-test.png',
          base64: 'encoded-image',
          mediaType: 'image/png',
        },
      ],
    });
    expect(streamA.pendingImages).toEqual([]);
  });
});
