import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The tool-use persistence gate is extension-only: the desktop never honored
 * `texra.toolUse.persistence.enabled`, so the shared {@link resumeToolUseSnapshot}
 * leaf stays ungated and the gate lives in this adapter. These tests pin that
 * the gate is applied here (not in the shared leaf) and that an enabled adapter
 * delegates straight through.
 */
const mocks = vi.hoisted(() => ({
  getToolUsePersistenceEnabled: vi.fn(() => true),
  resumeToolUseSnapshot: vi.fn(async () => true),
}));

vi.mock('@utils/config', async (importActual) => ({
  ...(await importActual<typeof import('@utils/config')>()),
  getToolUsePersistenceEnabled: mocks.getToolUsePersistenceEnabled,
}));
vi.mock('@agent/runtime/resumeToolUseSnapshot', () => ({
  resumeToolUseSnapshot: mocks.resumeToolUseSnapshot,
}));

import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import { resumeExtensionToolUseSnapshot } from '@commands/agent/resumeCommand';
import type { StreamTabId } from '@shared/schemas';

const STREAM = 'stream:ext-resume' as StreamTabId;

function snapshot(): ToolUseSessionSnapshot {
  return { streamId: STREAM } as ToolUseSessionSnapshot;
}

describe('resumeExtensionToolUseSnapshot', () => {
  beforeEach(() => {
    mocks.getToolUsePersistenceEnabled.mockReturnValue(true);
    mocks.resumeToolUseSnapshot.mockReset();
    mocks.resumeToolUseSnapshot.mockResolvedValue(true);
  });

  it('refuses to resume when tool-use persistence is disabled', async () => {
    mocks.getToolUsePersistenceEnabled.mockReturnValue(false);

    await expect(resumeExtensionToolUseSnapshot(snapshot())).resolves.toBe(
      false,
    );
    expect(mocks.resumeToolUseSnapshot).not.toHaveBeenCalled();
  });

  it('delegates to the shared leaf with the explicit follow-up when enabled', async () => {
    await expect(
      resumeExtensionToolUseSnapshot(snapshot(), 'typed alongside resume'),
    ).resolves.toBe(true);

    expect(mocks.resumeToolUseSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.resumeToolUseSnapshot).toHaveBeenCalledWith(
      snapshot(),
      expect.objectContaining({
        explicitFollowUp: 'typed alongside resume',
      }),
    );
  });
});
