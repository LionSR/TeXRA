// Third-party imports
import { beforeEach, describe, expect, it } from 'vitest';

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

type FollowUpInputInternals = HTMLElement & {
  visible: boolean;
  value: string;
  streamId: string;
  transientState: FollowUpInputTransientState | null;
  updateComplete: Promise<boolean>;
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
    clearFollowUpInputTransientStateStore();
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
});
