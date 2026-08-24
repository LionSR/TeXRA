// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  state: undefined as unknown,
  postMessage: vi.fn(),
  setState: vi.fn((state: unknown) => {
    host.state = state;
  }),
}));

vi.mock('@shared/hostBridge', () => ({
  hostBridge: {
    getState: () => host.state,
    setState: host.setState,
    postMessage: host.postMessage,
  },
  postMessage: (command: string, payload: Record<string, unknown> = {}) => {
    host.postMessage({ command, ...payload });
  },
}));

vi.mock('@progressView/frontend/components/ExternalInquiryPanel', () => ({
  clearInquiryDraft: vi.fn(),
}));

async function loadFreshFrontend() {
  vi.resetModules();
  const persistence =
    await import('@progressView/frontend/followUpDraftPersistence');
  const progressState = await import('@progressView/frontend/progressState');
  const lifecycle =
    await import('@progressView/frontend/slices/streamLifecycleSlice');
  const followUps = await import('@progressView/frontend/slices/followUpSlice');
  const events = await import('@progressView/frontend/eventHandlers');
  const transient = await import('@progressView/frontend/followUpInputState');
  const store = await import('@progressView/frontend/store');
  return {
    ...persistence,
    ...progressState,
    lifecycle: lifecycle.streamLifecycleHandlers,
    followUps: followUps.followUpHandlers,
    events,
    transient,
    store,
  };
}

async function syncStreams(
  frontend: Awaited<ReturnType<typeof loadFreshFrontend>>,
  streamIds: string[] = ['stream-a'],
) {
  const { AgentCategory, STREAM_PHASE, USER_FOLLOW_UP_SUPPORT } =
    await import('@shared/schemas');
  const { PROGRESS_VIEW_COMMANDS } = await import('@shared/ipc');
  frontend.lifecycle[PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS]({
    command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
    streams: streamIds.map((name, index) => ({
      name,
      label: name,
      agentCategory: AgentCategory.ToolUse,
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      creationTimestamp: index + 1,
    })),
    activeStream: streamIds[0] ?? '',
    streamStates: Object.fromEntries(
      streamIds.map((streamId) => [
        streamId,
        {
          category: AgentCategory.ToolUse,
          status: STREAM_PHASE.RUNNING,
          userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
          conversationProgress: { toolCallCount: 0 },
          subagents: [],
        },
      ]),
    ),
  });
}

function toolUseState(
  frontend: Awaited<ReturnType<typeof loadFreshFrontend>>,
  streamId = 'stream-a',
) {
  const state = frontend.appState.get().streamStates.get(streamId);
  if (!state || !frontend.store.isToolUseState(state)) {
    throw new Error('Expected tool-use stream state');
  }
  return state;
}

function image(base64: string, fileName = 'pasted_a.png') {
  return {
    fileName,
    mediaType: 'image/png',
    base64,
  };
}

function persistedEnvelope() {
  return (host.state as Record<string, unknown>)['followUpDrafts:v1'] as {
    version: 1;
    drafts: Record<string, unknown>;
  };
}

function storedDraft(text: string) {
  return {
    text,
    submission: null,
    attachments: [],
    updatedAt: 1,
  };
}

describe('persisted follow-up draft recovery', () => {
  beforeEach(() => {
    host.state = undefined;
    host.postMessage.mockReset();
    host.setState.mockClear();
  });

  it('restores sending until the host explicitly reports restored transport', async () => {
    const { PROGRESS_VIEW_COMMANDS } = await import('@shared/ipc');
    const first = await loadFreshFrontend();
    first.prepareFollowUpDraftRestore();
    await syncStreams(first);
    const originalImage = image('AAAA');
    first.transient.getFollowUpInputTransientState('stream-a').pendingImages = [
      originalImage,
    ];
    first.events.handleFollowUpChange({
      detail: { streamId: 'stream-a', value: 'draft [pasted_a.png]' },
    } as CustomEvent);
    first.events.handleFollowUpSend({
      detail: { streamId: 'stream-a', images: [originalImage] },
    } as CustomEvent);
    const originalDeliveryId =
      toolUseState(first).ui.followUpSubmission?.deliveryId;
    expect(originalDeliveryId).toBeTypeOf('string');

    const reloaded = await loadFreshFrontend();
    reloaded.prepareFollowUpDraftRestore();
    await syncStreams(reloaded);
    expect(toolUseState(reloaded).ui.followUpSubmission).toEqual(
      expect.objectContaining({
        status: 'sending',
        deliveryId: originalDeliveryId,
      }),
    );

    reloaded.followUps[PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TRANSPORT_RESTORED]();
    const restoredImages =
      reloaded.transient.getFollowUpInputTransientState(
        'stream-a',
      ).pendingImages;
    expect(toolUseState(reloaded).ui.followUpSubmission).toEqual(
      expect.objectContaining({
        status: 'failed',
        deliveryId: originalDeliveryId,
        error: 'Delivery status was not confirmed. Try again.',
      }),
    );
    expect(restoredImages).toEqual([originalImage]);

    reloaded.events.handleFollowUpSend({
      detail: { streamId: 'stream-a', images: restoredImages },
    } as CustomEvent);
    expect(host.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP,
        deliveryId: originalDeliveryId,
        images: [originalImage],
      }),
    );
  });

  it('keeps restore pending across incomplete stream metadata updates', async () => {
    const { USER_FOLLOW_UP_SUPPORT } = await import('@shared/schemas');
    const { PROGRESS_VIEW_COMMANDS } = await import('@shared/ipc');
    host.state = {
      'followUpDrafts:v1': {
        version: 1,
        drafts: { 'stream-a': storedDraft('restored draft') },
      },
    };
    const frontend = await loadFreshFrontend();
    frontend.prepareFollowUpDraftRestore();

    frontend.lifecycle[PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS]({
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
      streams: [
        {
          name: 'stream-a',
          label: 'stream-a',
          userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
          creationTimestamp: 1,
        },
      ],
      activeStream: 'stream-a',
      streamStates: {},
    });
    expect(frontend.appState.get().streamStates.has('stream-a')).toBe(false);

    await syncStreams(frontend);

    expect(toolUseState(frontend).ui.followUpText).toBe('restored draft');
  });

  it.each([
    [
      'record count',
      () =>
        Object.fromEntries(
          Array.from({ length: 21 }, (_, index) => [
            `stream-${index}`,
            storedDraft('draft'),
          ]),
        ),
    ],
    [
      'text length',
      () => ({
        'stream-a': storedDraft('A'.repeat(256 * 1024 + 1)),
      }),
    ],
    ['stream id length', () => ({ ['s'.repeat(257)]: storedDraft('draft') })],
    [
      'submission id length',
      () => ({
        'stream-a': {
          ...storedDraft('draft'),
          submission: {
            status: 'sending',
            deliveryId: 'd'.repeat(257),
            text: 'draft',
            attachmentFingerprints: [],
          },
        },
      }),
    ],
    [
      'submission error length',
      () => ({
        'stream-a': {
          ...storedDraft('draft'),
          submission: {
            status: 'failed',
            deliveryId: 'delivery',
            text: 'draft',
            attachmentFingerprints: [],
            error: 'E'.repeat(1025),
          },
        },
      }),
    ],
    [
      'attachment count',
      () => ({
        'stream-a': {
          ...storedDraft('draft'),
          attachments: Array.from({ length: 9 }, (_, index) => ({
            ...image('AAAA', `pasted_${index}.png`),
            fingerprint: 'fingerprint',
          })),
        },
      }),
    ],
    [
      'per-image base64 length',
      () => ({
        'stream-a': {
          ...storedDraft('draft'),
          attachments: [
            {
              ...image('A'.repeat(3 * 1024 * 1024 + 1)),
              fingerprint: 'fingerprint',
            },
          ],
        },
      }),
    ],
    [
      'attachment fingerprint length',
      () => ({
        'stream-a': {
          ...storedDraft('draft'),
          attachments: [
            {
              ...image('AAAA'),
              fingerprint: 'f'.repeat(129),
            },
          ],
        },
      }),
    ],
    [
      'attachment metadata',
      () => ({
        'stream-a': {
          ...storedDraft('draft'),
          attachments: [
            {
              ...image('AAAA', 'pasted_a.jpg'),
              fingerprint: 'fingerprint',
            },
          ],
        },
      }),
    ],
    [
      'aggregate size',
      () => ({
        'stream-a': {
          ...storedDraft('draft'),
          attachments: [
            {
              ...image('A'.repeat(2 * 1024 * 1024 + 4), 'pasted_a.png'),
              fingerprint: 'first',
            },
            {
              ...image('B'.repeat(2 * 1024 * 1024 + 4), 'pasted_b.png'),
              fingerprint: 'second',
            },
          ],
        },
      }),
    ],
  ])(
    'clears restored state that violates the %s limit',
    async (_name, buildDrafts) => {
      host.state = {
        'followUpDrafts:v1': { version: 1, drafts: buildDrafts() },
      };
      const frontend = await loadFreshFrontend();

      frontend.prepareFollowUpDraftRestore();

      expect(
        (host.state as Record<string, unknown>)['followUpDrafts:v1'],
      ).toBeUndefined();
    },
  );

  it('rejects a twenty-first stream without evicting the existing drafts', async () => {
    const existingIds = Array.from(
      { length: 20 },
      (_, index) => `stream-${index + 1}`,
    );
    host.state = {
      'followUpDrafts:v1': {
        version: 1,
        drafts: Object.fromEntries(
          existingIds.map((streamId) => [streamId, storedDraft(streamId)]),
        ),
      },
    };
    const frontend = await loadFreshFrontend();
    frontend.prepareFollowUpDraftRestore();
    await syncStreams(frontend, [...existingIds, 'stream-21']);
    frontend.events.handleFollowUpChange({
      detail: { streamId: 'stream-21', value: 'new draft' },
    } as CustomEvent);

    const result = frontend.persistFollowUpDraft('stream-21');

    expect(result).toEqual({
      persisted: false,
      error: 'Follow-up storage is full. Clear an older draft, then try again.',
    });
    expect(Object.keys(persistedEnvelope().drafts)).toEqual(existingIds);
  });

  it.each([
    {
      name: 'nine attachments',
      images: Array.from({ length: 9 }, (_, index) =>
        image('A', `pasted-${index}.png`),
      ),
      error: 'Attach no more than 8 images, then try again.',
    },
    {
      name: 'an attachment over 3 MiB',
      images: [image('A'.repeat(3 * 1024 * 1024 + 1))],
      error:
        'Each image must be 3 MiB or smaller. Remove the large image, then try again.',
    },
    {
      name: 'aggregate 4 MiB pressure',
      images: [
        image('A'.repeat(2 * 1024 * 1024 + 1), 'pasted_a.png'),
        image('B'.repeat(2 * 1024 * 1024 + 1), 'pasted_b.png'),
      ],
      error:
        'The follow-up is too large to preserve safely. Remove an image or shorten the message, then try again.',
    },
  ])(
    'keeps the last-known-good snapshot for $name',
    async ({ images, error }) => {
      const frontend = await loadFreshFrontend();
      frontend.prepareFollowUpDraftRestore();
      await syncStreams(frontend);
      frontend.events.handleFollowUpChange({
        detail: { streamId: 'stream-a', value: 'known good' },
      } as CustomEvent);
      const before = JSON.stringify(persistedEnvelope());
      frontend.transient.getFollowUpInputTransientState(
        'stream-a',
      ).pendingImages = images;

      const result = frontend.persistFollowUpDraft('stream-a');

      expect(result).toEqual({ persisted: false, error });
      expect(JSON.stringify(persistedEnvelope())).toBe(before);
    },
  );
});
