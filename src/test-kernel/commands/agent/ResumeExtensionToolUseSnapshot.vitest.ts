// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getToolUsePersistenceEnabled: vi.fn(() => true),
  registerCommand: vi.fn(),
  retrieveSessionResumeData: vi.fn(),
  resumeQueuedToolUseSnapshot: vi.fn(async () => true),
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
vi.mock('@utils/config', async (importActual) => ({
  ...(await importActual<typeof import('@utils/config')>()),
  getToolUsePersistenceEnabled: mocks.getToolUsePersistenceEnabled,
}));
vi.mock('@agent/runtime/resumeQueuedToolUse', () => ({
  resumeQueuedToolUseSnapshot: mocks.resumeQueuedToolUseSnapshot,
}));
vi.mock('@agent/runtime/SessionResumeRetrieval', () => ({
  retrieveSessionResumeData: mocks.retrieveSessionResumeData,
}));

import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import {
  registerResumeAgentCommand,
  resumeExtensionToolUseSnapshot,
} from '@commands/agent/resumeCommand';
import type { StreamTabId } from '@shared/schemas';

const STREAM = 'stream:ext-resume' as StreamTabId;

function snapshot() {
  return createToolUseResumeData({ streamId: STREAM });
}

function registerHandler() {
  mocks.registerCommand.mockReturnValue({ dispose: vi.fn() });
  registerResumeAgentCommand({ subscriptions: [] } as never);
  return mocks.registerCommand.mock.calls[0]?.[1];
}

beforeEach(() => {
  mocks.getToolUsePersistenceEnabled.mockReturnValue(true);
  mocks.registerCommand.mockReset();
  mocks.retrieveSessionResumeData.mockReset();
  mocks.resumeQueuedToolUseSnapshot.mockReset().mockResolvedValue(true);
  mocks.showWarningMessage.mockReset();
});

describe('resumeExtensionToolUseSnapshot', () => {
  it('refuses to resume when tool-use persistence is disabled', async () => {
    mocks.getToolUsePersistenceEnabled.mockReturnValue(false);

    await expect(resumeExtensionToolUseSnapshot(snapshot())).resolves.toBe(
      false,
    );
    expect(mocks.resumeQueuedToolUseSnapshot).not.toHaveBeenCalled();
  });

  it('delegates to the shared leaf with the explicit follow-up when enabled', async () => {
    await expect(
      resumeExtensionToolUseSnapshot(snapshot(), 'typed alongside resume'),
    ).resolves.toBe(true);

    expect(mocks.resumeQueuedToolUseSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.resumeQueuedToolUseSnapshot).toHaveBeenCalledWith(
      STREAM,
      snapshot(),
      expect.any(Object),
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

  it('resolves an existing v2-shaped command payload to canonical resume data', async () => {
    const canonical = snapshot();
    const oldSnapshot = {
      version: 2,
      streamId: canonical.streamId,
      executionId: canonical.executionId,
      agentConfig: canonical.agentConfig,
    };
    mocks.retrieveSessionResumeData.mockResolvedValue(canonical);

    await expect(
      registerHandler()({ snapshot: oldSnapshot, followUp: 'Continue.' }),
    ).resolves.toEqual({ success: true });

    expect(mocks.retrieveSessionResumeData).toHaveBeenCalledExactlyOnceWith(
      canonical.streamId,
      canonical.executionId,
      canonical.agentConfig,
    );
    expect(mocks.resumeQueuedToolUseSnapshot).toHaveBeenCalledWith(
      canonical.streamId,
      canonical,
      expect.any(Object),
      expect.objectContaining({
        extraFollowUps: [{ text: 'Continue.', origin: 'user' }],
      }),
    );
  });

  it('does not read resume storage when persistence is disabled', async () => {
    mocks.getToolUsePersistenceEnabled.mockReturnValue(false);

    await expect(registerHandler()({ snapshot: snapshot() })).resolves.toEqual({
      success: false,
    });
    expect(mocks.retrieveSessionResumeData).not.toHaveBeenCalled();
    expect(mocks.resumeQueuedToolUseSnapshot).not.toHaveBeenCalled();
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
    expect(mocks.resumeQueuedToolUseSnapshot).not.toHaveBeenCalled();
  });
});
