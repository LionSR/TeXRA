import { describe, expect, it, vi } from 'vitest';

import {
  replayApprovalRequestHandlers,
  type ApprovalRequestHandlerSet,
} from '@controllers/progressView/backend/progressBackendUiConfig';

describe('ApprovalRequestHandlerSet helpers', () => {
  it('replays every pending prompt kind', () => {
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

    replayApprovalRequestHandlers(handlers);

    for (const replay of Object.values(replayCalls)) {
      expect(replay).toHaveBeenCalledTimes(1);
    }
  });
});
