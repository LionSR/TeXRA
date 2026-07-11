// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - shared types
import type { ExtractedClipboardImage } from '@shared/utils/clipboardImages';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

/**
 * Regression coverage for the round-2 APoSD audit finding: the progress
 * view reuses a SINGLE `<follow-up-input>` Lit instance across the active
 * stream — `ToolUseStreamContent.render()` binds `.streamId=${streamInfo.name}`
 * (the same source TodoList/PlanView key off of for `collapseKey`) rather
 * than mounting a fresh instance per stream. Without a reset keyed on that
 * identity, an image pasted while viewing stream A and still un-sent when
 * the user switches to stream B rides along on the next send and is
 * delivered to stream B instead of stream A.
 */
useLitComponentTestDom(
  () => import('@progressView/frontend/components/FollowUpInput'),
);

type FollowUpInputInternals = HTMLElement & {
  visible: boolean;
  value: string;
  streamId: string;
  updateComplete: Promise<boolean>;
  pendingImages: ExtractedClipboardImage[];
  pendingImagePastes: Set<Promise<void>>;
  emitSend: () => void;
};

function createFollowUpInput(streamId: string): FollowUpInputInternals {
  const element = document.createElement(
    'follow-up-input',
  ) as unknown as FollowUpInputInternals;
  element.visible = true;
  element.streamId = streamId;
  document.body.append(element);
  return element;
}

function captureSentImages(
  element: FollowUpInputInternals,
): () => ExtractedClipboardImage[] | undefined {
  let sentImages: ExtractedClipboardImage[] | undefined;
  element.addEventListener('followup-send', (event) => {
    sentImages = (event as CustomEvent<{ images: ExtractedClipboardImage[] }>)
      .detail.images;
  });
  return () => sentImages;
}

describe('follow-up-input pasted-image state across stream switches', () => {
  it('drops a pending pasted image left over from the previously bound stream', async () => {
    const element = createFollowUpInput('stream-a');
    await element.updateComplete;

    // Stand in for a completed image paste while bound to stream A.
    // (attachPastedImages populates this after the async base64 read
    // resolves; this harness's jsdom has no FileReader/ClipboardEvent
    // wiring, so the post-paste state is set directly, matching what the
    // real paste handler leaves behind.)
    element.pendingImages = [
      {
        fileName: 'pasted-image-1.png',
        base64: 'AAAA',
        mediaType: 'image/png',
      },
    ];

    // The progress view rebinds this SAME instance to stream B instead of
    // mounting a fresh one.
    element.streamId = 'stream-b';
    await element.updateComplete;

    const getSentImages = captureSentImages(element);
    element.emitSend();

    expect(getSentImages()).toEqual([]);
  });

  it('drops a stale in-flight paste promise from the previous stream so send is not blocked', async () => {
    // Regression coverage for the codex/Copilot review finding on this PR:
    // emitSend() gates on pendingImagePastes.size > 0, so a paste promise
    // still in flight from the previously-bound stream must not survive a
    // streamId change — otherwise a send issued in the newly-bound stream
    // silently queues behind (and its timing/target depends on) an
    // unrelated old-stream paste completing.
    const element = createFollowUpInput('stream-a');
    await element.updateComplete;

    // Stand in for a paste whose async base64 read hasn't resolved yet
    // (attachPastedImages adds its own promise to this set in handlePaste,
    // before the read completes).
    element.pendingImagePastes.add(new Promise<void>(() => {}));

    element.streamId = 'stream-b';
    await element.updateComplete;

    const getSentImages = captureSentImages(element);
    element.emitSend();

    expect(getSentImages()).toEqual([]);
  });

  it('keeps a pending pasted image when the bound stream does not change', async () => {
    const element = createFollowUpInput('stream-a');
    await element.updateComplete;

    const image: ExtractedClipboardImage = {
      fileName: 'pasted-image-1.png',
      base64: 'AAAA',
      mediaType: 'image/png',
    };
    element.pendingImages = [image];

    // A re-render with the SAME streamId (e.g. more tokens streaming into
    // the still-active run) must not drop the pending image.
    element.value = 'follow-up text';
    await element.updateComplete;

    const getSentImages = captureSentImages(element);
    element.emitSend();

    expect(getSentImages()).toEqual([image]);
  });
});
