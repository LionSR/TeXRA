import { describe, expect, it, vi } from 'vitest';

import { ConfirmCard } from '@cli/chat/tui/modals/ConfirmCard';
import { RetryRequest } from '@cli/chat/tui/modals/RetryRequest';
import type { StreamTabId } from '@shared/schemas';

describe('CLI retry request', () => {
  it('uses immediate rejection with a plain give-up action', () => {
    const card = RetryRequest({
      payload: {
        streamId: 'retry-stream' as StreamTabId,
        operation: 'Model invocation',
        errorMessage: 'Connection error',
      },
      onDecide: vi.fn(),
    });

    expect(card.type).toBe(ConfirmCard);
    expect(card.props).toMatchObject({
      approveLabel: 'retry',
      rejectLabel: 'give up',
      rejectionMode: 'immediate',
    });
  });
});
