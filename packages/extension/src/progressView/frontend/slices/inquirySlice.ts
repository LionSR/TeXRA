import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { ProgressViewOutboundHandlerRegistry } from '@shared/schemas';

import { appState } from '../progressState';

// The composed registry is exhaustive (every ProgressView outbound command
// needs a real handler or `unsupported(...)` — see `@shared/utils/dispatcher`).
// This slice only owns a subset, so it's typed as a `satisfies Partial<...>`
// subset rather than the full registry; `messageDispatcher.ts` spreads all
// slices together and is the actual exhaustiveness checkpoint TypeScript
// enforces.
export const inquiryHandlers = {
  [PROGRESS_VIEW_COMMANDS.SYNC_INQUIRY_THREADS]: (data) => {
    appState.set(
      create(appState.get(), (draft) => {
        draft.inquiries.clear();
        for (const thread of data.threads) {
          if (thread.parentStreamId == null) continue;
          draft.inquiries.set(thread.threadId, thread);
        }
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_INQUIRY_THREAD]: (data) => {
    if (data.thread.parentStreamId == null) return;

    appState.set(
      create(appState.get(), (draft) => {
        draft.inquiries.set(data.thread.threadId, data.thread);
      }),
    );
  },
} satisfies Partial<ProgressViewOutboundHandlerRegistry>;
