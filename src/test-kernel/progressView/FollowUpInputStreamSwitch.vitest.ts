// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clipboardImageFiles: vi.fn(),
  generatePastedImageName: vi.fn(),
  readFileAsBase64: vi.fn(),
}));

vi.mock('@shared/files/pastedImageConstants', () => ({
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

// Local imports - progress view
import {
  clearFollowUpInputTransientStateStore,
  getFollowUpInputTransientState,
  type FollowUpInputTransientState,
} from '@progressView/frontend/followUpInputState';

// Local imports - shared types
import type { ExtractedClipboardImage } from '@shared/utils/clipboardImages';

// Local imports - test utilities
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

describe('follow-up-input pasted-image state across stream switches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFollowUpInputTransientStateStore();
    mocks.generatePastedImageName.mockReturnValue('pasted-test.png');
  });

  it('restores stream A images after an A -> B -> A round trip', async () => {
    const element = createFollowUpInput('stream-a');
    await element.updateComplete;

    const streamA = getFollowUpInputTransientState('stream-a');
    const streamB = getFollowUpInputTransientState('stream-b');
    const imageA = image('pasted-a.png');
    const imageB = image('pasted-b.png');
    streamA.pendingImages = [imageA];

    bindStream(element, 'stream-b');
    streamB.pendingImages = [imageB];
    await element.updateComplete;

    bindStream(element, 'stream-a');
    await element.updateComplete;

    const getSent = captureSend(element);
    element.emitSend();

    expect(getSent()).toEqual({ streamId: 'stream-a', images: [imageA] });
    expect(streamB.pendingImages).toEqual([imageB]);
  });

  it('finishes a deferred stream A send while stream B is active', async () => {
    const element = createFollowUpInput('stream-a');
    await element.updateComplete;

    const streamA = getFollowUpInputTransientState('stream-a');
    const imageA = image('pasted-a.png');
    const pendingPaste = new Promise<void>(() => {});
    streamA.pendingImages = [imageA];
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

    const streamA = getFollowUpInputTransientState('stream-a');
    const imageA = image('pasted-a.png');
    streamA.pendingImages = [imageA];

    element.value = 'follow-up text';
    await element.updateComplete;

    const getSent = captureSend(element);
    element.emitSend();

    expect(getSent()).toEqual({ streamId: 'stream-a', images: [imageA] });
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
