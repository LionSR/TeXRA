// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registerCommand: vi.fn(),
  retrieveSessionResumeData: vi.fn(),
  resumeQueuedToolUseFromResumeData: vi.fn(async () => true),
  showWarningMessage: vi.fn(),
}));

vi.mock('vscode', () => ({
  commands: {
    registerCommand: mocks.registerCommand,
  },
  window: {
    showWarningMessage: mocks.showWarningMessage,
  },
}));
vi.mock('@agent/runtime/resumeQueuedToolUse', () => ({
  resumeQueuedToolUseFromResumeData: mocks.resumeQueuedToolUseFromResumeData,
}));
vi.mock('@agent/runtime/SessionResumeRetrieval', () => ({
  retrieveSessionResumeData: mocks.retrieveSessionResumeData,
}));

import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  registerResumeAgentCommand,
  resumeExtensionToolUseFromResumeData,
} from '@commands/agent/resumeCommand';
import type { StreamTabId } from '@shared/schemas';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';

const STREAM = 'stream:ext-resume' as StreamTabId;
const PARENT_STREAM = 'stream:ext-parent' as StreamTabId;

function snapshot() {
  return createToolUseResumeData({ streamId: STREAM });
}

function registerHandler() {
  mocks.registerCommand.mockReturnValue({ dispose: vi.fn() });
  registerResumeAgentCommand({ subscriptions: [] } as never);
  return mocks.registerCommand.mock.calls[0]?.[1];
}

beforeEach(() => {
  mocks.registerCommand.mockReset();
  mocks.retrieveSessionResumeData.mockReset();
  mocks.resumeQueuedToolUseFromResumeData.mockReset().mockResolvedValue(true);
  mocks.showWarningMessage.mockReset();
});

describe('resumeExtensionToolUseFromResumeData', () => {
  it('delegates to the shared leaf with the explicit follow-up', async () => {
    await expect(
      resumeExtensionToolUseFromResumeData(
        snapshot(),
        undefined,
        'typed alongside resume',
      ),
    ).resolves.toBe(true);

    expect(mocks.resumeQueuedToolUseFromResumeData).toHaveBeenCalledTimes(1);
    expect(mocks.resumeQueuedToolUseFromResumeData).toHaveBeenCalledWith(
      STREAM,
      snapshot(),
      expect.objectContaining({
        extraFollowUps: [{ text: 'typed alongside resume', origin: 'user' }],
      }),
    );
  });
});

describe('registerResumeAgentCommand', () => {
  it('stores the command disposable on the extension context', () => {
    const disposable = { dispose: vi.fn() };
    mocks.registerCommand.mockReturnValue(disposable);
    const context = { subscriptions: [] as unknown[] };

    registerResumeAgentCommand(
      context as Parameters<typeof registerResumeAgentCommand>[0],
    );

    expect(mocks.registerCommand).toHaveBeenCalledExactlyOnceWith(
      'texra.resumeAgent',
      expect.any(Function),
    );
    expect(context.subscriptions).toEqual([disposable]);
  });

  it('resolves a v2-shaped payload once across overlapping commands', async () => {
    const canonical = snapshot();
    const oldSnapshot = {
      version: 2,
      streamId: canonical.streamId,
      executionId: canonical.executionId,
      agentConfig: canonical.agentConfig,
      parentStreamId: PARENT_STREAM,
    };
    mocks.retrieveSessionResumeData.mockResolvedValue(canonical);
    // Model the guard semantically: a stream reads as resuming once a resume
    // has been dispatched for it, so the overlapping command loses the race
    // regardless of how many times the handler consults the status.
    let resumeDispatched = false;
    mocks.resumeQueuedToolUseFromResumeData.mockImplementation(async () => {
      resumeDispatched = true;
      return true;
    });
    const status = defaultSession().status;
    const statusSpy = vi
      .spyOn(status, 'isActiveOrResuming')
      .mockImplementation(() => resumeDispatched);
    const handler = registerHandler();

    await expect(
      Promise.all([
        handler({ snapshot: oldSnapshot, followUp: 'Continue.' }),
        handler({ snapshot: oldSnapshot, followUp: 'Continue.' }),
      ]),
    ).resolves.toEqual([{ success: true }, { success: false }]);

    expect(mocks.retrieveSessionResumeData).toHaveBeenCalledWith(
      canonical.streamId,
      canonical.executionId,
      canonical.agentConfig,
      { parentStreamId: PARENT_STREAM },
    );
    expect(mocks.resumeQueuedToolUseFromResumeData).toHaveBeenCalledOnce();
    expect(mocks.resumeQueuedToolUseFromResumeData).toHaveBeenCalledWith(
      canonical.streamId,
      canonical,
      expect.any(Object),
    );
    statusSpy.mockRestore();
  });

  it('reports retrieval failures through the existing resume warning', async () => {
    mocks.retrieveSessionResumeData.mockRejectedValue(
      new Error('storage unavailable'),
    );

    await expect(registerHandler()({ snapshot: snapshot() })).resolves.toEqual({
      success: false,
    });
    expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to resume tool-use session'),
    );
    expect(mocks.resumeQueuedToolUseFromResumeData).not.toHaveBeenCalled();
  });
});
