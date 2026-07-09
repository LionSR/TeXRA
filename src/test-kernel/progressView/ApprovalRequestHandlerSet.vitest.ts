import { describe, expect, it, vi } from 'vitest';

import {
  replayApprovalRequestHandlers,
  type ApprovalRequestHandlerSet,
} from '@controllers/progressView/backend/progressBackendUiConfig';

describe('ApprovalRequestHandlerSet helpers', () => {
  it('replays every pending prompt kind', () => {
    const replayCalls = {
      toolEdit: vi.fn(),
      bash: vi.fn(),
      externalInquiry: vi.fn(),
      retry: vi.fn(),
      agentProposal: vi.fn(),
      planApproval: vi.fn(),
      userQuestion: vi.fn(),
    };
    const handlers = Object.fromEntries(
      Object.entries(replayCalls).map(([key, replay]) => [key, { replay }]),
    ) as unknown as ApprovalRequestHandlerSet;

    replayApprovalRequestHandlers(handlers);

    for (const replay of Object.values(replayCalls)) {
      expect(replay).toHaveBeenCalledTimes(1);
    }
  });
});
