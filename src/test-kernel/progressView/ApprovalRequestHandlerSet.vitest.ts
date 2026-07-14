import { describe, expect, it, vi } from 'vitest';

import {
  createProgressBackendUiConfig,
  replayApprovalRequestHandlers,
  type ApprovalRequestHandlerSet,
} from '@controllers/progressView/backend/progressBackendUiConfig';
import type { WebviewUpdater } from '@controllers/progressView/backend/WebviewUpdater';

describe('ApprovalRequestHandlerSet helpers', () => {
  it('replays every pending prompt kind', async () => {
    const replayCalls = {
      toolEdit: vi.fn<() => void>(),
      bash: vi.fn<() => void>(),
      externalInquiry: vi.fn<() => void>(),
      retry: vi.fn<() => void>(),
      agentProposal: vi.fn<() => void>(),
      planApproval: vi.fn<() => void>(),
      userQuestion: vi.fn<() => void>(),
    } satisfies Record<
      keyof ApprovalRequestHandlerSet,
      ReturnType<typeof vi.fn>
    >;
    const handlers = Object.fromEntries(
      Object.entries(replayCalls).map(([key, replay]) => [key, { replay }]),
    ) as {
      [K in keyof typeof replayCalls]: { replay: (typeof replayCalls)[K] };
    };

    await replayApprovalRequestHandlers(handlers);

    for (const replay of Object.values(replayCalls)) {
      expect(replay).toHaveBeenCalledTimes(1);
    }
  });

  it('checks every pending prompt kind for hasPendingPermissions', () => {
    const hasPendingCalls = {
      toolEdit: vi.fn(() => false),
      bash: vi.fn(() => false),
      externalInquiry: vi.fn(() => false),
      retry: vi.fn(() => false),
      agentProposal: vi.fn(() => false),
      planApproval: vi.fn(() => false),
      userQuestion: vi.fn(() => false),
    } satisfies Record<
      keyof ApprovalRequestHandlerSet,
      ReturnType<typeof vi.fn>
    >;
    const handlers = Object.fromEntries(
      Object.entries(hasPendingCalls).map(([key, hasPendingForStream]) => [
        key,
        { hasPendingForStream },
      ]),
    ) as unknown as ApprovalRequestHandlerSet;

    const { hasPendingPermissions } = createProgressBackendUiConfig({
      handlers,
      webviewUpdater: {} as WebviewUpdater,
      canSend: () => true,
    });

    expect(hasPendingPermissions('stream-1')).toBe(false);

    for (const hasPendingForStream of Object.values(hasPendingCalls)) {
      expect(hasPendingForStream).toHaveBeenCalledWith('stream-1');
    }
  });
});
