import PQueue from 'p-queue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createChatSubmitDriver } from '@cli/chat/tui/chatSubmitDriver';
import type { PastedImageEntry } from '@cli/chat/tui/input/draftAttachments';
import { resetCliState } from '@cli/chat/tui/state/cliState';
import { TuiSession } from '@cli/chat/tui/state/sessionRunState';
import { createDeferred } from '@test/support/asyncTestUtils';

const mocks = vi.hoisted(() => ({
  handleTuiSlashCommand: vi.fn(),
  requestDraftRestore: vi.fn(),
  selectCliRunnableModel: vi.fn(),
  setCliHelperModel: vi.fn(),
}));

vi.mock('@cli/chat/tui/commands/handleSlashCommand', () => ({
  handleTuiSlashCommand: mocks.handleTuiSlashCommand,
}));

vi.mock('@cli/chat/tui/state/cliState', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/chat/tui/state/cliState')>();
  return { ...actual, requestDraftRestore: mocks.requestDraftRestore };
});

vi.mock('@cli/chat/tui/state/transcript', () => ({
  appendLocalAssistantTranscript: vi.fn(),
  appendLocalErrorTranscript: vi.fn(),
  appendLocalUserTranscript: vi.fn(),
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  setCliHelperModel: mocks.setCliHelperModel,
}));

vi.mock('@cli/runtime/modelAccess', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/runtime/modelAccess')>();
  return { ...actual, selectCliRunnableModel: mocks.selectCliRunnableModel };
});

function image(path: string): PastedImageEntry {
  return {
    id: 1,
    kind: 'image',
    path,
    mediaType: 'image/png',
    displayName: path.split('/').at(-1) ?? path,
  };
}

describe('chat submit driver draft restoration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCliState();
    mocks.handleTuiSlashCommand.mockResolvedValue(false);
    mocks.setCliHelperModel.mockResolvedValue(undefined);
  });

  it('restores each queued startup draft with its own image entries', async () => {
    const modelSelection = createDeferred<{ readonly model: string }>();
    mocks.selectCliRunnableModel.mockReturnValue(modelSelection.promise);
    const session = new TuiSession();
    const followUpQueue = new PQueue({ concurrency: 1 });
    const driver = createChatSubmitDriver({
      session,
      chatController: {
        admitInterruptedFollowUp: vi.fn(() => ({ kind: 'not_interrupted' })),
        startRootRun: vi.fn(),
      } as never,
      followUpQueue,
      runtimeSession: { events: { emit: vi.fn() } } as never,
      initialAgent: 'assistant',
      initialModel: 'test-model',
      initialModelSource: 'builtin-default',
      cwd: '/tmp/project',
      getSlashCommandContext: vi.fn(() => ({}) as never),
    });
    const firstImage = image('/tmp/first.png');
    const secondImage = image('/tmp/second.png');

    const startup = driver.handleSubmittedLine('root startup');
    await vi.waitFor(() =>
      expect(mocks.selectCliRunnableModel).toHaveBeenCalledOnce(),
    );
    await driver.handleSubmittedLine(
      '[Image #1] first follow-up',
      [firstImage.path],
      [firstImage],
    );
    await driver.handleSubmittedLine(
      '[Image #1] second follow-up',
      [secondImage.path],
      [secondImage],
    );

    modelSelection.reject(new Error('startup failed'));
    await startup;
    await followUpQueue.onIdle();

    expect(mocks.requestDraftRestore.mock.calls).toEqual([
      ['[Image #1] first follow-up', [firstImage]],
      ['[Image #1] second follow-up', [secondImage]],
    ]);
  });
});
