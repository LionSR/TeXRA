import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';

import type { HandlerRegistry } from '../messageHandlerTypes';

// `HandlerRegistry` is now exhaustive (every ProgressView outbound command
// needs a real handler or `unsupported(...)` — see `@shared/utils/dispatcher`).
// This slice only owns a subset, so it's typed as a `satisfies Partial<...>`
// subset rather than the full registry; `messageDispatcher.ts` spreads all
// slices together and is the actual exhaustiveness checkpoint TypeScript
// enforces.
export const inquiryHandlers = {
  [PROGRESS_VIEW_COMMANDS.SYNC_INQUIRY_THREADS]: (data, ctx) => {
    ctx.setState((prev) =>
      create(prev, (draft) => {
        draft.inquiries.clear();
        for (const thread of data.threads) {
          if (thread.parentStreamId == null) continue;
          draft.inquiries.set(thread.threadId, thread);
        }
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_INQUIRY_THREAD]: (data, ctx) => {
    if (data.thread.parentStreamId == null) return;

    ctx.setState((prev) =>
      create(prev, (draft) => {
        draft.inquiries.set(data.thread.threadId, data.thread);
      }),
    );
  },
} satisfies Partial<HandlerRegistry>;
